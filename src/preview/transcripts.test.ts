import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApplication } from '../index.js';
import { transcriptCommand, transcriptDraftPreview } from '../records/transcript.js';
import { createPreviewServer } from './server.js';
import type { Organization } from '../contracts/index.js';

async function snapshot(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(dir: string) {
    try {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const file = join(dir, item.name);
        if (item.isDirectory()) await visit(file);
        else files.push(file + ':' + (await fs.readFile(file)).toString('base64'));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await visit(root);
  return files.sort().join('\n');
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'kb-transcript-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await fs.mkdir(sourceRoot);
  const row = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-01-01T01:00:00Z', type, payload }) + '\n';
  await fs.writeFile(join(sourceRoot, 'session.jsonl'), row('session_meta', { id: 'synthetic-config', cwd: root, source: 'cli' }) + row('event_msg', { type: 'task_started' }) + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请规划修改上限，尚未实施。' }] }) + row('event_msg', { type: 'task_complete' }));
  return { root, dataDir: join(root, 'data'), config: { alias: 'config-demo', startDate: '2025-01-01', sourceRoot, projectDir: root } };
}

test('draft preview and HTTP configuration share CLI state without model calls, support revision conflicts', async t => {
  const fixtureData = await fixture(t);
  const { dataDir, config } = fixtureData;
  const emptyBefore = await snapshot(dataDir);
  const draft = await transcriptDraftPreview(dataDir, { config });
  assert.equal(draft.candidates.length, 1);
  assert.equal(await snapshot(dataDir), emptyBefore);
  const server = await createPreviewServer({ app: await openApplication(dataDir, { readOnly: true }), dataDir, webDir: resolve('dist/web') });
  t.after(() => server.close());
  const request = async (path: string, method = 'GET', body?: unknown, headers = {}) => {
    const response = await fetch(server.url + path, { method, headers: { Origin: server.url, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, result: await response.json() as any };
  };
  assert.equal((await request('/api/transcripts/defaults')).result.data.maxCalls, 0);
  assert.ok(Array.isArray((await request('/api/transcripts/profiles')).result.data));
  assert.equal(await snapshot(dataDir), emptyBefore);
  const created = await request('/api/transcripts', 'POST', { config });
  assert.equal(created.status, 200);
  const id = created.result.data.id;
  assert.equal(created.result.data.status.records, 0);
  assert.equal(created.result.data.tasks, undefined);
  const before = await snapshot(dataDir);
  assert.equal((await request('/api/transcripts/preview', 'POST', { id, config })).result.data.candidates.length, 1);
  assert.equal(await snapshot(dataDir), before);
  const originalRevision = created.result.data.revision;
  const patched = await request('/api/transcripts/' + id, 'PATCH', { expectedRevision: originalRevision, config: { alias: 'renamed', maxCalls: 2 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.result.data.effectiveFrom, undefined);
  assert.equal((await transcriptCommand(dataDir, 'get', { id }) as Organization).name, 'renamed');
  assert.equal((await request('/api/transcripts/' + id, 'PATCH', { expectedRevision: originalRevision, config: { alias: 'stale' } })).status, 409);
  assert.equal((await request('/api/transcripts/' + id, 'PATCH', { config: {} })).status, 400);
  const updated = await transcriptCommand(dataDir, 'configure', { id, focus: '保留验证' }) as Organization;
  assert.equal((await request('/api/transcripts/' + id)).result.data.revision, updated.revision);
  const writer = await openApplication(dataDir);
  try { assert.equal((await request('/api/transcripts/' + id, 'PATCH', { expectedRevision: updated.revision, config: { alias: 'locked' } })).status, 409); }
  finally { await writer.close(); }
});

test('ordinary configuration keeps discovery boundary, scope changes preserve tasks and coverage', async t => {
  const { dataDir, config } = await fixture(t);
  const org = await transcriptCommand(dataDir, 'create', config) as Organization;
  await transcriptCommand(dataDir, 'run', { id: org.id });
  let current = await transcriptCommand(dataDir, 'get', { id: org.id }) as Organization;
  const tasksBefore = JSON.stringify(current.data.tasks);
  for (const patch of [{ alias: 'renamed' }, { maxCalls: 1 }, { profile: 'another', focus: 'summary' }, { enabled: true, intervalMinutes: 60 }]) {
    current = await transcriptCommand(dataDir, 'configure', { id: org.id, ...patch }) as Organization;
    assert.equal(current.data.effectiveFrom, undefined);
  }
  current = await transcriptCommand(dataDir, 'configure', { id: org.id, include: { titleKeywords: ['规划'] } }) as Organization;
  assert.ok(current.data.effectiveFrom);
  assert.equal(JSON.stringify(current.data.tasks), tasksBefore);
  const boundary = current.data.effectiveFrom;
  current = await transcriptCommand(dataDir, 'configure', { id: org.id, enabled: false, projectDir: null, intervalMinutes: null }) as Organization;
  assert.notEqual(current.data.effectiveFrom, undefined);
  const savedBoundary = current.data.effectiveFrom;
  current = await transcriptCommand(dataDir, 'configure', { id: org.id, alias: 'ordinary' }) as Organization;
  assert.equal(current.data.effectiveFrom, savedBoundary);
  const historical = await transcriptDraftPreview(dataDir, { id: org.id, config: { include: {}, projectDir: config.projectDir }, mode: 'backfill', from: '2025-01-01' });
  assert.equal(historical.candidates.length, 1);
  assert.ok(boundary);
  // 旧实例已保存的边界可直接继续使用，不做隐式迁移。
  assert.equal(current.data.schemaVersion, 1);
});

test('configuration HTTP enforces same origin, body limits, errors and active lease, never exposes task material', async t => {
  const { dataDir, config } = await fixture(t);
  const org = await transcriptCommand(dataDir, 'create', config) as Organization;
  const app = await openApplication(dataDir);
  const loaded = await app.manager.getOrganization(org.id);
  loaded.data.lease = { token: 'synthetic-token', expires: Date.now() + 30_000 };
  loaded.data.tasks = [{ id: 'task', status: 'failed', sessionId: 'synthetic-config', messages: [{ content: 'PRIVATE_SYNTHETIC_MARKER' }], error: 'SYNTHETIC_FAILURE' }];
  await app.manager.updateOrganization(org.id, { data: loaded.data }, loaded.revision);
  await app.close();
  const server = await createPreviewServer({ app: await openApplication(dataDir, { readOnly: true }), dataDir, webDir: resolve('dist/web') });
  t.after(() => server.close());
  const url = server.url + '/api/transcripts/' + org.id;
  const patch = JSON.stringify({ expectedRevision: org.revision + 1, config: { alias: 'blocked' } });
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Origin: 'http://untrusted.example', 'Content-Type': 'application/json' }, body: patch })).status, 403);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: patch })).status, 403);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Origin: server.url, 'Content-Type': 'text/plain' }, body: patch })).status, 400);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ focus: 'x'.repeat(140_000) }) })).status, 400);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: patch })).status, 409);
  assert.equal((await fetch(url, { method: 'DELETE', headers: { Origin: server.url } })).status, 405);
  assert.doesNotMatch(await (await fetch(url)).text(), /PRIVATE_SYNTHETIC_MARKER|synthetic-token/);
  assert.doesNotMatch(await (await fetch(server.url + '/api/organizations')).text(), /PRIVATE_SYNTHETIC_MARKER|synthetic-token/);
});
