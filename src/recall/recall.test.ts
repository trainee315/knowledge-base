import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoreManager } from '../core/manager.js';
import { noteCommand } from '../records/note.js';
import { openApplication } from '../index.js';
import { configure, resolveScope, allowed, snapshot } from './scope.js';
import { prepare, recallCommand } from './recall.js';
import { buildIndex, pointer } from './index.js';
import { split } from './fragments.js';
import { TOKENIZER_VERSION, terms } from './fragments.js';
import type { RecallConfig } from './types.js';
import { developmentBusy, runDevelopmentWorkload } from './development.js';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-recall-test-')); const data = path.join(root, 'data'); const app = await openApplication(data); await app.close();
  const add = async (text: string, title: string) => { const result = await noteCommand(data, 'add', { text, title, recordedAt: '2026-11-01T00:00:00+08:00' }, async () => Buffer.alloc(0)) as { resourceId: string }; return result.resourceId; };
  const a = await add('\uFEFF# 战斗设计\r\n\r\n连击窗口为300毫秒。只有普通攻击成功时增加计数；受击必须清零。\r\n', '战斗-a.md');
  const b = await add('# 战斗设计\n\n连击窗口为999秒。受击继续连击。', '战斗-b.md');
  const unknown = await add('# 战斗\n\n连击窗口为1秒。', 'unknown.md');
  const config = await configure(data, { expectedRevision: 0, projects: [{ id: 'a', aliases: ['甲'], directories: ['D:/a'], modules: ['battle'], entries: [a] }, { id: 'b', aliases: [], directories: ['D:/b'], modules: ['battle'], entries: [] }], resources: { [a]: { projectId: 'a', modules: ['battle'] }, [b]: { projectId: 'b', modules: ['battle'] } } });
  return { root, data, a, b, unknown, config };
}
const scope = { projectId: 'a', modules: ['battle'] };

