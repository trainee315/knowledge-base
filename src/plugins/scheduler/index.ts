import type { PluginDefinition } from '../../contracts/index.js';
import type { OrganizerApi } from '../organizer/index.js';
import type { RunOptions } from '../tasks/index.js';
import { boolean, manifest, number, required } from '../shared.js';

// 只保存调度配置并响应显式tick，不注册系统任务或唤起独立Agent。
export const DEFAULT_CONFIG: ScheduleConfig = { enabled: true, time: '03:00', timezone: 'Asia/Shanghai', maxTasks: 100, maxDurationMs: 60_000, maxCalls: 0, maxCost: 0 };
export interface ScheduleConfig extends RunOptions { enabled: boolean; time: string; timezone: string }
export interface ScheduleState { config: ScheduleConfig; lastDate?: string; lastRun?: string; lastAttempt?: string; lastAttemptComplete?: boolean; lastError?: string }
export interface SchedulerApi {
  get(): Promise<ScheduleState>; configure(input: Partial<ScheduleConfig>): Promise<ScheduleState>;
  tick(now?: string): Promise<unknown>; run(now?: string): Promise<unknown>;
}

export const schedulerPlugin: PluginDefinition = {
  manifest: manifest('scheduler', ['organizer']),
  async load(context) {
    const organizer = context.getDependency<OrganizerApi>('organizer');
    const state = await context.store.read<ScheduleState>('schedule', { config: { ...DEFAULT_CONFIG } });
    const local = (date: Date) => {
      if (!Number.isFinite(date.getTime())) throw new Error('INVALID_TIME: now必须为有效ISO时间');
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: state.config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
      return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
    };
    const api: SchedulerApi = {
      async get() { return structuredClone(state); },
      async configure(input) {
        const config = { ...state.config, ...input };
        if (typeof config.time !== 'string' || typeof config.timezone !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(config.time) || typeof config.enabled !== 'boolean') throw new Error('INVALID_CONFIG: 需要HH:mm时间、时区字符串和boolean enabled');
        new Intl.DateTimeFormat('en', { timeZone: config.timezone });
        if (![config.maxTasks ?? 100, config.maxDurationMs ?? 60_000, config.maxCalls ?? 0].every(Number.isSafeInteger) || !Number.isFinite(config.maxCost ?? 0) || (config.maxTasks ?? 100) < 0 || (config.maxDurationMs ?? 60_000) <= 0 || (config.maxCalls ?? 0) < 0 || (config.maxCost ?? 0) < 0) throw new Error('INVALID_CONFIG: 任务数、毫秒、调用数必须为整数，费用必须为有限非负数');
        state.config = config; await context.store.write('schedule', state); return api.get();
      },
      async run(now = new Date().toISOString()) {
        const clock = local(new Date(now));
        state.lastAttempt = now; state.lastAttemptComplete = false; delete state.lastError;
        await context.store.write('schedule', state);
        try {
          const result = await organizer.run(state.config);
          const complete = result.failed === 0 && result.unfinished === 0 && result.draining === 0;
          state.lastAttemptComplete = complete;
          if (complete) { state.lastDate = clock.date; state.lastRun = now; }
          await context.store.write('schedule', state);
          return { triggered: true, now, complete, ...result, assignment: 'waiting-for-working-codex' };
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          await context.store.write('schedule', state); throw error;
        }
      },
      async tick(now = new Date().toISOString()) {
        const clock = local(new Date(now));
        if (!state.config.enabled) return { triggered: false, reason: 'disabled' };
        if (clock.time < state.config.time || state.lastDate === clock.date && state.lastAttemptComplete !== false) return { triggered: false, reason: 'not-due' };
        return api.run(now);
      },
    };
    context.registerCommand('schedule get', async () => api.get());
    context.registerCommand('schedule configure', async ({ input }) => api.configure({ ...(input.enabled !== undefined ? { enabled: boolean(input.enabled) } : {}), ...(input.time !== undefined ? { time: required(input, 'time') } : {}), ...(input.timezone !== undefined ? { timezone: required(input, 'timezone') } : {}), ...(input.maxTasks !== undefined ? { maxTasks: number(input.maxTasks, 100) } : {}), ...(input.maxDurationMs !== undefined ? { maxDurationMs: number(input.maxDurationMs, 60_000) } : {}), ...(input.maxCalls !== undefined ? { maxCalls: number(input.maxCalls, 0) } : {}), ...(input.maxCost !== undefined ? { maxCost: number(input.maxCost, 0) } : {}) }));
    context.registerCommand('schedule tick', async ({ input }) => api.tick(input.now === undefined ? undefined : required(input, 'now')));
    context.registerCommand('schedule run', async ({ input }) => api.run(input.now === undefined ? undefined : required(input, 'now')));
    return { api };
  },
};
export default schedulerPlugin;
