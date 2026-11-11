import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openApplication } from '../../../dist/index.js';

// 独立反证只使用合成临时库；所有fetch在请求前拒绝。
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error('NETWORK_DISABLED'); };
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(os.tmpdir(), 'kb-project-independent-'));
const dataDir = path.join(root, 'data'); const passed = [];
let app;
async function tree() { const out = {}; for (const entry of await readdir(dataDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const full = path.join(entry.parentPath, entry.name); out[path.relative(dataDir, full)] = createHash('sha256').update(await readFile(full)).digest('hex'); } return out; }
try {
  app = await openApplication(dataDir);
  const execute = (name, input = {}) => app.plugins.execute(`project-track ${name}`, input);
  const file = path.join(root, 'note.md'); const original = '\uFEFF# Original\r\n Cache historical正文\r\n\r\n'; await writeFile(file, original);
  const { resource } = await app.manager.importResource(file);
  const project = await execute('create', { name: 'Independent' });
  const supplied = { projectId: project.id, resourceId: resource.id, title: 'Baseline', role: 'baseline', projectVersion: '1.2.0', stage: 'verified', requestId: 'stable-request', recordedAt: '2030-01-01T00:00:00Z' };
  const first = await execute('add', supplied);
  await writeFile(file, '# Updated latest'); await app.manager.updateResource(resource.id, file);
  const replay = await execute('add', supplied); assert.equal(replay.replayed, true); assert.equal(replay.entry.id, first.entry.id); assert.equal(replay.entry.contentVersion, 1);
  await assert.rejects(execute('add', { ...supplied, title: 'Different' }), error => error.code === 'PROJECT_REQUEST_CONFLICT');
  passed.push('requestId replay before dynamic currentVersion; explicit conflict');
  const old = await execute('add', { projectId: project.id, resourceId: resource.id, contentVersion: 1, title: 'Pinned old', role: 'change', projectVersion: '1.3.0', stage: 'implemented' });
  assert.equal(old.entry.snapshot.tags.status, 'unknown'); assert.equal(old.entry.snapshot.originalNameKnown, false);
  const planned = await execute('add', { projectId: project.id, resourceId: resource.id, title: 'Planned baseline', role: 'baseline', projectVersion: '1.10.0', stage: 'planned', recordedAt: '2020-01-01T00:00:00Z', replaces: { entryIds: [first.entry.id], scope: 'layout', effect: 'proposal' } });
  const full = await execute('query', { projectId: project.id, limit: 20 }); assert.equal(full.total, 3); assert.equal(full.baselineEntryId, planned.entry.id); assert.equal(full.items[0].entry.stage, 'planned'); assert.equal(full.items.find(item => item.entry.id === first.entry.id).text, original);
  const prior = await execute('query', { projectId: project.id, asOfVersion: '1.2.0' }); assert.equal(prior.total, 1); assert.equal(prior.baselineEntryId, first.entry.id); assert.deepEqual(prior.items[0].replacement.replacedBy, []);
  passed.push('numeric version before date; planned baseline explicit; historical/asOf replacement preserved');
  await Promise.all(Array.from({ length: 8 }, (_, index) => execute('add', { projectId: project.id, resourceId: resource.id, title: `Parallel ${index}`, role: 'change', projectVersion: `1.11.${index}`, stage: 'planned', requestId: `parallel-${index}` })));
  const all = await execute('documents', { projectId: project.id, limit: 20 }); assert.equal(all.total, 11); assert.equal(new Set(all.items.map(item => item.entry.id)).size, 11);
  const other = await execute('create', { name: 'Other' }); await assert.rejects(execute('read', { projectId: other.id, entryId: first.entry.id }), error => error.code === 'NOT_FOUND');
  passed.push('parallel append no lost entries; cross-project entry read denied');
  await app.manager.updatePluginMeta(resource.id, 'content', { future: true }, { schemaVersion: 99 });
  assert.equal((await execute('read', { projectId: project.id, entryId: first.entry.id })).text, original);
  passed.push('registered pin reads exact raw original independently from future current derived meta');
  const beforeRead = await tree(); const reader = await openApplication(dataDir, { readOnly: true });
  try { assert.equal((await reader.plugins.execute('project-track documents', { projectId: project.id })).total, 11); assert.equal((await reader.plugins.execute('project-track read', { projectId: project.id, entryId: first.entry.id })).text, original); } finally { await reader.close(); }
  assert.deepEqual(await tree(), beforeRead);
  passed.push('readonly queries while writer holds lock leave all files unchanged');
  await app.manager.deleteResource(resource.id); await assert.rejects(app.manager.purgeResource(resource.id), error => error.code === 'REFERENCED');
  const backup = path.join(root, 'project-backup.json'); await app.manager.backup(backup); assert.equal((await execute('read', { projectId: project.id, entryId: first.entry.id })).text, original);
  passed.push('soft deleted current resource still reads pinned history and cannot purge');
  await app.close(); app = null;
  const restoredDir = path.join(root, 'restored'); const { CoreManager } = await import('../../../dist/core/manager.js'); const restorer = await CoreManager.open(restoredDir); try { await restorer.restore(backup); } finally { await restorer.close(); }
  const restored = await openApplication(restoredDir, { readOnly: true }); try { const replayed = await restored.plugins.execute('project-track get', { projectId: project.id }); assert.equal(replayed.data.entries.length, 11); assert.equal((await restored.plugins.execute('project-track read', { projectId: project.id, entryId: first.entry.id })).text, original); } finally { await restored.close(); }
  passed.push('backup/restore preserves immutable pins and references');
  const preload = path.join(root, 'network-disabled.cjs'); await writeFile(preload, "globalThis.fetch=async()=>{throw new Error('NETWORK_DISABLED')};");
  const invalid = spawnSync(process.execPath, [path.join(repository, 'dist/cli/main.js'), 'project-track', 'query', '--data-dir', dataDir, '--input', '-', '--json'], { input: JSON.stringify({ projectId: project.id, includeBaseline: 'garbage' }), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } });
  const invalidJson = JSON.parse(invalid.stdout); assert.equal(invalidJson.ok, false); assert.equal(invalid.status, 2); assert.equal(invalidJson.error.code, 'INVALID_ARGUMENT');
  process.stdout.write(JSON.stringify({ passed, checks: passed.length, invalidParameterExitCode: invalid.status, invalidParameterCode: invalidJson.error.code, networkRequests, temporaryDirectoryRemoved: true }, null, 2) + '\n');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
