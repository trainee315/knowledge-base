import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assert } from '../../core/errors.js';
import { latestSlot, nextSlot, type Schedule } from './plan.js';

export interface PlanConfig {
  taskType: string;
  target?: string;
  params: Record<string, unknown>;
  schedule: Schedule;
}
export interface Job extends PlanConfig {
  id: string;
  targetKey: string;
  enabled: boolean;
  revision: number;
  nextRunAt: number | null;
}
type JobRow = { id: string; target_key: string; enabled: number; revision: number; next_at: number | null; config_json: string };
type Trigger = 'scheduled' | 'manual' | 'retry';
export type RunState = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
type RunRow = { id: string; job_id: string; slot: number | null; trigger: Trigger; status: RunState; started_at: number; finished_at: number | null; summary_json: string | null; retry_of: string | null };

const jobOf = (row: JobRow): Job => ({
  ...JSON.parse(row.config_json) as PlanConfig,
  id: row.id, targetKey: row.target_key, enabled: row.enabled === 1, revision: row.revision, nextRunAt: row.next_at,
});
const runOf = (row: RunRow) => ({
  id: row.id, jobId: row.job_id, scheduledAt: row.slot, trigger: row.trigger, status: row.status,
  startedAt: row.started_at, finishedAt: row.finished_at,
  summary: row.summary_json ? JSON.parse(row.summary_json) as unknown : null, retryOf: row.retry_of,
});

