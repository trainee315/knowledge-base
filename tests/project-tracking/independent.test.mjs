import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreManager, openApplication } from '../../dist/index.js';
import { createHarness, digest, getNetworkAttempts, libraryFingerprint } from './helpers.mjs';

const fields = { role: 'change', projectVersion: '0.0.2', stage: 'verified' };
const add = (h, projectId, resource, options = {}) => h.project.add({ ...fields, projectId, resourceId: resource.id, title: resource.originalName, ...options });
const create = (h, name = 'Synthetic project') => h.project.create({ name, description: 'Independent synthetic verification' });
const baseline = (h, projectId, resource, options = {}) => add(h, projectId, resource, { role: 'baseline', projectVersion: '0.0.1', tags: [], ...options });

test('MD/TXT/JSON full text preserves BOM, CRLF, Unicode and whitespace; invalid inputs leave no project writes', async () => {
  const h = await createHarness();
  try {
    const project = await create(h);
    for (const [index, extension, text] of [
      [0, 'md', '\uFEFF  \r\n# 原文🧪\r\n\r\n末尾空白  \r\n'],
      [1, 'txt', '\uFEFF\r\n  Unicode Ω 中文  \r\n tail \r\n'],
      [2, 'json', '\uFEFF \r\n{ "z": 2,\r\n  "a" : "原始格式🧪" } \r\n  '],
    ]) {
      const bytes = Buffer.from(text); const resource = await h.import(`original-${index}.${extension}`, bytes);
      const result = index === 0 ? await baseline(h, project.id, resource) : await add(h, project.id, resource, { projectVersion: `0.0.${index + 1}`, tags: [] });
      const document = await h.project.read({ projectId: project.id, entryId: result.entry.id });
      assert.equal(document.text, text); assert.deepEqual(Buffer.from(document.text), bytes);
      assert.equal(result.entry.contentHash, digest(bytes)); assert.equal(result.entry.snapshot.format, `.${extension}`);
      assert.equal((await h.apis.content.readVersion(resource.id, 1)).rawText, text);
    }
    for (const [filename, bytes] of [['bad.txt', Buffer.from([0xc3, 0x28])], ['bad.json', Buffer.from('{"unfinished":')], ['opaque.bin', Buffer.from([0, 255, 1])]]) {
      const resource = await h.import(filename, bytes);
      const before = await h.project.get(project.id);
      await assert.rejects(add(h, project.id, resource, { projectVersion: '0.1.0', tags: [] }));
      assert.deepEqual(await h.project.get(project.id), before);
      assert.deepEqual(await h.manager.readContent(resource.id), bytes);
    }
  } finally { await h.cleanup(); }
});

test('fixed JSON history ignores misleading current name and cached metadata, survives updates and recycling', async () => {
  const h = await createHarness();
  try {
    const project = await create(h);
    const original = '\uFEFF\r\n{ "topic": "ancestraljson", "version": 1 }  \r\n';
    const second = '\uFEFF  { "topic": "currentjson", "version": 2 }\r\n';
    const resource = await h.import('original.json', original);
    const first = await baseline(h, project.id, resource);
    const originalSnapshot = structuredClone(first.entry.snapshot);
    await h.manager.updateResource(resource.id, await h.source('second.json', second), 1);
    await h.manager.updatePluginMeta(resource.id, 'keywords', { inputVersion: 2, processorVersion: 'fixture', items: [{ value: 'pollutedlatest', weight: 1, source: 'body' }] });
    await h.renameCurrentFixture(resource.id, 'misleading-current.md');
    const derived = await h.apis.content.readVersion(resource.id, 1);
    assert.equal(derived.format, '.json'); assert.equal(derived.rawText, original); assert.equal(derived.originalNameKnown, false);
    assert.equal(derived.filename, 'version-1.json'); assert.equal(derived.contentHash, digest(Buffer.from(original)));
    const historical = await add(h, project.id, resource, { title: 'Historical JSON', contentVersion: 1, projectVersion: '0.0.2' });
    assert.equal(historical.entry.snapshot.tags.status, 'unknown'); assert.equal(historical.entry.snapshot.tags.source, 'unavailable-history');
    assert.equal(historical.entry.snapshot.originalNameKnown, false); assert.equal(historical.entry.snapshot.format, '.json');
    assert.ok(historical.entry.snapshot.keywords.some((word) => word.includes('ancestraljson')));
    assert.equal(historical.entry.snapshot.keywords.some((word) => word.includes('pollutedlatest') || word.includes('misleading')), false);
    const current = await add(h, project.id, resource, { title: 'Current fixed JSON', contentVersion: 2, tags: [], projectVersion: '0.0.3' });
    assert.equal(current.entry.snapshot.tags.status, 'known'); assert.deepEqual(current.entry.snapshot.tags.items, []); assert.equal(current.entry.snapshot.tags.source, 'explicit');
    await h.manager.updateResource(resource.id, await h.source('third.json', '{"topic":"thirdjson","version":3}'), 2);
    assert.equal((await h.project.read({ projectId: project.id, entryId: current.entry.id })).text, second);
    assert.deepEqual((await h.project.read({ projectId: project.id, entryId: first.entry.id })).entry.snapshot, originalSnapshot);
    await h.manager.deleteResource(resource.id);
    assert.equal((await h.project.read({ projectId: project.id, entryId: first.entry.id })).text, original);
    await assert.rejects(h.manager.purgeResource(resource.id), (error) => error.code === 'REFERENCED');
  } finally { await h.cleanup(); }
});

