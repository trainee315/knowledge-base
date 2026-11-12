import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Organization } from '../contracts/index.js';
import { assert, KnowledgeError } from '../core/errors.js';
import { CoreManager } from '../core/manager.js';
import { openApplication } from '../index.js';
import { previewJson } from '../preview/readonly.js';
import { handleTranscripts } from '../preview/transcripts.js';
import { enabledOf, LegacySchedules, ORGANIZER_JOB, transcriptKey } from '../plugins/cron/legacy.js';
import { object, scheduleOf } from '../plugins/cron/plan.js';
import { CronStore, type Job, type PlanConfig } from '../plugins/cron/store.js';
import { ORGANIZE, TRANSCRIBE, taskParams, taskType, taskTypes, type Dispatch } from '../plugins/cron/tasks.js';
import { DEFAULT_CONFIG } from '../plugins/scheduler/index.js';
import { transcriptDetail } from '../records/transcript.js';

const POLL_MS = 1_000; // 等候到期计划，精度为分钟。
const BODY_LIMIT = 128 * 1024; // 浏览器计划配置请求上限。
const PAGE_LIMIT = 200;
type Input = Record<string, unknown>;
type Command = { handled: boolean; data?: unknown };
type Trigger = 'scheduled' | 'manual' | 'retry';

