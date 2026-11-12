import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoreManager } from '../core/manager.js';
import { backupRestore, finishRestore } from './backup.js';
import { createCronService } from './cron-service.js';

test('file restore with a durable journal keeps cron paused until recovery completes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-restore-interrupted-'));
  const file = join(root, 'backup.json');
  const dataDir = join(root, 'destination');
  const db = new DatabaseSync(':memory:');
  let cron: Awaited<ReturnType<typeof createCronService>> | undefined;
  t.after(async () => { await cron?.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  const source = await CoreManager.open(join(root, 'source'));
  let organizationId: string;
  try {
    organizationId = (await source.createOrganization({ type: 'sample', name: '恢复事务样本' })).id;
    await source.backup(file);
  } finally { await source.close(); }

  cron = await createCronService({ dataDir, db, dispatch: async () => assert.fail('no task should run during restore') });
  cron.start();
  const open = CoreManager.open.bind(CoreManager);
  let inject = true;
  t.mock.method(CoreManager, 'open', (dir: string, options?: Parameters<typeof CoreManager.open>[1]) => {
    if (inject && dir === dataDir && !options?.readOnly) {
      inject = false;
      return open(dir, { ...options, failAfterWrites: 1 });
    }
    return open(dir, options);
  });
  await assert.rejects(backupRestore('restore', { file }, dataDir, db, cron), { code: 'RESTORE_RECOVERY_REQUIRED' });
  assert.equal(cron.status().suspended, true);
  const reader = await open(dataDir, { readOnly: true });
  try { assert.ok((await reader.storage.files('journal')).some(path => path.endsWith('.json'))); }
  finally { await reader.close(); }

  assert.equal(await finishRestore(dataDir, db, cron), true);
  const recovered = await open(dataDir, { readOnly: true });
  try {
    assert.equal((await recovered.getOrganization(organizationId)).name, '恢复事务样本');
    assert.equal(await recovered.pluginStore('service').read('restore-pending', null), null);
    assert.deepEqual(await recovered.storage.files('journal'), []);
  } finally { await recovered.close(); }
  assert.equal(cron.status().suspended, false);
});
