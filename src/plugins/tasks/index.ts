import { createHash, randomUUID } from 'node:crypto';
import type { PluginDefinition } from '../../contracts/index.js';
import { manifest, number, required } from '../shared.js';

// 队列状态是正式数据；运行次数与时间预算避免单次CLI无限工作。
const QUEUE_KEY = 'queue';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
export interface TaskInput {
  type: string; entityId: string; inputVersion: string; processorVersion: string;
  payload: Record<string, unknown>; timeoutMs?: number; maxAttempts?: number; estimatedCalls?: number; estimatedCost?: number;
}
export interface Task extends TaskInput {
  id: string; key: string; status: 'pending' | 'running' | 'completed' | 'failed'; attempts: number;
  createdAt: string; updatedAt: string; checkpoint?: unknown; result?: unknown; error?: string;
  draining?: boolean;
}
export interface TaskExecution { signal: AbortSignal; checkpoint(value: unknown): Promise<void> }
export type TaskHandler = (task: Task, execution: TaskExecution) => Promise<unknown>;
/** prepare仅核对本地输入和预估预算，不得请求模型或提交业务结果。 */
export interface TaskPreparation { obsolete?: boolean; estimatedCalls?: number; estimatedCost?: number }
export interface TaskRegistration { prepare?(task: Task): Promise<TaskPreparation> }
export interface RunOptions { maxTasks?: number; maxDurationMs?: number; maxCalls?: number; maxCost?: number; now?: string }
export interface TaskRunResult { processed: number; completed: number; failed: number; calls: number; cost: number; stopped: string; unfinished: number; draining: number }
export interface TasksApi {
  enqueue(input: TaskInput): Promise<Task>; list(): Promise<Task[]>; register(type: string, handler: TaskHandler, options?: TaskRegistration): void;
  run(options?: RunOptions): Promise<TaskRunResult>; retry(id: string): Promise<Task>;
}