test('scope identity: ambiguity, context intersection and directory segment boundaries', () => {
  const config: RecallConfig = { revision: 1, projects: [{ id: 'a', aliases: ['shared'], directories: ['D:/a'], modules: ['battle'], entries: [] }, { id: 'b', aliases: ['shared'], directories: ['D:/b'], modules: ['battle'], entries: [] }], resources: {}, organizations: {} };
  assert.throws(() => resolveScope(config, {}), /请显式/); assert.throws(() => resolveScope(config, { scope: { projectId: 'shared' } }), /多个候选/);
  assert.throws(() => resolveScope(config, { cwd: 'D:/abc' }), /请显式/); assert.deepEqual(resolveScope(config, { cwd: 'D:/a/worktree' }).projectIds, ['a']);
  assert.throws(() => resolveScope(config, { scope: { projectId: 'a' }, contextProjectId: 'b' }), /冲突/);
  assert.throws(() => resolveScope(config, { scope: { projectIds: ['a', 'b'] } }), /跨项目/);
  assert.deepEqual(resolveScope(config, { scope: { crossProject: true } }).projectIds, ['a', 'b']);
});
test('fixed original offsets preserve BOM CRLF, emoji and deterministic fragment identities', async () => {
  const fixture = await setup(); const source = await snapshot(fixture.data, true); const record = source.records.find(r => r.resourceId === fixture.a)!;
  record.text += '\n```ts\n' + '条件😀'.repeat(800) + '\n```\n';
  const fragments = split(record); assert.equal(fragments.map(f => f.text).join(''), record.text); assert.deepEqual(fragments.map(f => f.id), split(record).map(f => f.id));
  for (const f of fragments) { assert.equal(record.text.slice(f.start, f.end), f.text); assert.ok(!/[\uD800-\uDBFF]$/.test(f.text)); }
  assert.ok(fragments.some(f => f.continued));
});
test('direct reading needs no index or model and respects project scope', async () => {
  const f = await setup(); const result = await prepare(f.data, { id: f.a, scope });
  assert.equal(result.route, 'read'); assert.equal(result.usage.modelCalls, 0); assert.ok(result.evidence[0].text.startsWith('\uFEFF'));
  assert.equal(await pointer(f.data), null);
  await assert.rejects(prepare(f.data, { id: f.b, scope }), /允许范围/);
  await assert.rejects(prepare(f.data, { id: f.unknown, scope }), /允许范围/);
});
test('scoped BM25 cannot let other projects occupy top K; lexical never invokes reranking', async () => {
  const f = await setup(); await buildIndex(f.data, false, false);
  const result = await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical', candidates: 1, rerank: true });
  assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].resourceId, f.a); assert.equal(result.usage.modelCalls, 0);
  assert.deepEqual(result.stages, ['scope', 'bm25']);
  const missing = await prepare(f.data, { query: '税务发票', scope, retrievalMode: 'lexical' }); assert.equal(missing.evidence.length, 0);
});
test('deletion applies before rebuild; restore and metadata mapping changes reuse stable fragments', async () => {
  const f = await setup(); const first = await buildIndex(f.data, false, false);
  const manager = await CoreManager.open(f.data); try { await manager.deleteResource(f.a); } finally { await manager.close(); }
  assert.equal((await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' })).evidence.length, 0);
  const writer = await CoreManager.open(f.data); try { await writer.restoreResource(f.a); } finally { await writer.close(); }
  const second = await buildIndex(f.data, false, false); assert.notEqual(second.generation, first.generation); assert.ok(second.reusedFragments > 0);
  await configure(f.data, { ...f.config, expectedRevision: f.config.revision, resources: { ...f.config.resources, [f.a]: { projectId: 'b', modules: ['battle'] } } });
  assert.equal((await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' })).evidence.length, 0);
});
test('notes remain pinned to original version after underlying resource update', async () => {
  const f = await setup(); const file = path.join(f.root, 'new.md'); await writeFile(file, '# 新规则\n\n连击窗口为100秒');
  const manager = await CoreManager.open(f.data); try { await manager.updateResource(f.a, file, 1); } finally { await manager.close(); }
  const pinned = await prepare(f.data, { id: f.a, scope }); assert.ok(pinned.evidence[0].text.includes('300毫秒')); assert.equal(pinned.evidence[0].contentVersion, 1);
  const newer = await prepare(f.data, { id: f.a, version: 2, scope }); assert.ok(newer.evidence[0].text.includes('100秒')); assert.equal(newer.evidence[0].contentVersion, 2);
});
test('full response budget, metadata listing and registered task entries are bounded', async () => {
  const f = await setup(); await buildIndex(f.data, false, false);
  await assert.rejects(prepare(f.data, { id: f.a, scope, maxBytes: 1500 }), { code: 'OUTPUT_BUDGET' });
  const read = await prepare(f.data, { id: f.a, scope, maxBytes: 3000 }); assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: read })) <= 3000); assert.ok(read.evidence.length);
  const task = await prepare(f.data, { task: '增加连击', scope, retrievalMode: 'lexical', maxBytes: 4000 }); assert.ok(task.evidence.some((x: any) => x.methods.includes('registered'))); assert.equal(task.usage.modelCalls, 0); assert.ok(task.gaps.length > 0);
  const list = await prepare(f.data, { mode: 'list', scope, sort: 'title', direction: 'asc' }); assert.equal(list.items.length, 1); assert.equal(list.usage.modelCalls, 0);
});
test('source time never substitutes recordedAt and uses explicit half-open boundaries', async () => {
  const f = await setup(); const record = (await snapshot(f.data)).records[0];
  assert.equal(allowed(record, { projectIds: ['a'], time: { field: 'sourceTime', from: '2020-01-01T00:00:00Z' } }), false);
  const r = { ...record, projectId: 'a', sourceFrom: '2026-11-01T00:00:00Z', sourceTo: '2026-11-02T00:00:00Z' };
  assert.equal(allowed(r, { projectIds: ['a'], time: { field: 'sourceTime', to: '2026-11-01T00:00:00Z' } }), false);
  assert.equal(allowed(r, { projectIds: ['a'], time: { field: 'sourceTime', from: '2026-11-02T00:00:00Z' } }), true);
});
test('missing model is explicit, hybrid degrades and index is not rebuilt by queries', async () => {
  const f = await setup(); await buildIndex(f.data, false, false); const before = await pointer(f.data);
  const hybrid = await prepare(f.data, { query: '连击窗口', scope }); assert.ok(hybrid.warnings.includes('MODEL_NOT_READY')); assert.equal(hybrid.usage.modelCalls, 0); assert.ok(hybrid.evidence.length);
  const semantic = await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'semantic' }); assert.equal(semantic.status, 'unavailable'); assert.equal(semantic.evidence.length, 0);
  assert.deepEqual(await pointer(f.data), before);
});
test('invalid filters and FTS syntax cannot widen query or execute arbitrary expressions', async () => {
  const f = await setup(); await buildIndex(f.data, false, false);
  await assert.rejects(prepare(f.data, { query: 'x', scope: { ...scope, typo: 'bad' } }), /未知范围字段/);
  await assert.rejects(prepare(f.data, { query: 'x', scope, maxBytes: 1 }), /maxBytes/);
  const result = await prepare(f.data, { query: '" OR * : NEAR(连击)', scope, retrievalMode: 'lexical' }); assert.ok(result.evidence.every((x: any) => x.projectId === 'a'));
  const state = await recallCommand(f.data, ['recall', 'scope'], { scope }); assert.equal(state.records, 1);
});
test('development workload explicitly defers expensive recall without disabling direct reads', async () => {
  const f = await setup();
  const workload = runDevelopmentWorkload({ command: 'node', args: ['-e', 'setTimeout(()=>{},800)'] });
  for (let i = 0; i < 50 && !await developmentBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await developmentBusy(), true);
  await assert.rejects(prepare(f.data, { query: '连击窗口', scope }), /开发负载优先/);
  await assert.rejects(buildIndex(f.data, false, false), /开发负载优先/);
  assert.equal((await prepare(f.data, { id: f.a, scope })).usage.modelCalls, 0);
  assert.equal((await workload).exitCode, 0); assert.equal(await developmentBusy(), false);
});
test('split configuration versions identities and fixed read continuation advances', async () => {
  const f = await setup(); const source = (await snapshot(f.data, true)).records.find(r => r.resourceId === f.a)!;
  const first = split(source, { targetChars: 128, maxBlockChars: 256 }); const other = split(source, { targetChars: 256, maxBlockChars: 512 });
  assert.notEqual(first[0].id, other[0].id);
  const long = source.text + '\n## 下一节\n\n新的完整条件。\n';
  const note = await noteCommand(f.data, 'add', { text: long, title: 'long' }, async () => Buffer.alloc(0)) as { resourceId: string };
  await configure(f.data, { ...f.config, expectedRevision: f.config.revision, resources: { ...f.config.resources, [note.resourceId]: { projectId: 'a', modules: ['battle'] } } });
  const result = await prepare(f.data, { id: note.resourceId, scope, offset: 1 }); assert.ok(result.evidence.every((e: any) => e.ordinal >= 1));
});

