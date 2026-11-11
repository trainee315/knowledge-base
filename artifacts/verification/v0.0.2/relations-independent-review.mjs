import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const { CoreManager, PluginHost } = await import(pathToFileURL(path.resolve('dist/index.js')));
const { builtinPlugins } = await import(pathToFileURL(path.resolve('dist/plugins/index.js')));
const { createAgentPlugin } = await import(pathToFileURL(path.resolve('dist/plugins/agent/index.js')));
const root = await mkdtemp(path.join(os.tmpdir(), 'kb-v002-independent-'));
const manager = await CoreManager.open(path.join(root, 'data'));
const api = {};
let calls = 0, release, started;
let gated = false;
const provider = { id: 'deepseek', version: 'review-1', async invoke(input) {
  calls++;
  const words = JSON.parse(input.messages.findLast(item => item.role === 'user').content).keywords;
  if (gated) { started(); await new Promise(resolve => { release = resolve; }); }
  return { text: JSON.stringify({ scores: words.map(keyword => ({ keyword, score: keyword === 'zero' ? 0 : 0.8, reason: 'independent mock' })) }), model: 'canonical-alias', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
} };
const probe = { manifest: { id: 'independent-review', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { agent: '*', tags: '*', relations: '*', tasks: '*' } }, async load(context) {
  for (const id of Object.keys(probe.manifest.dependencies)) api[id] = context.getDependency(id);
  return {};
} };
const definitions = () => [...builtinPlugins.filter(item => item.manifest.id !== 'agent'), createAgentPlugin({ providers: [provider] }), probe];
let host = new PluginHost(manager, definitions());
try {
  await host.start();
  const tag = await api.tags.create({ name: 'review topic' });
  await api.relations.configure({ mode: 'agent' });
  await api.relations.score(tag.id, [' ALPHA ', 'zero']);
  assert.equal(calls, 1);
  const initial = await manager.pluginStore('relations').read(tag.id, null);
  assert.equal(initial.scopes[0].coverage.length, 2);
  assert.equal(initial.scopes[0].scores.length, 1);
  gated = true;
  const began = new Promise(resolve => { started = resolve; });
  const oldScope = api.relations.score(tag.id, ['beta']).then(() => false, error => error.code === 'STALE_PROVIDER');
  await began;
  await api.relations.configure({ scoringLogicVersion: '2' });
  const newScope = api.relations.score(tag.id, ['gamma']);
  gated = false; release();
  assert.equal(await oldScope, true); await newScope;
  const combined = await manager.pluginStore('relations').read(tag.id, null);
  assert.equal(combined.scopes.length, 2);
  assert(combined.scopes.some(scope => scope.scoringLogicVersion === '1' && scope.coverage.some(item => item.keyword === 'alpha')));
  assert(combined.scopes.some(scope => scope.scoringLogicVersion === '2' && scope.coverage.some(item => item.keyword === 'gamma')));
  assert(!combined.scopes.some(scope => scope.coverage.some(item => item.keyword === 'beta')));
  const beforeReuse = calls;
  await api.agent.configureProfile({ id: 'deepseek-default', timeoutMs: 50_000, credentialEnv: 'SYNTHETIC_ENV_REFERENCE' });
  await api.relations.score(tag.id, ['gamma']); assert.equal(calls, beforeReuse);

  let handlerCalls = 0;
  api.tasks.register('review-paid', async () => { handlerCalls++; return {}; }, { prepare: async () => ({ estimatedCalls: 1 }) });
  api.tasks.register('review-free', async () => { handlerCalls++; return {}; }, { prepare: async () => ({ estimatedCalls: 0 }) });
  api.tasks.register('review-obsolete', async () => { throw new Error('must not dispatch'); }, { prepare: async () => ({ obsolete: true }) });
  api.tasks.register('review-invalid', async () => { throw new Error('must not dispatch'); }, { prepare: async () => ({ estimatedCalls: -1 }) });
  for (const type of ['review-paid', 'review-free', 'review-obsolete', 'review-invalid']) await api.tasks.enqueue({ type, entityId: type, inputVersion: '1', processorVersion: '1', payload: {}, maxAttempts: 1 });
  const zero = await api.tasks.run({ maxTasks: 10, maxCalls: 0 });
  assert.equal(zero.calls, 0); assert.equal(handlerCalls, 1);
  const jobs = await api.tasks.list();
  assert.equal(jobs.find(item => item.type === 'review-paid').status, 'pending');
  assert.equal(jobs.find(item => item.type === 'review-free').status, 'completed');
  assert.equal(jobs.find(item => item.type === 'review-obsolete').status, 'completed');
  assert.equal(jobs.find(item => item.type === 'review-invalid').status, 'failed');
  api.tasks.register('review-slow', async () => { handlerCalls++; return {}; }, { prepare: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { estimatedCalls: 1 }; } });
  await api.tasks.enqueue({ type: 'review-slow', entityId: 'slow', inputVersion: '1', processorVersion: '1', payload: {} });
  const timed = await api.tasks.run({ maxCalls: 0, maxDurationMs: 20 });
  assert.equal(timed.stopped, 'time-budget'); assert.equal(timed.calls, 0); assert.equal(handlerCalls, 1);

  // 新宿主验证completed/failed旧任务不因重启重复dispatch；未知future缓存阻止批量迁移。
  await host.stop(); host = new PluginHost(manager, definitions()); await host.start();
  let retryDispatches = 0;
  for (const type of ['review-paid', 'review-free', 'review-obsolete', 'review-invalid', 'review-slow']) api.tasks.register(type, async () => { retryDispatches++; return {}; }, { prepare: async () => ({ estimatedCalls: 1 }) });
  await api.tasks.run({ maxCalls: 0 }); assert.equal(retryDispatches, 0);
  const legacyTag = await api.tags.create({ name: 'legacy topic' }); const futureTag = await api.tags.create({ name: 'future topic' });
  const legacy = { tagId: legacyTag.id, tagRevision: 1, provider: { id: 'offline-lexical', version: '1', kind: 'heuristic' }, scores: [{ keyword: 'ZERO', score: 0, reason: 'legacy' }], at: '2026-11-10T00:00:00Z' };
  await manager.pluginStore('relations').write(legacyTag.id, legacy);
  await manager.pluginStore('relations').write(futureTag.id, { schemaVersion: 99, unchanged: true });
  const state = await manager.pluginStore('core-host').read('state', {}); state.dataVersions.relations = 1; await manager.pluginStore('core-host').write('state', state);
  await host.stop(); host = new PluginHost(manager, definitions());
  await assert.rejects(host.start(), error => error.code === 'UNSUPPORTED_RELATION_SCHEMA');
  assert.deepEqual(await manager.pluginStore('relations').read(legacyTag.id, null), legacy);
  assert.deepEqual(await manager.pluginStore('relations').read(futureTag.id, null), { schemaVersion: 99, unchanged: true });
  await manager.pluginStore('relations').remove(futureTag.id);
  await host.start(); await host.refresh();
  const migrated = await manager.pluginStore('relations').read(legacyTag.id, null);
  assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.scopes[0].coverage[0].keyword, 'zero'); assert.equal(migrated.scopes[0].scores.length, 0); assert.equal(calls, 3);
  console.log(JSON.stringify({ passed: true, provider: 'local mock only', modelRequests: calls, sameTagCrossScopePreserved: true, obsoleteInflightNotCommitted: true, zeroSparseCoverage: true, transportConfigReusesCache: true, paidHeadDoesNotBlockFree: true, obsoleteAndFailedPrepareNoDispatch: true, timeBudgetAfterPrepareNoDispatch: true, restartZeroBudgetNoDispatch: true, futureCacheStopsMigrationBeforeWrites: true, legacyZeroMigratesWithoutModel: true }));
} finally {
  await host.stop(); await manager.close();
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('kb-v002-independent-')) throw new Error('Unexpected cleanup target');
  await rm(target, { recursive: true, force: true });
}