export const tasksPlugin: PluginDefinition = {
  manifest: manifest('tasks'),
  async load(context) {
    const handlers = new Map<string, TaskHandler>();
    const preparations = new Map<string, TaskRegistration['prepare']>();
    // 超时只终止本次等待；旧处理器未退出前隔离整批执行，禁止与重试重叠写入。
    const inFlight = new Map<string, Promise<unknown>>();
    let running = false;
    const queue = await context.store.read<Task[]>(QUEUE_KEY, []);
    async function save() { await context.store.write(QUEUE_KEY, queue); }
    const api: TasksApi = {
      register(type, handler, options) {
        if (handlers.has(type)) throw new Error(`TASK_HANDLER_CONFLICT: ${type}`);
        handlers.set(type, handler);
        if (options?.prepare) preparations.set(type, options.prepare);
      },
      async list() { return structuredClone(queue).map(task => ({ ...task, draining: inFlight.has(task.id) })); },
      async enqueue(input) {
        if (![input.type, input.entityId, input.inputVersion, input.processorVersion].every(value => typeof value === 'string' && value.trim()) || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('INVALID_TASK: type/entityId/inputVersion/processorVersion和payload必填');
        if (!Number.isSafeInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS) || (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0 || !Number.isSafeInteger(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) || (input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) < 1 || !Number.isSafeInteger(input.estimatedCalls ?? 0) || (input.estimatedCalls ?? 0) < 0 || !Number.isFinite(input.estimatedCost ?? 0) || (input.estimatedCost ?? 0) < 0) throw new Error('INVALID_TASK: 无效的超时、重试或预算');
        const key = createHash('sha256').update(JSON.stringify([input.type, input.entityId, input.inputVersion, input.processorVersion])).digest('hex');
        const existing = queue.find(task => task.key === key);
        if (existing) return structuredClone(existing);
        const at = new Date().toISOString();
        const task: Task = { ...input, id: randomUUID(), key, status: 'pending', attempts: 0, createdAt: at, updatedAt: at };
        queue.push(task);
        await save();
        return structuredClone(task);
      },
      async retry(id) {
        if (inFlight.size) throw new Error('TASK_DRAINING: 超时处理器尚未退出，不能重试');
        const task = queue.find(value => value.id === id);
        if (!task) throw new Error('NOT_FOUND: 任务不存在');
        if (task.status === 'running') throw new Error('TASK_RUNNING: 无法重置执行中任务');
        task.status = 'pending'; task.attempts = 0; delete task.error;
        await save(); return structuredClone(task);
      },
      /** 每一步先持久化状态；只在处理器成功且未超时后确认完成。 */
      async run(options = {}) {
        if (running) throw new Error('TASK_RUNNING: 已有任务批次执行中');
        const maxTasks = options.maxTasks ?? 20;
        const duration = options.maxDurationMs ?? 60_000;
        const maxCalls = options.maxCalls ?? 0;
        const maxCost = options.maxCost ?? 0;
        if (![maxTasks, duration, maxCalls].every(Number.isSafeInteger) || !Number.isFinite(maxCost) || maxTasks < 0 || duration <= 0 || maxCalls < 0 || maxCost < 0) throw new Error('INVALID_INPUT: 任务数、毫秒、调用数必须为整数，费用必须为有限非负数');
        running = true;
        const start = Date.now();
        const result: TaskRunResult = { processed: 0, completed: 0, failed: 0, calls: 0, cost: 0, stopped: 'queue-empty', unfinished: 0, draining: 0 };
        try {
          if (inFlight.size) { result.stopped = 'attempt-draining'; result.unfinished = queue.filter(task => task.status !== 'completed').length; result.draining = inFlight.size; return result; }
          // 只在执行命令时恢复中断状态，读取预览不会写入正式数据。
          const interrupted = queue.filter(task => task.status === 'running');
          for (const task of interrupted) { task.status = 'pending'; task.error = '进程中断，待恢复'; }
          if (interrupted.length) await save();
          for (const task of queue) {
            if (task.status === 'completed') continue;
            const exhausted = task.attempts >= (task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
            const prepare = preparations.get(task.type);
            if (exhausted && !prepare) continue;
            if (result.processed >= maxTasks) { result.stopped = 'task-budget'; break; }
            if (Date.now() - start >= duration) { result.stopped = 'time-budget'; break; }
            const handler = handlers.get(task.type);
            if (!handler) { result.stopped = 'handler-unavailable'; continue; }
            if (prepare) {
              try {
                const prepared = await prepare(structuredClone(task));
                if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || prepared.obsolete !== undefined && typeof prepared.obsolete !== 'boolean' || prepared.estimatedCalls !== undefined && (!Number.isSafeInteger(prepared.estimatedCalls) || prepared.estimatedCalls < 0) || prepared.estimatedCost !== undefined && (!Number.isFinite(prepared.estimatedCost) || prepared.estimatedCost < 0)) throw new Error('INVALID_TASK_PREPARATION');
                if (prepared.obsolete) {
                  task.status = 'completed'; task.result = { obsolete: true }; task.updatedAt = new Date().toISOString(); delete task.error;
                  result.processed++; result.completed++; await save(); continue;
                }
                if (prepared.estimatedCalls !== undefined) task.estimatedCalls = prepared.estimatedCalls;
                if (prepared.estimatedCost !== undefined) task.estimatedCost = prepared.estimatedCost;
              } catch (error) {
                if (exhausted) continue;
                task.status = 'failed'; task.attempts++; task.error = error instanceof Error ? error.message : String(error); task.updatedAt = new Date().toISOString();
                result.processed++; result.failed++; await save(); continue;
              }
            }
            if (exhausted) continue;
            if (Date.now() - start >= duration) { result.stopped = 'time-budget'; break; }
            // 预算不足的任务留待下批，后面的零费用任务仍可继续，避免队首阻塞。
            if (result.calls + (task.estimatedCalls ?? 0) > maxCalls || result.cost + (task.estimatedCost ?? 0) > maxCost) { result.stopped = 'model-budget'; continue; }
            task.status = 'running'; task.attempts++; task.updatedAt = new Date().toISOString(); delete task.error;
            await save();
            result.processed++; result.calls += task.estimatedCalls ?? 0; result.cost += task.estimatedCost ?? 0;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = Math.min(task.timeoutMs ?? DEFAULT_TIMEOUT_MS, Math.max(1, duration - (Date.now() - start)));
            try {
              const attempt = Promise.resolve().then(() => handler(structuredClone(task), { signal: controller.signal, async checkpoint(value) { controller.signal.throwIfAborted(); task.checkpoint = value; await save(); } }));
              inFlight.set(task.id, attempt);
              void attempt.then(() => inFlight.delete(task.id), () => inFlight.delete(task.id));
              task.result = await Promise.race([
                attempt,
                new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(new Error('TASK_TIMEOUT')); reject(new Error('TASK_TIMEOUT')); }, timeout); }),
              ]);
              controller.signal.throwIfAborted();
              task.status = 'completed'; result.completed++;
            } catch (error) {
              task.status = 'failed'; task.error = error instanceof Error ? error.message : String(error); result.failed++;
            } finally {
              if (timer) clearTimeout(timer);
              task.updatedAt = new Date().toISOString(); await save();
            }
            if (inFlight.size) { result.stopped = 'attempt-draining'; break; }
          }
          result.unfinished = queue.filter(task => task.status !== 'completed').length; result.draining = inFlight.size;
          return result;
        } finally { running = false; }
      },
    };
    context.registerCommand('task list', async () => api.list());
    context.registerCommand('task run', async ({ input }) => api.run({ maxTasks: number(input.maxTasks, 20), maxDurationMs: number(input.maxDurationMs, 60_000), maxCalls: number(input.maxCalls, 0), maxCost: number(input.maxCost, 0) }));
    context.registerCommand('task retry', async ({ input }) => api.retry(required(input, 'id')));
    return { api };
  },
};
export default tasksPlugin;