test('exact titles return bounded ambiguity candidates without model calls', async () => {
  const f = await setup(); const title = (await snapshot(f.data)).records.find(r => r.resourceId === f.a)!.title;
  assert.equal((await prepare(f.data, { id: title, scope })).evidence[0].resourceId, f.a);
  const duplicate = await noteCommand(f.data, 'add', { text: '另一份记录', title: '战斗-a.md' }, async () => Buffer.alloc(0)) as { resourceId: string };
  await configure(f.data, { ...f.config, expectedRevision: f.config.revision, resources: { ...f.config.resources, [duplicate.resourceId]: { projectId: 'a', modules: ['battle'] } } });
  const result = await prepare(f.data, { id: title, scope }); assert.equal(result.status, 'ambiguous'); assert.equal(result.items.length, 2); assert.equal(result.usage.modelCalls, 0);
});

test('scope summary cache follows source revisions and cannot leak caller mutations', async () => {
  const f = await setup(); const first = await recallCommand(f.data, ['recall', 'scope'], { scope });
  first.projects[0].modules.push('caller-mutation');
  const second = await recallCommand(f.data, ['recall', 'scope'], { scope }); assert.deepEqual(second.projects[0].modules, ['battle']);
  const manager = await CoreManager.open(f.data); try { await manager.deleteResource(f.a); } finally { await manager.close(); }
  assert.equal((await recallCommand(f.data, ['recall', 'scope'], { scope })).records, 0);
  assert.equal((await recallCommand(f.data, ['recall', 'scope'], { scope: { projectId: 'b' } })).records, 1);
});

