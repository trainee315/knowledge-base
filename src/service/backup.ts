import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreManager } from '../core/manager.js';
import { assert, KnowledgeError } from '../core/errors.js';
import type { JsonObject } from '../contracts/index.js';
import { loadServiceSnapshot, snapshotServiceDatabase } from './database.js';
import type { createCronService } from './cron-service.js';

type Cron = Awaited<ReturnType<typeof createCronService>>;
const STORE = 'service';
const KEY = 'restore-pending';

function inside(root: string, target: string): boolean {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? target.toLowerCase() : target;
  return b === a || b.startsWith(a + sep);
}

/** 文件恢复标记和文件事务一起提交，重启可补写 SQLite。 */
async function finishRestore(dataDir: string, db: DatabaseSync, cron: Cron): Promise<boolean> {
  const manager = await CoreManager.open(dataDir);
  let pending: { snapshot?: unknown } | null;
  try { pending = await manager.pluginStore(STORE).read<{ snapshot?: unknown } | null>(KEY, null); }
  finally { await manager.close(); }
  if (!pending) return false;
  if (pending.snapshot !== undefined) loadServiceSnapshot(db, pending.snapshot, false, cron.validateSnapshot);
  await cron.resume(true, pending.snapshot === undefined);
  const completed = await CoreManager.open(dataDir);
  try { await completed.pluginStore(STORE).remove(KEY); }
  finally { await completed.close(); }
  return true;
}

export { finishRestore };

export async function backupRestore(operation: 'backup' | 'restore', input: Record<string, unknown>, dataDir: string, db: DatabaseSync, cron: Cron): Promise<unknown> {
  const file = input.file;
  if (typeof file !== 'string' || !file.trim()) throw new KnowledgeError('INVALID_ARGUMENT', '参数 file 必须为非空字符串', undefined, 2);
  const absolute = resolve(file);
  const temp = await mkdtemp(resolve(tmpdir(), 'knowledge-backup-'));
  const intermediate = resolve(temp, 'files.json');
  let pendingRecovery = false;
  try {
    await cron.suspend();
    if (operation === 'backup') {
      assert(!inside(dataDir, absolute), 'INVALID_BACKUP_PATH', '备份文件不能放入数据目录内部');
      await mkdir(dirname(absolute), { recursive: true });
      assert(!inside(dataDir, await realpath(dirname(absolute))), 'INVALID_BACKUP_PATH', '备份文件不能放入数据目录内部');
      const manager = await CoreManager.open(dataDir);
      let fileBackup: Record<string, unknown>;
      let files: number;
      let service: ReturnType<typeof snapshotServiceDatabase>;
      try {
        ({ files } = await manager.backup(intermediate));
        fileBackup = JSON.parse(await readFile(intermediate, 'utf8')) as Record<string, unknown>;
        service = snapshotServiceDatabase(db);
      } finally { await manager.close(); }
      await writeFile(absolute, JSON.stringify({ ...fileBackup, schemaVersion: 2, service }, null, 2) + '\n', { flag: 'wx' });
      return { file: absolute, files, serviceSchemaVersion: service.schemaVersion };
    }
    const backup = JSON.parse(await readFile(absolute, 'utf8')) as { schemaVersion?: unknown; entries?: unknown; service?: unknown };
    assert(backup && (backup.schemaVersion === 1 || backup.schemaVersion === 2) && Array.isArray(backup.entries), 'INVALID_BACKUP', '备份结构不支持');
    if (backup.schemaVersion === 2) loadServiceSnapshot(db, backup.service, true, cron.validateSnapshot);
    assert(!db.prepare('SELECT 1 FROM cron_jobs LIMIT 1').get(), 'RESTORE_NOT_EMPTY', '恢复要求目标没有调度计划');
    const manager = await CoreManager.open(dataDir);
    let result: { files: number };
    try {
      await writeFile(intermediate, JSON.stringify({ schemaVersion: 1, entries: backup.entries }), { flag: 'wx' });
      result = await manager.restore(intermediate, (backup.schemaVersion === 2 ? { snapshot: backup.service } : {}) as JsonObject);
      pendingRecovery = true;
    } finally { await manager.close(); }
    await finishRestore(dataDir, db, cron);
    pendingRecovery = false;
    return result;
  } catch (error) {
    if (pendingRecovery) throw new KnowledgeError('RESTORE_RECOVERY_REQUIRED', '文件已恢复，需重启服务完成调度数据库恢复', { reason: (error as Error).message });
    throw error;
  } finally {
    try { if (!pendingRecovery) await cron.resume(); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}
