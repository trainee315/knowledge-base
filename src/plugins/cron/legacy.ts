import { randomUUID } from 'node:crypto';
import type { JsonObject, Organization } from '../../contracts/index.js';
import { assert, KnowledgeError } from '../../core/errors.js';
import { CoreManager } from '../../core/manager.js';
import type { Config } from '../../records/config.js';
import { transcriptCommand } from '../../records/transcript.js';
import { DEFAULT_CONFIG, type ScheduleState } from '../scheduler/index.js';
import { latestSlot, nextSlot, object, scheduleOf } from './plan.js';
import { type CronStore, type PlanConfig } from './store.js';
import { ORGANIZE, TRANSCRIBE, taskParams, taskType } from './tasks.js';

export const ORGANIZER_JOB = 'legacy-scheduler';
const transcriptJob = (id: string) => `legacy-transcript-${id}`;
export const transcriptKey = (id: string) => `${TRANSCRIBE}:${id.toLowerCase()}`;
const TRANSCRIPT_TYPE = 'session-transcript';

function organizerConfig(input: Record<string, unknown>): PlanConfig {
  const { time, timezone } = input;
  assert(typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'INVALID_CRON_CONFIG', '整理时间须为 HH:mm');
  const [hour, minute] = time.split(':').map(Number);
  const type = taskType(ORGANIZE);
  const params = taskParams(type, Object.fromEntries(type.parameterNames.filter(key => input[key] !== undefined).map(key => [key, input[key]])));
  return { taskType: ORGANIZE, params, schedule: scheduleOf({ kind: 'cron', expression: `${minute} ${hour} * * *`, timezone }) };
}

export function enabledOf(value: unknown): boolean {
  assert(typeof value === 'boolean' || value === 'true' || value === 'false', 'INVALID_CRON_CONFIG', 'enabled 必须为 boolean');
  return value === true || value === 'true';
}