test('missing derived generation recovers only through explicit rebuild', async () => {
  const f = await setup(); const built = await buildIndex(f.data, false, false);
  await unlink(path.join(f.data, 'cache/recall', built.generation + '.sqlite'));
  assert.equal((await recallCommand(f.data, ['recall', 'index', 'status'], {})).ready, false);
  await assert.rejects(prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' }), /显式重建/);
  assert.ok((await prepare(f.data, { id: f.a, scope })).evidence.length);
  await buildIndex(f.data, false, true);
  assert.ok((await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' })).evidence.length);
});

test('invalid model manifest degrades hybrid explicitly while lexical remains independent', async () => {
  const f = await setup(); await buildIndex(f.data, false, false);
  const modelRoot = path.join(f.data, 'cache/recall-models'); await mkdir(modelRoot, { recursive: true }); await writeFile(path.join(modelRoot, 'lock.json'), '{}');
  const result = await prepare(f.data, { query: '连击窗口', scope }); assert.ok(result.warnings.includes('MODEL_INVALID')); assert.ok(result.evidence.length); assert.equal(result.usage.modelCalls, 0);
  const lexical = await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' }); assert.ok(!lexical.warnings.includes('MODEL_INVALID'));
});

test('development lease publication remains valid during concurrent polling', async () => {
  for (let repeat = 0; repeat < 5; repeat++) {
    let finished = false;
    const workload = runDevelopmentWorkload({ command: 'node', args: ['-e', 'setTimeout(()=>{},30)'] }).finally(() => { finished = true; });
    const reader = (async () => { while (!finished) await developmentBusy(); })();
    await Promise.all([workload, reader]); assert.equal(await developmentBusy(), false);
  }
});

test('tokenizer migration is explicit and read remains independent of the old index', async () => {
  const f = await setup(); await buildIndex(f.data, false, false);
  const manager = await CoreManager.open(f.data);
  try { const store = manager.pluginStore('recall'); const active = await store.read<any>('active-index', null, 'cache'); await store.write('active-index', { ...active, tokenizer: 'nfkc-cjk-bigram-1' }, 'cache'); } finally { await manager.close(); }
  assert.equal((await recallCommand(f.data, ['recall', 'index', 'status'], {})).tokenizerCompatible, false);
  await assert.rejects(prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' }), { code: 'INDEX_TOKENIZER_MISMATCH' });
  assert.ok((await prepare(f.data, { id: f.a, scope })).evidence.length);
  const rebuilt = await buildIndex(f.data, false, false); assert.equal(rebuilt.tokenizer, TOKENIZER_VERSION); assert.ok(rebuilt.reusedFragments > 0);
  assert.ok((await prepare(f.data, { query: '连击窗口', scope, retrievalMode: 'lexical' })).evidence.length);
});

test('mixed terms retain full identifiers and punctuation does not consume adjacent Chinese', () => {
  const tokens = terms('CHAIN_PROBE_8192：限制为8；E_FAIL-42与v1.2.3，D:/src/battle.ts提交abc123');
  for (const token of ['chain_probe_8192', '限制', 'e_fail-42', 'v1.2.3', 'd:/src/battle.ts', 'abc123']) assert.ok(tokens.includes(token), token);
  assert.ok(!tokens.some(token => token.includes('8192:限制')));
});

test('multi-document task omissions expose bounded pinned read ranges', async () => {
  const f = await setup();
  await configure(f.data, { ...f.config, expectedRevision: f.config.revision, resources: { ...f.config.resources, [f.b]: { projectId: 'a', modules: ['battle'] } }, projects: f.config.projects.map(p => p.id === 'a' ? { ...p, entries: [f.a, f.b] } : p) });
  await buildIndex(f.data, false, false);
  const result = await prepare(f.data, { task: '连击窗口', scope, retrievalMode: 'lexical', maxFragments: 1, maxBytes: 10000, budgetTokens: 4000 });
  assert.equal(result.evidence.length, 1); assert.ok(result.continuations.length); assert.equal(result.continue, undefined);
  const ids = new Set(result.evidence.map((e: any) => e.resourceId));
  for (const continuation of result.continuations) {
    assert.equal(continuation.command, 'recall read');
    const next = await prepare(f.data, { ...continuation.input, mode: 'read' });
    for (const evidence of next.evidence) { assert.ok(evidence.ordinal < continuation.input.endOffset); ids.add(evidence.resourceId); }
  }
  assert.deepEqual([...ids].sort(), [f.a, f.b].sort());
});