/** 所有认领和计划推进在短 SQLite 事务完成，业务处理器在事务之外执行。 */
export class CronStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS cron_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY, target_key TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        revision INTEGER NOT NULL, next_at INTEGER, deleted_at INTEGER, config_json TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS cron_target_active ON cron_jobs(target_key) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS cron_due ON cron_jobs(next_at) WHERE enabled = 1 AND deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES cron_jobs(id), slot INTEGER, trigger TEXT NOT NULL,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, job_json TEXT NOT NULL,
        summary_json TEXT, retry_of TEXT REFERENCES cron_runs(id), UNIQUE(job_id, slot)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cron_runs_history ON cron_runs(job_id, started_at DESC, id DESC);`);
    const version = this.mark('schema');
    assert(!version || version === '1', 'UNSUPPORTED_CRON_SCHEMA', '不支持此 cron 数据库版本');
    if (!version) this.mark('schema', '1');
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  mark(key: string, value?: string): string | undefined {
    if (value === undefined) return (this.db.prepare('SELECT value FROM cron_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    this.db.prepare('INSERT INTO cron_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    return value;
  }

  resetLegacyMigration(): void {
    this.db.prepare("DELETE FROM cron_meta WHERE key='legacy-v1'").run();
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM cron_jobs WHERE id=? AND deleted_at IS NULL').get(id) as JobRow | undefined;
    return row && jobOf(row);
  }

  target(key: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM cron_jobs WHERE target_key=? AND deleted_at IS NULL').get(key) as JobRow | undefined;
    return row && jobOf(row);
  }

  list(offset = 0, limit = 100) {
    const items = (this.db.prepare('SELECT * FROM cron_jobs WHERE deleted_at IS NULL ORDER BY id LIMIT ? OFFSET ?').all(limit, offset) as JobRow[]).map(jobOf);
    const total = Number(this.db.prepare('SELECT count(*) AS total FROM cron_jobs WHERE deleted_at IS NULL').get()?.total);
    return { items, total };
  }

  due(now: number, taskType?: string) {
    return (this.db.prepare(`SELECT * FROM cron_jobs WHERE enabled=1 AND deleted_at IS NULL AND next_at<=?
      AND (? IS NULL OR json_extract(config_json, '$.taskType')=?) ORDER BY next_at,id`).all(now, taskType ?? null, taskType ?? null) as JobRow[]).map(jobOf);
  }

  save(id: string, targetKey: string, config: PlanConfig, enabled: boolean, now: number, expectedRevision?: number, first?: number): Job {
    const previous = this.get(id);
    assert(expectedRevision === undefined || previous?.revision === expectedRevision, 'CONFIG_CONFLICT', '计划配置已变化', { id });
    const other = this.target(targetKey);
    assert(!other || other.id === id, 'CRON_TARGET_CONFLICT', '该业务目标已有计划', { id: other?.id });
    const scheduleUnchanged = previous?.enabled && JSON.stringify(previous.schedule) === JSON.stringify(config.schedule);
    const next = !enabled ? null : first ?? (scheduleUnchanged ? previous.nextRunAt : null) ?? nextSlot(config.schedule, now);
    this.db.prepare(`INSERT INTO cron_jobs(id,target_key,enabled,revision,next_at,config_json) VALUES (?,?,?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET target_key=excluded.target_key,enabled=excluded.enabled,revision=cron_jobs.revision+1,
      next_at=excluded.next_at,deleted_at=NULL,config_json=excluded.config_json`).run(id, targetKey, Number(enabled), next, JSON.stringify(config));
    return this.get(id)!;
  }

  delete(id: string, expectedRevision: number, now: number): void {
    assert(this.get(id)?.revision === expectedRevision, 'CONFIG_CONFLICT', '计划配置已变化', { id });
    this.db.prepare('UPDATE cron_jobs SET deleted_at=?,enabled=0,next_at=NULL,revision=revision+1 WHERE id=?').run(now, id);
  }

  disableAll(): void {
    this.db.prepare('UPDATE cron_jobs SET enabled=0,next_at=NULL,revision=revision+1 WHERE enabled=1').run();
  }

  claim(job: Job, now: number, trigger: Trigger, retryOf?: string): string | undefined {
    return this.transaction(() => {
      const fresh = this.get(job.id);
      if (!fresh || fresh.revision !== job.revision) return undefined;
      let slot: number | null = null;
      if (trigger === 'scheduled') {
        if (!fresh.enabled || fresh.nextRunAt === null || fresh.nextRunAt > now) return undefined;
        slot = latestSlot(job.schedule, fresh.nextRunAt, now);
        this.db.prepare('UPDATE cron_jobs SET next_at=? WHERE id=?').run(nextSlot(job.schedule, now), job.id);
      }
      const id = randomUUID();
      const result = this.db.prepare(`INSERT INTO cron_runs(id,job_id,slot,trigger,status,started_at,job_json,retry_of)
        VALUES (?,?,?,?,'running',?,?,?) ON CONFLICT(job_id,slot) DO NOTHING`).run(id, job.id, slot, trigger, now, JSON.stringify(job), retryOf ?? null);
      return result.changes === 1 ? id : undefined;
    });
  }

  finish(id: string, status: RunState, summary: Record<string, unknown>, now: number) {
    this.db.prepare('UPDATE cron_runs SET status=?,summary_json=?,finished_at=? WHERE id=? AND status=\'running\'').run(status, JSON.stringify(summary), now, id);
    return this.run(id)!;
  }

  recover(now: number): void {
    this.db.prepare("UPDATE cron_runs SET status='interrupted',finished_at=?,summary_json=? WHERE status='running'")
      .run(now, JSON.stringify({ code: 'SERVICE_INTERRUPTED' }));
  }

  run(id: string) {
    const row = this.db.prepare('SELECT * FROM cron_runs WHERE id=?').get(id) as RunRow | undefined;
    return row && runOf(row);
  }

  runs(jobId: string | undefined, offset: number, limit: number) {
    const filter = 'WHERE (? IS NULL OR job_id=?)';
    const bindings = [jobId ?? null, jobId ?? null] as const;
    const items = (this.db.prepare(`SELECT * FROM cron_runs ${filter} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`).all(...bindings, limit, offset) as RunRow[]).map(runOf);
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM cron_runs ${filter}`).get(...bindings)?.total);
    return { items, total };
  }
}