function day(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class LegacySchedules {
  constructor(private readonly dataDir: string, private readonly store: CronStore) {}

  async migrate(now: number) {
    if (this.store.mark('legacy-v1')) return;
    const manager = await CoreManager.open(this.dataDir, { readOnly: true });
    try {
      const legacy = await manager.pluginStore('scheduler').read<ScheduleState | null>('schedule', null);
      const organizations = await manager.listOrganizations(TRANSCRIPT_TYPE);
      this.store.transaction(() => {
        if (legacy && !this.store.target(ORGANIZE)) {
          const config = organizerConfig({ ...legacy.config });
          const timezone = legacy.config.timezone;
          const previous = latestSlot(config.schedule, 0, now);
          const completed = legacy.lastDate === day(now, timezone);
          const first = !completed && day(previous, timezone) === day(now, timezone) ? previous : nextSlot(config.schedule, now);
          this.store.save(ORGANIZER_JOB, ORGANIZE, config, legacy.config.enabled, now, undefined, first);
        }
        for (const org of organizations) {
          const raw = object(org.data.config);
          if (raw.intervalMinutes === undefined || this.store.target(transcriptKey(org.id))) continue;
          const schedule = scheduleOf({ kind: 'interval', minutes: raw.intervalMinutes });
          const first = typeof org.data.nextDue === 'number' && Number.isSafeInteger(org.data.nextDue) ? org.data.nextDue : now;
          this.store.save(transcriptJob(org.id), transcriptKey(org.id), { taskType: TRANSCRIBE, target: org.id, params: {}, schedule }, raw.enabled === true, now, undefined, first);
        }
        this.store.mark('legacy-v1', 'done');
      });
    } finally { await manager.close(); }
  }

  /** 文件事务提交后的周期意图在数据库中幂等应用；删除意图前先记录操作 ID。 */
  async applyIntents(now: number) {
    const reader = await CoreManager.open(this.dataDir, { readOnly: true });
    let pending: boolean;
    try { pending = (await reader.pluginStore('cron').list()).some(key => key.startsWith('intent-')); }
    finally { await reader.close(); }
    if (!pending) return;
    const manager = await CoreManager.open(this.dataDir);
    try {
      const intents = manager.pluginStore('cron');
      for (const key of await intents.list()) {
        if (!key.startsWith('intent-')) continue;
        const intent = await intents.read<Record<string, unknown>>(key, {});
        const { operationId, target } = intent;
        assert(typeof operationId === 'string' && typeof target === 'string', 'INVALID_CRON_INTENT', '周期变更意图不完整');
        const targetKey = taskType(TRANSCRIBE).targetKey(target);
        this.store.transaction(() => {
          if (this.store.mark(`operation:${operationId}`)) return;
          const previous = this.store.target(targetKey);
          if (intent.remove === true && previous) this.store.delete(previous.id, previous.revision, now);
          const schedule = intent.schedule ? scheduleOf(intent.schedule) : previous?.schedule;
          if (schedule && intent.remove !== true) {
            const config = { taskType: TRANSCRIBE, target, params: previous?.params ?? {}, schedule };
            this.store.save(previous?.id ?? transcriptJob(target), targetKey, config, enabledOf(intent.enabled), now);
          }
          this.store.mark(`operation:${operationId}`, 'done');
        });
        await intents.remove(key);
      }
    } finally { await manager.close(); }
  }

  project(org: Organization): Organization {
    if (org.type !== TRANSCRIPT_TYPE) return org;
    const job = this.store.target(transcriptKey(org.id));
    const config: JsonObject = { ...object(org.data.config), enabled: job?.enabled ?? false } as JsonObject;
    if (job?.schedule.kind === 'interval') config.intervalMinutes = job.schedule.minutes;
    else delete config.intervalMinutes;
    return { ...org, data: { ...org.data, config, nextDue: job?.nextRunAt ?? null, cronRevision: job?.revision ?? null, ...(job ? { cronSchedule: job.schedule } : {}) } };
  }

  async configureTranscript(action: 'create' | 'configure', input: Record<string, unknown>, now: number): Promise<Organization> {
    await this.applyIntents(now);
    const selector = input.id !== undefined ? { id: input.id } : { alias: input.alias };
    const currentOrg = action === 'configure' ? await transcriptCommand(this.dataDir, 'get', selector) as Organization : undefined;
    const current = currentOrg && this.store.target(transcriptKey(currentOrg.id));
    assert(input.expectedCronRevision === undefined || input.expectedCronRevision === (current?.revision ?? null), 'REVISION_CONFLICT', '转录周期配置已变化');
    const enabled = input.enabled === undefined ? current?.enabled ?? false : enabledOf(input.enabled);
    const clear = input.intervalMinutes === null && current?.schedule.kind === 'interval';
    const schedule = input.intervalMinutes != null
      ? scheduleOf({ kind: 'interval', minutes: input.intervalMinutes })
      : clear ? undefined : current?.schedule;
    assert(!enabled || schedule, 'INVALID_CRON_CONFIG', '启用转录周期前须设置计划');
    const changed = enabled !== (current?.enabled ?? false) || JSON.stringify(schedule) !== JSON.stringify(current?.schedule);
    const { expectedCronRevision: _expectedCronRevision, ...business } = input;
    const compatible = {
      ...business, enabled: schedule?.kind === 'interval' ? enabled : false,
      intervalMinutes: schedule?.kind === 'interval' ? schedule.minutes : null,
    };
    const operationId = randomUUID();
    const org = await transcriptCommand(this.dataDir, action, compatible, undefined, (config: Config) => {
      assert(!enabled || config.projectDir, 'INVALID_CRON_CONFIG', '启用转录计划前须设置项目目录');
      if (!changed) return undefined;
      return { operationId, enabled, ...(schedule ? { schedule } : { remove: true }) };
    }) as Organization;
    if (changed) {
      try { await this.applyIntents(now); }
      catch { throw new KnowledgeError('CRON_CONFIG_PENDING', '业务配置已保存，周期变更将在服务恢复时完成', { operationId }); }
    }
    return this.project(org);
  }

  organizerState(): ScheduleState {
    const job = this.store.target(ORGANIZE);
    const schedule = job?.schedule;
    const daily = schedule?.kind === 'cron' ? /^(\d+) (\d+) \* \* \*$/.exec(schedule.expression) : null;
    const time = daily ? `${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}` : DEFAULT_CONFIG.time;
    const run = job ? this.store.runs(job.id, 0, 1).items[0] : undefined;
    return {
      config: { ...DEFAULT_CONFIG, ...job?.params, enabled: job?.enabled ?? false, time, timezone: schedule?.kind === 'cron' ? schedule.timezone : DEFAULT_CONFIG.timezone },
      ...(run ? { lastAttempt: new Date(run.startedAt).toISOString(), lastAttemptComplete: run.status === 'succeeded' } : {}),
      ...(run?.status === 'succeeded' && run.finishedAt !== null ? { lastRun: new Date(run.finishedAt).toISOString() } : {}),
    };
  }

  configureOrganizer(input: Record<string, unknown>, now: number) {
    const previous = this.store.target(ORGANIZE);
    const merged = { ...this.organizerState().config, ...input };
    const config = organizerConfig(merged);
    if (previous && input.time === undefined && input.timezone === undefined) config.schedule = previous.schedule;
    this.store.save(previous?.id ?? ORGANIZER_JOB, ORGANIZE, config, enabledOf(merged.enabled), now);
    return this.organizerState();
  }
}