test('tag definitions, aliases, accepted decisions and derived keyword changes cannot rewrite registered snapshots', async () => {
  const h = await createHarness();
  try {
    const tag = await h.host.execute('tag create', { name: 'Original tag', aliases: ['Old Alias'] }, []);
    const resource = await h.import('frozen.txt', 'ancestralkeyword original immutable source');
    await h.host.execute('tag decide', { resourceId: resource.id, tagId: tag.id, accepted: true, source: 'manual', reason: 'Synthetic accepted input', contentVersion: 1, tagRevision: 1 }, []);
    const project = await create(h);
    const saved = await add(h, project.id, resource, { role: 'baseline', projectVersion: '0.0.1' });
    assert.equal(saved.entry.snapshot.tags.status, 'known'); assert.equal(saved.entry.snapshot.tags.source, 'resource-meta');
    const snapshot = structuredClone(saved.entry.snapshot);
    await h.host.execute('tag update', { id: tag.id, name: 'Changed tag', aliases: ['New Alias'] }, []);
    await h.host.execute('tag decide', { resourceId: resource.id, tagId: tag.id, accepted: false, source: 'manual', reason: 'Changed current metadata', contentVersion: 1, tagRevision: 2 }, []);
    await h.manager.updatePluginMeta(resource.id, 'keywords', { inputVersion: 1, processorVersion: 'fixture', items: [{ value: 'pollutedlatest', weight: 1, source: 'body' }] });
    assert.deepEqual((await h.project.read({ projectId: project.id, entryId: saved.entry.id })).entry.snapshot, snapshot);
    assert.equal((await h.project.query({ projectId: project.id, tags: ['Old Alias'] })).total, 1);
    assert.equal((await h.project.query({ projectId: project.id, tags: ['New Alias'] })).total, 0);
    assert.equal((await h.project.query({ projectId: project.id, tags: [tag.id] })).total, 1);
    assert.equal((await h.project.query({ projectId: project.id, keywords: ['ancestralkey'] })).total, 1);
    assert.equal((await h.project.query({ projectId: project.id, keywords: ['pollutedlatest'] })).total, 0);
  } finally { await h.cleanup(); }
});

test('requestId replays before default CV, tags and now are re-evaluated; replacement and project boundaries stay explicit', async () => {
  const h = await createHarness();
  try {
    const project = await create(h); const other = await create(h, 'Other project');
    const resource = await h.import('idempotent.txt', 'first immutable text');
    await assert.rejects(add(h, project.id, resource)); assert.equal((await h.project.get(project.id)).data.entries.length, 0);
    const payload = { projectId: project.id, resourceId: resource.id, title: 'Idempotent baseline', role: 'baseline', projectVersion: 'v0.0.1', stage: 'verified', requestId: 'baseline-once' };
    const first = await h.project.add(payload); assert.equal(first.replayed, false);
    await h.manager.updateResource(resource.id, await h.source('updated.txt', 'second source text'), 1);
    const tag = await h.host.execute('tag create', { name: 'Later tag', aliases: ['Later alias'] }, []);
    await h.host.execute('tag decide', { resourceId: resource.id, tagId: tag.id, accepted: true, source: 'manual', reason: 'Later context', contentVersion: 2, tagRevision: 1 }, []);
    const before = await libraryFingerprint(h.dataDir);
    const replay = await h.project.add(structuredClone(payload));
    assert.equal(replay.replayed, true); assert.deepEqual(replay.entry, first.entry); assert.deepEqual(await libraryFingerprint(h.dataDir), before);
    await assert.rejects(h.project.add({ ...payload, title: 'Different explicit payload' }));
    assert.deepEqual(await libraryFingerprint(h.dataDir), before);
    const secondProject = await h.project.add({ ...payload, projectId: other.id }); assert.equal(secondProject.replayed, false); assert.notEqual(secondProject.entry.id, first.entry.id);
    const beforeInvalid = await h.project.get(other.id);
    await assert.rejects(add(h, other.id, resource, { replaces: { entryIds: [first.entry.id], scope: 'scope', effect: 'effect' } }));
    await assert.rejects(add(h, other.id, resource, { replaces: { entryIds: [secondProject.entry.id], scope: '', effect: 'effect' } }));
    assert.deepEqual(await h.project.get(other.id), beforeInvalid);
    await assert.rejects(baseline(h, project.id, resource, { projectVersion: '0.0.2' }));
    const replacing = await baseline(h, project.id, resource, { projectVersion: '0.0.2', replaces: { entryIds: [first.entry.id], scope: 'Baseline correction', effect: 'Explicit new baseline' } });
    assert.ok(replacing.entry.id); assert.equal((await h.project.get(project.id)).data.entries.length, 2);
  } finally { await h.cleanup(); }
});