function string(value: unknown, label: string): string {
  assert(typeof value === 'string' && value.trim() && value.length <= 256, 'INVALID_CRON_CONFIG', `${label} 必须为有效字符串`);
  return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  assert((typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isSafeInteger(number) && number >= minimum && number <= maximum, 'INVALID_CRON_CONFIG', '数值超出有效范围');
  return number;
}
function timestamp(value: unknown): number {
  if (value === undefined) return Date.now();
  const result = Date.parse(string(value, 'now'));
  assert(Number.isFinite(result), 'INVALID_CRON_CONFIG', '无效执行时间');
  return result;
}
function configuration(input: Input, previous?: Job): PlanConfig {
  const id = input.taskType ?? previous?.taskType;
  const type = taskType(id);
  const target = input.target === undefined ? previous?.target : string(input.target, 'target').toLowerCase();
  type.targetKey(target);
  return { taskType: type.id, ...(target ? { target } : {}), params: taskParams(type, input.params ?? previous?.params), schedule: scheduleOf(input.schedule ?? previous?.schedule) };
}

/** 统一服务装配定时引擎。关闭插件只影响自动调度，业务命令仍由服务处理。 */
export async function createCronService({ dataDir, db, dispatch }: { dataDir: string; db: DatabaseSync; dispatch: Dispatch }) {
  const store = new CronStore(db);
  const legacy = new LegacySchedules(dataDir, store);
  let suspended = true;
  let timer: NodeJS.Timeout | undefined;
  let poll: Promise<unknown> | undefined;
  let enabled = false;
  let errorCode: string | undefined;
  let changes = Promise.resolve();
  const targets = new Map<string, Promise<unknown>>();

  function change<T>(action: () => Promise<T> | T): Promise<T> {
    const result = changes.then(action);
    changes = result.then(() => undefined, () => undefined);
    return result;
  }

  async function pluginAvailable(owner: string): Promise<boolean> {
    const app = await openApplication(dataDir, { readOnly: true });
    try { return app.plugins.list().some(item => item.manifest.id === owner && item.enabled && item.ready); }
    finally { await app.close(); }
  }

  function requireOpen() {
    assert(!suspended, 'CRON_PAUSED', '服务正在暂停或停止调度');
  }

  function job(id: unknown): Job {
    const result = store.get(string(id, 'id'));
    assert(result, 'NOT_FOUND', '未找到计划');
    return result;
  }

  async function withTarget<T>(key: string, action: () => Promise<T>): Promise<T> {
    requireOpen();
    assert(!targets.has(key), 'CRON_TARGET_BUSY', '该业务目标正在运行');
    const result = Promise.resolve().then(action);
    targets.set(key, result);
    try { return await result; } finally { targets.delete(key); }
  }

  async function run(plan: Job, now: number, trigger: Trigger, retryOf?: string, requiresCron = true) {
    if (trigger === 'scheduled' && targets.has(plan.targetKey)) return undefined;
    return withTarget(plan.targetKey, async () => {
      const type = taskType(plan.taskType);
      // 插件启停与运行认领走同一队列，已停用的插件不会再产生新认领。
      const id = await change(async () => {
        if (suspended) return undefined;
        const ownerReady = await pluginAvailable(type.owner);
        const cronReady = !requiresCron || await pluginAvailable('cron');
        if (suspended) return undefined;
        if (!ownerReady || !cronReady) {
          if (trigger === 'scheduled') return undefined;
          throw new KnowledgeError('PLUGIN_UNAVAILABLE', '定时插件或任务所属插件不可用');
        }
        await legacy.applyIntents(now);
        if (suspended) return undefined;
        return store.claim(plan, now, trigger, retryOf);
      });
      if (!id) return undefined;
      let result: unknown;
      try { result = await type.run(dispatch, plan); }
      catch (error) {
        const code = error instanceof KnowledgeError ? error.code : 'CRON_TASK_FAILED';
        return { record: store.finish(id, 'failed', { code }, Date.now()), error };
      }
      const value = result !== null && typeof result === 'object' && !Array.isArray(result) ? result as Input : {};
      const summary: Input = {};
      for (const key of ['complete', 'processed', 'succeeded', 'failed', 'unfinished', 'draining', 'created', 'modelCalls']) {
        if (typeof value[key] === 'number' || typeof value[key] === 'boolean') summary[key] = value[key];
      }
      const failed = typeof value.failed === 'number' && value.failed > 0;
      const partial = value.complete === false || Number(value.unfinished ?? 0) > 0 || Number(value.draining ?? 0) > 0;
      return { record: store.finish(id, failed ? 'failed' : partial ? 'partial' : 'succeeded', summary, Date.now()), result };
    });
  }

  async function due(now: number, type?: string) {
    if (suspended) return [];
    await change(() => legacy.applyIntents(now));
    const results = [];
    for (const plan of store.due(now, type)) {
      if (suspended || !enabled) break;
      const outcome = await run(plan, now, 'scheduled');
      if (outcome) results.push({ plan, ...outcome });
    }
    return results;
  }

  function tick(now: number, type?: string) {
    if (poll) return Promise.resolve([]);
    const current = due(now, type);
    poll = current;
    void current.then(() => { errorCode = undefined; }, error => {
      errorCode = error instanceof KnowledgeError ? error.code : 'CRON_POLL_FAILED';
    }).finally(() => { if (poll === current) poll = undefined; });
    return current;
  }

  async function save(input: Input, previous?: Job) {
    requireOpen();
    const config = configuration(input, previous);
    const key = taskType(config.taskType).targetKey(config.target);
    assert(!previous || key === previous.targetKey, 'INVALID_CRON_CONFIG', '已有计划不能更换任务类型或目标');
    const active = input.enabled === undefined ? previous?.enabled ?? false : enabledOf(input.enabled);
    if (config.taskType === TRANSCRIBE) {
      const organization = await dispatch(['transcript', 'get'], { id: config.target }) as Organization;
      assert(!active || object(organization.data.config).projectDir, 'INVALID_CRON_CONFIG', '启用转录计划前须设置项目目录');
    }
    const revision = previous ? integer(input.expectedRevision, 1) : undefined;
    return store.save(previous?.id ?? randomUUID(), key, config, active, Date.now(), revision);
  }

  function history(input: Input) {
    return store.runs(input.jobId === undefined ? undefined : string(input.jobId, 'jobId'), integer(input.offset ?? 0, 0), integer(input.limit ?? 50, 1, PAGE_LIMIT));
  }

  async function cronCommand(action: string | undefined, input: Input): Promise<unknown> {
    switch (action) {
      case 'types': return taskTypes();
      case 'list': return store.list(integer(input.offset ?? 0, 0), integer(input.limit ?? 50, 1, PAGE_LIMIT));
      case 'get': return job(input.id);
      case 'runs': return history(input);
      case 'create': return change(() => save(input));
      case 'update': return change(() => save(input, job(input.id)));
      case 'enable': case 'disable': return change(() => save({ ...input, enabled: action === 'enable' }, job(input.id)));
      case 'delete': return change(() => {
        requireOpen();
        const previous = job(input.id);
        store.delete(previous.id, integer(input.expectedRevision, 1), Date.now());
        return { deleted: true };
      });
      case 'run': {
        const result = await run(job(input.id), Date.now(), 'manual');
        assert(result, 'CONFIG_CONFLICT', '计划配置已变化');
        return result.record;
      }
      case 'retry': {
        const previous = store.run(string(input.id, 'id'));
        assert(previous, 'NOT_FOUND', '未找到运行记录');
        assert(['failed', 'partial', 'interrupted'].includes(previous.status), 'INVALID_CRON_CONFIG', '仅失败、未完成和中断的运行可以重试');
        const result = await run(job(previous.jobId), Date.now(), 'retry', previous.id);
        assert(result, 'CONFIG_CONFLICT', '计划配置已变化');
        return result.record;
      }
      default: throw new KnowledgeError('INVALID_ARGUMENT', '未知 cron 命令', undefined, 2);
    }
  }

  async function transcriptConfig(action: 'create' | 'configure', input: Input) {
    requireOpen();
    return change(() => legacy.configureTranscript(action, input, Date.now()));
  }

  async function command(words: string[], input: Input): Promise<Command> {
    const [group, action] = words;
    const handled = (data: unknown): Command => ({ handled: true, data });
    if (group === 'cron') return handled(await cronCommand(action, input));
    if (group === 'plugin' && (action === 'enable' || action === 'disable' || action === 'refresh')) {
      return handled(await change(async () => {
        const data = await dispatch(words, input);
        enabled = await pluginAvailable('cron');
        return data;
      }));
    }
    if ((group === 'organization' || group === 'org') && (action === 'delete' || action === 'update' && input.data !== undefined)) {
      return handled(await change(async () => {
        await legacy.applyIntents(Date.now());
        if (typeof input.id === 'string') {
          const key = transcriptKey(input.id);
          assert(!targets.has(key), 'CRON_TARGET_BUSY', '转录实例正在运行');
          const plan = store.target(key);
          assert(!plan, 'CRON_TARGET_IN_USE', action === 'delete' ? '请先删除该转录实例的 cron 计划' : '有 cron 计划的转录实例须通过 transcript configure 修改业务配置', { jobId: plan?.id });
        }
        return dispatch(words, input);
      }));
    }
    if (group === 'schedule') {
      assert(await pluginAvailable('scheduler'), 'PLUGIN_UNAVAILABLE', '旧周期接口所属插件不可用');
      if (action === 'get') return handled(legacy.organizerState());
      if (action === 'configure') {
        requireOpen();
        return handled(await change(() => legacy.configureOrganizer(input, Date.now())));
      }
      if (action === 'tick') {
        const [outcome] = await tick(timestamp(input.now), ORGANIZE);
        if (outcome && 'error' in outcome) throw outcome.error;
        const plan = store.target(ORGANIZE);
        return handled(outcome ? { ...object(outcome.result), triggered: true, now: new Date(outcome.record.startedAt).toISOString(), complete: outcome.record.status === 'succeeded', assignment: 'waiting-for-working-codex' } : { triggered: false, reason: enabled && plan?.enabled ? 'not-due' : 'disabled' });
      }
      if (action === 'run') {
        const plan = store.target(ORGANIZE) ?? store.save(ORGANIZER_JOB, ORGANIZE, { taskType: ORGANIZE, params: taskParams(taskType(ORGANIZE), { maxTasks: DEFAULT_CONFIG.maxTasks, maxDurationMs: DEFAULT_CONFIG.maxDurationMs, maxCalls: DEFAULT_CONFIG.maxCalls, maxCost: DEFAULT_CONFIG.maxCost }), schedule: scheduleOf({ kind: 'cron', expression: '0 3 * * *', timezone: DEFAULT_CONFIG.timezone }) }, false, Date.now());
        const outcome = await run(plan, timestamp(input.now), 'manual', undefined, false);
        assert(outcome, 'CONFIG_CONFLICT', '计划配置已变化');
        if ('error' in outcome) throw outcome.error;
        return handled({ ...object(outcome.result), triggered: true, now: new Date(outcome.record.startedAt).toISOString(), complete: outcome.record.status === 'succeeded', assignment: 'waiting-for-working-codex' });
      }
    }
    if (group === 'organize' && action === 'run') return handled(await withTarget(ORGANIZE, () => dispatch(words, input)));
    if (group === 'transcript') {
      if (action === 'create' || action === 'configure') return handled(await transcriptConfig(action, input));
      if (action === 'get') return handled(legacy.project(await dispatch(words, input) as Organization));
      if (action === 'status') return handled(transcriptDetail(legacy.project(await dispatch(['transcript', 'get'], input) as Organization)));
      if (action === 'list') return handled((await dispatch(words, input) as Organization[]).map(org => legacy.project(org)));
      if (action === 'tick') {
        const outcomes = await tick(Date.now(), TRANSCRIBE);
        const results = outcomes.map(outcome => ({ id: outcome.plan.target, ...('error' in outcome ? { error: outcome.record.summary } : { result: outcome.result }) }));
        assert(!results.some(item => 'error' in item), 'TRANSCRIPT_FAILED', '转录周期执行失败', { results });
        return handled({ results });
      }
      if (action && ['run', 'retry', 'backfill'].includes(action)) {
        const organization = await dispatch(['transcript', 'get'], { ...(input.id !== undefined ? { id: input.id } : {}), ...(input.alias !== undefined ? { alias: input.alias } : {}) }) as Organization;
        const { alias: _alias, ...execution } = input;
        return handled(await withTarget(transcriptKey(organization.id), () => dispatch(words, { ...execution, id: organization.id })));
      }
    }
    return { handled: false };
  }

  async function body(request: IncomingMessage, origin: string) {
    assert(request.headers.origin === origin, 'LOCAL_ONLY', '请求必须来自本地同源页面');
    assert(request.headers['content-type']?.split(';')[0].trim() === 'application/json', 'INVALID_CRON_CONFIG', '请求须为 application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > BODY_LIMIT) request.resume();
      assert(size <= BODY_LIMIT, 'INVALID_CRON_CONFIG', '计划请求超过128KiB');
      chunks.push(Buffer.from(chunk));
    }
    try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
    catch { throw new KnowledgeError('INVALID_CRON_CONFIG', '请求体须为有效 UTF-8 JSON 对象'); }
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, origin: string): Promise<boolean> {
    const path = url.pathname;
    if (path === '/api/transcripts' || path.startsWith('/api/transcripts/')) {
      return handleTranscripts(request, response, url, dataDir, origin, { command: transcriptConfig, project: org => legacy.project(org) });
    }
    if (path !== '/api/cron' && !path.startsWith('/api/cron/')) return false;
    try {
      const method = request.method;
      const query = Object.fromEntries(url.searchParams);
      const plan = /^\/api\/cron\/jobs\/([^/]+)(?:\/(run))?$/.exec(path);
      const retry = /^\/api\/cron\/runs\/([^/]+)\/retry$/.exec(path);
      let data: unknown;
      if (path === '/api/cron/task-types' && method === 'GET') data = await cronCommand('types', {});
      else if (path === '/api/cron/jobs' && method === 'GET') data = await cronCommand('list', query);
      else if (path === '/api/cron/runs' && method === 'GET') data = await cronCommand('runs', query);
      else if (plan && !plan[2] && method === 'GET') data = await cronCommand('get', { id: plan[1] });
      else if (path === '/api/cron/jobs' && method === 'POST') data = await cronCommand('create', await body(request, origin));
      else if (plan && !plan[2] && (method === 'PATCH' || method === 'DELETE')) data = await cronCommand(method === 'PATCH' ? 'update' : 'delete', { ...await body(request, origin), id: plan[1] });
      else if (plan?.[2] && method === 'POST') data = await cronCommand('run', { ...await body(request, origin), id: plan[1] });
      else if (retry && method === 'POST') data = await cronCommand('retry', { ...await body(request, origin), id: retry[1] });
      else throw new KnowledgeError('NOT_FOUND', '计划接口不存在');
      previewJson(response, 200, { ok: true, data });
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : 'CRON_API_FAILED';
      const status = code === 'LOCAL_ONLY' ? 403 : code === 'NOT_FOUND' ? 404 : ['CONFIG_CONFLICT', 'CRON_TARGET_BUSY', 'CRON_TARGET_CONFLICT', 'CRON_PAUSED', 'PLUGIN_UNAVAILABLE'].includes(code) ? 409 : code.startsWith('INVALID_') || code === 'CRON_TASK_TYPE_NOT_FOUND' ? 400 : 500;
      previewJson(response, status, { ok: false, error: { code, message: error instanceof KnowledgeError ? error.message : '计划接口失败' } });
    }
    return true;
  }

  function start() {
    suspended = false;
    timer ??= setInterval(() => { void tick(Date.now()); }, POLL_MS);
  }

  async function suspend() {
    suspended = true;
    clearInterval(timer);
    timer = undefined;
    await Promise.allSettled([poll, changes, ...targets.values()]);
  }

  async function prepare(restored = false) {
    const now = Date.now();
    store.recover(now);
    const manager = await CoreManager.open(dataDir);
    await manager.close();
    await legacy.migrate(now);
    await legacy.applyIntents(now);
    if (restored) store.disableAll();
    enabled = await pluginAvailable('cron');
  }

  function validateSnapshot() {
    try {
      assert(store.mark('schema') === '1', 'INVALID_BACKUP', 'cron 备份版本不支持');
      for (const row of db.prepare('SELECT * FROM cron_jobs').iterate()) {
        const input = object(JSON.parse(String(row.config_json)));
        const config = configuration(input);
        assert(taskType(config.taskType).targetKey(config.target) === row.target_key && Number(row.revision) > 0, 'INVALID_BACKUP', '计划备份配置不匹配');
        assert(row.enabled === 0 ? row.next_at === null : Number.isSafeInteger(row.next_at), 'INVALID_BACKUP', '计划备份到期状态无效');
      }
      for (const row of db.prepare('SELECT * FROM cron_runs').iterate()) {
        const saved = object(JSON.parse(String(row.job_json)));
        configuration(saved);
        assert(saved.id === row.job_id && ['scheduled', 'manual', 'retry'].includes(String(row.trigger)) && ['running', 'succeeded', 'partial', 'failed', 'interrupted'].includes(String(row.status)), 'INVALID_BACKUP', '运行备份无效');
        assert((row.trigger === 'scheduled') === (row.slot !== null) && (row.trigger === 'retry') === (row.retry_of !== null), 'INVALID_BACKUP', '运行触发类型不匹配');
        if (row.summary_json !== null) object(JSON.parse(String(row.summary_json)));
      }
    } catch { throw new KnowledgeError('INVALID_BACKUP', 'cron 备份内容无法恢复'); }
  }

  await prepare();
  return { start, stop: suspend, suspend, async resume(restored = false, legacyBackup = false) {
    if (legacyBackup) store.resetLegacyMigration();
    if (restored) await prepare(true);
    start();
  }, command, handle, validateSnapshot, status: () => ({ enabled, suspended, running: targets.size, ...(errorCode ? { errorCode } : {}) }) };
}
