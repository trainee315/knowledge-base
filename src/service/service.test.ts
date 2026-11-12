import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const cli = fileURLToPath(new URL('../cli/main.js', import.meta.url));

function command(dataDir: string, args: string[], input?: Buffer): any {
  const result = spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir, '--json'], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
}

test('service preserves stdin bytes and backs up and restores cron retry history', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'knowledge-service-'));
  const source = resolve(root, 'source');
  const destination = resolve(root, 'destination');
  const snapshot = resolve(root, 'backup.json');
  try {
    const started = command(source, ['service', 'start']);
    const alias = command(source, ['preview', 'start']);
    assert.equal(alias.pid, started.pid);
    assert.match(alias.notice, /共享/);
    assert.equal((await fetch(started.url + '/_control/status')).status, 403);
    assert.equal((await fetch(started.url + '/api/plugins', { headers: { Origin: 'https://example.test' } })).status, 403);

    const body = Buffer.from('\uFEFF# 测试\r\n原文\r\n');
    const note = command(source, ['note', 'add', '--stdin'], body);
    const downloaded = await fetch(started.url + '/api/resources/' + note.resourceId + '/file');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), body);
    command(source, ['schedule', 'run']);
    const runs = command(source, ['cron', 'runs']).items;
    assert.equal(runs.length, 1);
    command(source, ['service', 'stop']);

    // 令重试记录按 ID 先于父记录，覆盖恢复外键校验顺序。
    const retryId = '00000000-0000-4000-8000-000000000001';
    const db = new DatabaseSync(resolve(source, 'service.sqlite'));
    try {
      db.prepare(`INSERT INTO cron_runs (id,job_id,slot,trigger,status,started_at,finished_at,job_json,summary_json,retry_of)
        SELECT ?,job_id,NULL,'retry','failed',started_at,finished_at,job_json,summary_json,id FROM cron_runs WHERE id=?`).run(retryId, runs[0].id);
    } finally { db.close(); }

    const restarted = command(source, ['service', 'restart']);
    assert.ok(restarted.running);
    command(source, ['backup', '--file', snapshot]);
    command(destination, ['service', 'start']);
    command(destination, ['restore', '--file', snapshot]);
    const restored = command(destination, ['cron', 'runs']).items;
    assert.equal(restored.length, 2);
    assert.equal(restored.find((item: { id: string }) => item.id === retryId)?.retryOf, runs[0].id);
    assert.equal(command(destination, ['cron', 'list']).items[0].enabled, false);
    assert.equal(command(destination, ['note', 'get', '--id', note.resourceId]).content, body.toString('utf8'));
  } finally {
    try { command(source, ['service', 'stop']); } finally { command(destination, ['service', 'stop']); }
    await rm(root, { recursive: true, force: true });
  }
});
