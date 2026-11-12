import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoreManager, openApplication } from '../../index.js';
import { transcriptCommand } from '../../records/transcript.js';
import type { Organization } from '../../contracts/index.js';
import { createCronService } from '../../service/cron-service.js';
import { CronStore, type Job } from './store.js';
import { scheduleOf } from './plan.js';
import { ORGANIZE, TRANSCRIBE } from './tasks.js';

test('claims coalesce missed occurrences and recover interrupted runs without replay', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CronStore(db);
    const now = Date.parse('2026-11-12T07:00:00Z');
    const schedule = scheduleOf({ kind: 'cron', expression: '*/5 * * * *', timezone: 'Asia/Shanghai' });
    const plan = store.save('test-job', ORGANIZE, { taskType: ORGANIZE, params: {}, schedule }, true, now, undefined, now - 900_000);
    const id = store.claim(plan, now, 'scheduled')!;
    assert.equal(store.run(id)?.scheduledAt, now);
    assert.equal(store.get(plan.id)?.nextRunAt, now + 300_000);
    assert.equal(store.claim(plan, now, 'scheduled'), undefined);
    store.recover(now + 50);
    assert.equal(store.run(id)?.status, 'interrupted');
    assert.equal(store.claim(plan, now + 50, 'scheduled'), undefined);
    const retry = store.claim(plan, now + 50, 'retry', id)!;
    assert.equal(store.run(retry)?.retryOf, id);
    store.delete(plan.id, plan.revision, now + 100);
    assert.equal(store.runs(plan.id, 0, 50).total, 2);
  } finally { db.close(); }
});

test('legacy interval migration, expression compatibility, and plugin disable use one authority', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-cron-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  let service: Awaited<ReturnType<typeof createCronService>> | undefined;
  t.after(async () => { await service?.stop(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const original = await transcriptCommand(dataDir, 'create', { alias: 'initial', startDate: '2026-01-01', projectDir: dataDir, intervalMinutes: 45 }) as Organization;
  const first = Date.now() + 86_400_000;
  const before = await CoreManager.open(dataDir);
  try { await before.updateOrganization(original.id, { data: { ...original.data, config: { ...(original.data.config as object), enabled: true }, nextDue: first } }); }
  finally { await before.close(); }
  let calls = 0;
  const dispatch = async (words: string[], input: Record<string, unknown>) => {
    if (words[0] === 'transcript') return transcriptCommand(dataDir, words[1], input);
    if (words[0] === 'organize') { calls++; return { complete: true }; }
    if (words[0] === 'plugin') {
      const app = await openApplication(dataDir);
      try { return await app.plugins.setEnabled(String(input.id), words[1] === 'enable'); }
      finally { await app.close(); }
    }
    assert.fail(`unexpected dispatch ${words.join(' ')}`);
  };
  service = await createCronService({ db, dataDir, dispatch });
  service.start();
  const issue = async (group: string, action: string, input = {}) => (await service!.command([group, action], input)).data;
  const plans = await issue('cron', 'list') as { items: Job[] };
  assert.equal(plans.items.length, 1, 'empty library defaults must not silently create an organizer plan');
  const job = plans.items[0];
  assert.equal(job.taskType, TRANSCRIBE);
  assert.deepEqual(job.schedule, { kind: 'interval', minutes: 45 });
  assert.equal(job.nextRunAt, first);
  const changed = await issue('cron', 'update', { id: job.id, expectedRevision: job.revision, schedule: { kind: 'cron', expression: '0 7 * * *' } }) as Job;
  await assert.rejects(issue('transcript', 'configure', { id: original.id, expectedCronRevision: job.revision, intervalMinutes: 45 }), { code: 'REVISION_CONFLICT' });
  const renamed = await issue('transcript', 'configure', { id: original.id, alias: 'renamed', enabled: true, intervalMinutes: null, expectedCronRevision: changed.revision }) as Organization;
  assert.equal(renamed.name, 'renamed');
  assert.deepEqual(renamed.data.cronSchedule, changed.schedule);
  await issue('transcript', 'configure', { id: original.id, enabled: false });
  assert.equal((await issue('cron', 'get', { id: job.id }) as Job).enabled, false);
  assert.deepEqual((await issue('cron', 'get', { id: job.id }) as Job).schedule, changed.schedule);

  const intent = await CoreManager.open(dataDir);
  try {
    const org = await intent.getOrganization(original.id);
    await intent.updateOrganization(org.id, { name: 'saved-before-sql' }, org.revision, { operationId: randomUUID(), enabled: false, schedule: { kind: 'interval', minutes: 20 } });
  } finally { await intent.close(); }
  await service.stop();
  service = await createCronService({ db, dataDir, dispatch });
  service.start();
  assert.deepEqual((await issue('cron', 'get', { id: job.id }) as Job).schedule, { kind: 'interval', minutes: 20 });
  await issue('transcript', 'configure', { id: original.id, enabled: false, intervalMinutes: null });
  await assert.rejects(issue('cron', 'get', { id: job.id }), { code: 'NOT_FOUND' });

  const organizer = await issue('cron', 'create', { taskType: ORGANIZE, schedule: { kind: 'interval', minutes: 1 }, enabled: true }) as Job;
  await issue('plugin', 'disable', { id: 'cron' });
  assert.equal(service.status().enabled, false);
  assert.deepEqual(await issue('schedule', 'tick', { now: new Date(Date.now() + 120_000).toISOString() }), { triggered: false, reason: 'disabled' });
  await assert.rejects(issue('cron', 'run', { id: organizer.id }), { code: 'PLUGIN_UNAVAILABLE' });
  assert.equal(calls, 0);
  await issue('organize', 'run');
  await issue('schedule', 'run');
  assert.equal(calls, 2);
});