test('concurrent append and duplicate requestId races neither lose entries nor create duplicate documents', async () => {
  const h = await createHarness();
  try {
    const project = await create(h), resource = await h.import('concurrent.txt', 'same reusable immutable bytes');
    await baseline(h, project.id, resource);
    await Promise.all(Array.from({ length: 8 }, (_, index) => add(h, project.id, resource, { title: `Concurrent ${index}`, projectVersion: `0.0.${index + 2}`, requestId: `parallel-${index}` })));
    assert.equal((await h.project.get(project.id)).data.entries.length, 9);
    const payload = { projectId: project.id, resourceId: resource.id, title: 'Same concurrent request', ...fields, projectVersion: '0.1.0', requestId: 'same-race' };
    const results = await Promise.all(Array.from({ length: 8 }, () => h.project.add(structuredClone(payload))));
    assert.equal(new Set(results.map((value) => value.entry.id)).size, 1);
    assert.equal(results.filter((value) => !value.replayed).length, 1);
    assert.equal((await h.project.get(project.id)).data.entries.length, 10);
  } finally { await h.cleanup(); }
});

test('version-first ordering, full-body pagination, baseline context and asOf replacement annotations are independent of filtering', async () => {
  const h = await createHarness();
  try {
    const project = await create(h);
    const baseResource = await h.import('baseline.txt', 'baseline complete context\r\n');
    const base = await baseline(h, project.id, baseResource, { recordedAt: '2035-01-01T00:00:00Z' });
    const filterTag = await h.host.execute('tag create', { name: 'Matching tag' }, []);
    const views = new Map();
    for (const version of [2, 3, 4, 5, 6, 7, 8, 10]) {
      const body = `\uFEFF  \r\n${version === 2 ? 'oldneedle' : 'otherneedle'} version ${version}\r\n` + '全文不得截断🧪\r\n'.repeat(2000) + '  trailing \r\n';
      const resource = await h.import(`long-${version}.txt`, body);
      const result = await add(h, project.id, resource, { projectVersion: `0.0.${version}`, recordedAt: version === 10 ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z', tags: [filterTag.id], ...(version === 10 ? { replaces: { entryIds: [views.get(2).entry.id], scope: 'Synthetic correction', effect: 'Do not auto-merge history' } } : {}) });
      views.set(version, { entry: result.entry, body });
    }
    const page = await h.project.query({ projectId: project.id });
    assert.equal(page.limit, 5); assert.equal(page.items.length, 5); assert.equal(page.total, 9); assert.equal(page.hasMore, true);
    assert.equal(page.items[0].entry.projectVersion, '0.0.10'); assert.equal(page.items[0].text, views.get(10).body);
    assert.equal(page.baseline.entry.id, base.entry.id); assert.equal(page.baseline.text, 'baseline complete context\r\n');
    const tail = await h.project.query({ projectId: project.id, offset: 5, limit: 5 });
    assert.equal(tail.items.length, 4); assert.equal(tail.hasMore, false); assert.equal(tail.baseline, null); assert.equal(tail.baselineEntryId, base.entry.id);
    for (const item of [...page.items, ...tail.items]) if (item.entry.id !== base.entry.id) assert.equal(item.text, views.get(Number(item.entry.projectVersion.split('.')[2])).body);
    const matched = await h.project.query({ projectId: project.id, tags: ['Matching tag', 'does-not-exist'], keywords: ['oldneedle', 'no-hit'], limit: 1 });
    assert.equal(matched.total, 1); assert.equal(matched.items.length, 1); assert.equal(matched.baseline, null);
    assert.equal(matched.items[0].replacement.replacedBy[0].entryId, views.get(10).entry.id);
    const old = await h.project.query({ projectId: project.id, asOfVersion: '0.0.2', tags: [filterTag.id], keywords: ['oldneedle'], includeBaseline: true });
    assert.equal(old.total, 1); assert.equal(old.items[0].replacement.replacedBy.length, 0); assert.equal(old.baseline.entry.id, base.entry.id);
    const onlyBaseline = await h.project.query({ projectId: project.id, asOfVersion: '0.0.1' });
    assert.equal(onlyBaseline.items.length, 1); assert.equal(onlyBaseline.baseline, null); assert.equal(onlyBaseline.baselineEntryId, base.entry.id);
    await assert.rejects(h.project.read({ projectId: project.id, entryId: views.get(10).entry.id, asOfVersion: '0.0.2' }));
    await assert.rejects(h.project.query({ projectId: project.id, limit: 21 }));
    const documents = await h.project.documents({ projectId: project.id }); assert.equal(Object.hasOwn(documents.items[0], 'text'), false);
  } finally { await h.cleanup(); }
});

test('backup restores pinned recycled history and future project schema fails without downgrade', async () => {
  const h = await createHarness(); let restored;
  try {
    const project = await create(h), resource = await h.import('history.txt', '\uFEFF old complete text \r\n');
    const first = await baseline(h, project.id, resource);
    await h.manager.updateResource(resource.id, await h.source('history-v2.txt', 'new text\r\n'), 1);
    await add(h, project.id, resource, { contentVersion: 2, tags: [], projectVersion: '0.0.2' });
    await h.manager.deleteResource(resource.id);
    const backup = join(h.root, 'history.backup.json'); await h.manager.backup(backup);
    const restoredDir = join(h.root, 'restored'); const restoreManager = await CoreManager.open(restoredDir);
    try { await restoreManager.restore(backup); } finally { await restoreManager.close(); }
    restored = await openApplication(restoredDir, { readOnly: true });
    const read = await restored.plugins.execute('project-track read', { projectId: project.id, entryId: first.entry.id }, []);
    assert.equal(read.text, '\uFEFF old complete text \r\n'); assert.equal(read.entry.contentHash, first.entry.contentHash);
    assert.equal((await restored.manager.check()).valid, true); await restored.close(); restored = undefined;
    await h.close(); const file = join(h.dataDir, 'organizations', `${project.id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8')); raw.data.schemaVersion = 999; await writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    const before = await libraryFingerprint(h.dataDir);
    await h.open(true); await assert.rejects(h.project.get(project.id)); await assert.rejects(h.project.query({ projectId: project.id }));
    assert.deepEqual(await libraryFingerprint(h.dataDir), before);
  } finally { await restored?.close(); await h.cleanup(); }
});

test('fixed CLI query/read work while writer holds lock and perform no business writes or network', async () => {
  const h = await createHarness();
  try {
    const project = await create(h), body = '\uFEFF CLI full-body \r\n' + '完整页面'.repeat(3000) + ' tail  \r\n';
    const resource = await h.import('cli.txt', body); const saved = await baseline(h, project.id, resource);
    const before = await libraryFingerprint(h.dataDir);
    for (const [operation, input] of [['query', { projectId: project.id }], ['read', { projectId: project.id, entryId: saved.entry.id }]]) {
      const child = spawnSync(process.execPath, ['--import', new URL('../agent/offline-fetch.mjs', import.meta.url).href, fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url)), 'project-track', operation, '--data-dir', h.dataDir, '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(child.status, 0, child.stdout); const response = JSON.parse(child.stdout); assert.equal(response.ok, true);
      assert.equal(operation === 'read' ? response.data.text : response.data.items[0].text, body);
      assert.match(child.stderr, /KB_OFFLINE_REQUEST_COUNT:0/);
    }
    assert.deepEqual(await libraryFingerprint(h.dataDir), before); assert.equal(getNetworkAttempts(), 0);
  } finally { await h.cleanup(); }
});

test('calendar-invalid or timezone-free dates and unsafe version integers fail without project writes', async () => {
  const h = await createHarness();
  try {
    const project = await create(h), resource = await h.import('strict-input.txt', 'strict synthetic input');
    await baseline(h, project.id, resource); const before = await h.project.get(project.id);
    for (const recordedAt of ['2026-02-30T12:00:00Z', '2026-11-11T04:00:00', '2026-11-11']) {
      await assert.rejects(add(h, project.id, resource, { recordedAt }));
      assert.deepEqual(await h.project.get(project.id), before);
    }
    await assert.rejects(add(h, project.id, resource, { projectVersion: '9007199254740992.0.0' }));
    await assert.rejects(h.project.query({ projectId: project.id, asOfVersion: '0.9007199254740992.0' }));
    assert.deepEqual(await h.project.get(project.id), before);
  } finally { await h.cleanup(); }
});
