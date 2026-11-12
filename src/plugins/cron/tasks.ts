import { assert } from '../../core/errors.js';
import { UUID_PATTERN } from '../../core/schema.js';
import { object } from './plan.js';
import type { Job } from './store.js';

export type Dispatch = (words: string[], input: Record<string, unknown>) => Promise<unknown>;
export interface TaskType {
  id: string;
  title: string;
  owner: string;
  parameterNames: string[];
  targetKey(value: unknown): string;
  run(dispatch: Dispatch, job: Job): Promise<unknown>;
}

export const ORGANIZE = 'organizer.run';
export const TRANSCRIBE = 'transcript.run';
const ORGANIZER_LIMITS = ['maxTasks', 'maxDurationMs', 'maxCalls', 'maxCost'];
const TRANSCRIPT_LIMITS = ['maxSessions', 'maxInputBytes', 'maxCalls', 'maxDurationMs'];

/** 显式注册的任务适配器只可调用内部业务处理器。 */
const types = new Map<string, TaskType>();
export function registerCronTask(type: TaskType) {
  assert(!types.has(type.id), 'CRON_TASK_TYPE_CONFLICT', '任务类型已注册');
  types.set(type.id, type);
}
export function taskType(id: unknown): TaskType {
  const type = typeof id === 'string' ? types.get(id) : undefined;
  assert(type, 'CRON_TASK_TYPE_NOT_FOUND', '任务类型未注册');
  return type;
}
export function taskTypes() {
  return [...types.values()].map(({ id, title, owner, parameterNames }) => ({ id, title, owner, parameterNames }));
}
export function taskParams(type: TaskType, value: unknown): Record<string, number> {
  const input = object(value ?? {});
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    const min = ['maxTasks', 'maxCalls', 'maxCost'].includes(key) ? 0 : 1;
    assert((typeof value === 'number' || typeof value === 'string' && value.trim()) && type.parameterNames.includes(key), 'INVALID_CRON_CONFIG', `无效任务参数 ${key}`);
    const number = Number(value);
    assert((key === 'maxCost' ? Number.isFinite(number) : Number.isSafeInteger(number)) && number >= min, 'INVALID_CRON_CONFIG', `无效任务参数 ${key}`);
    assert(type.id !== TRANSCRIBE || key !== 'maxDurationMs' || number <= 300_000, 'INVALID_CRON_CONFIG', '转录时限最多300000ms');
    return [key, number];
  }));
}

registerCronTask({
  id: ORGANIZE, title: '知识库整理', owner: 'organizer', parameterNames: ORGANIZER_LIMITS,
  targetKey(target) {
    assert(target === undefined, 'INVALID_CRON_CONFIG', '知识库整理无需实例 ID');
    return ORGANIZE;
  },
  run: (dispatch, job) => dispatch(['organize', 'run'], job.params),
});
registerCronTask({
  id: TRANSCRIBE, title: 'Session 转录', owner: 'transcripts', parameterNames: TRANSCRIPT_LIMITS,
  targetKey(target) {
    assert(typeof target === 'string' && UUID_PATTERN.test(target), 'INVALID_CRON_CONFIG', '转录计划需要实例 UUID');
    return `${TRANSCRIBE}:${target.toLowerCase()}`;
  },
  run: (dispatch, job) => dispatch(['transcript', 'run'], { ...job.params, id: job.target }),
});
