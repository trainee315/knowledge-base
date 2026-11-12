import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert, KnowledgeError } from '../core/errors.js';

const SERVICE_SCHEMA_VERSION = 1;
const TABLES = {
  service_settings: ['key', 'value'],
  cron_meta: ['key', 'value'],
  cron_jobs: ['id', 'target_key', 'enabled', 'revision', 'next_at', 'deleted_at', 'config_json'],
  cron_runs: ['id', 'job_id', 'slot', 'trigger', 'status', 'started_at', 'finished_at', 'job_json', 'summary_json', 'retry_of'],
} as const;
type Table = keyof typeof TABLES;
type Value = string | number | null;
type Rows = Record<Table, Record<string, Value>[]>;
export interface ServiceSnapshot { schemaVersion: 1; tables: Rows }

export async function openServiceDatabase(dataDir: string): Promise<DatabaseSync> {
  const filename = resolve(dataDir, 'service.sqlite');
  for (const file of [filename, filename + '-journal', filename + '-wal', filename + '-shm']) {
    try {
      const info = await lstat(file);
      assert(info.isFile() && !info.isSymbolicLink(), 'UNSAFE_PATH', '服务数据库文件不能是链接或目录', { file });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try { await (await open(filename, 'wx', 0o600)).close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    db.exec('CREATE TABLE IF NOT EXISTS service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    const version = db.prepare("SELECT value FROM service_settings WHERE key='schemaVersion'").get()?.value;
    if (version === undefined) db.prepare('INSERT INTO service_settings VALUES (?,?)').run('schemaVersion', String(SERVICE_SCHEMA_VERSION));
    else assert(version === String(SERVICE_SCHEMA_VERSION), 'SERVICE_SCHEMA_UNSUPPORTED', '服务数据库版本不支持');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getServicePort(db: DatabaseSync): number {
  const port = Number(db.prepare("SELECT value FROM service_settings WHERE key='port'").get()?.value ?? 0);
  assert(Number.isInteger(port) && port >= 0 && port <= 65_535, 'SERVICE_CONFIG_INVALID', '服务数据库端口无效');
  return port;
}

export function setServicePort(db: DatabaseSync, port: number): void {
  db.prepare('INSERT INTO service_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('port', String(port));
}

export function snapshotServiceDatabase(db: DatabaseSync): ServiceSnapshot {
  const tables = {} as Rows;
  for (const table of Object.keys(TABLES) as Table[]) {
    tables[table] = db.prepare('SELECT ' + TABLES[table].join(',') + ' FROM ' + table + ' ORDER BY 1').all() as Rows[Table];
  }
  return { schemaVersion: 1, tables };
}

/** 用同一套列白名单预检和恢复，备份内容始终作为参数绑定。 */
export function loadServiceSnapshot(db: DatabaseSync, input: unknown, validateOnly = false, validateCron?: () => void): void {
  const snapshot = input as Partial<ServiceSnapshot> | null;
  assert(snapshot?.schemaVersion === 1 && snapshot.tables && Object.keys(snapshot.tables).length === Object.keys(TABLES).length, 'INVALID_BACKUP', '服务备份结构不支持');
  const tables = Object.keys(TABLES) as Table[];
  db.exec('SAVEPOINT service_restore; PRAGMA defer_foreign_keys = ON;');
  try {
    for (const table of [...tables].reverse()) db.exec('DELETE FROM ' + table);
    for (const table of tables) {
      const columns = TABLES[table];
      const rows = snapshot.tables[table];
      assert(Array.isArray(rows), 'INVALID_BACKUP', '服务备份表缺失', { table });
      const stmt = db.prepare('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
      for (const row of rows) {
        assert(row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === columns.length, 'INVALID_BACKUP', '服务备份行结构无效', { table });
        const values = columns.map(column => row[column]);
        assert(values.every(value => value === null || typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)), 'INVALID_BACKUP', '服务备份值无效', { table });
        stmt.run(...values as SQLInputValue[]);
      }
    }
    assert(db.prepare("SELECT value FROM service_settings WHERE key='schemaVersion'").get()?.value === String(SERVICE_SCHEMA_VERSION), 'INVALID_BACKUP', '服务备份版本不支持');
    getServicePort(db);
    assert(!db.prepare('PRAGMA foreign_key_check').get(), 'INVALID_BACKUP', '服务备份引用不完整');
    validateCron?.();
    if (validateOnly) db.exec('ROLLBACK TO service_restore');
    db.exec('RELEASE service_restore');
  } catch (error) {
    db.exec('ROLLBACK TO service_restore; RELEASE service_restore');
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('INVALID_BACKUP', '服务数据库备份无法恢复', { reason: (error as Error).message });
  }
}
