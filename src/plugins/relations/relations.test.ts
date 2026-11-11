import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoreManager, PluginHost } from '../../index.js';
import type { PluginDefinition } from '../../contracts/index.js';
import type { AgentApi, AgentProvider, AgentProviderRequest, AgentProviderResponse } from '../../agent/types.js';
import { createAgentPlugin } from '../agent/index.js';
import { builtinPlugins } from '../index.js';
import type { TagsApi } from '../tags/index.js';
import type { KeywordsApi } from '../keywords/index.js';
import type { OrganizerApi } from '../organizer/index.js';
import type { TasksApi } from '../tasks/index.js';
import type { RelationsApi } from './index.js';
import { readRelationRecord, scopeKey } from './cache.js';

// 所有生成均为本地fake transport；不创建DeepSeekProvider、不读取凭证、不联网。
function fakeTransport() {
  const calls: { words: string[]; model: string }[] = [];
  let respond: ((input: AgentProviderRequest, words: string[], signal: AbortSignal) => Promise<AgentProviderResponse>) | undefined;
  const provider: AgentProvider = { id: 'deepseek', version: 'fake-1', async invoke(input, signal) {
    const words = (JSON.parse(input.messages.findLast(message => message.role === 'user')!.content) as { keywords: string[] }).keywords;
    calls.push({ words, model: input.profile.model });
    if (respond) return respond(input, words, signal);
    return response(input, words);
  } };
  function response(input: AgentProviderRequest, words: string[]): AgentProviderResponse {
    return { text: JSON.stringify({ scores: words.map(keyword => ({ keyword, score: keyword.startsWith('zero') ? 0 : 0.8, reason: '本地模拟评分' })) }), model: input.profile.model, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, finishReason: 'stop' };
  }
  return { provider, calls, response, set(value: typeof respond) { respond = value; } };
}
async function fixture(root?: string) {
  root ??= await fs.mkdtemp(path.join(os.tmpdir(), 'kb-relations-v002-'));
  const transport = fakeTransport(); const manager = await CoreManager.open(path.join(root, 'data'));
  const api = {} as { relations: RelationsApi; tags: TagsApi; keywords: KeywordsApi; organizer: OrganizerApi; tasks: TasksApi; agent: AgentApi };
  const probe: PluginDefinition = { manifest: { id: 'relation-test-probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: Object.fromEntries(Object.keys(api).concat(['relations', 'tags', 'keywords', 'organizer', 'tasks', 'agent']).map(id => [id, '*'])) }, async load(context) {
    for (const id of Object.keys(probe.manifest.dependencies)) (api as unknown as Record<string, unknown>)[id] = context.getDependency(id);
    return {};
  } };
  const host = new PluginHost(manager, [...builtinPlugins.filter(plugin => plugin.manifest.id !== 'agent'), createAgentPlugin({ providers: [transport.provider] }), probe]);
  await host.start();
  return { root, manager, host, api, transport, async close(remove = true) { await host.stop(); await manager.close(); if (remove) await fs.rm(root, { recursive: true, force: true }); } };
}
async function agentMode(f: Awaited<ReturnType<typeof fixture>>) { await f.api.relations.configure({ mode: 'agent', agentProfile: 'deepseek-default' }); }
async function addResource(f: Awaited<ReturnType<typeof fixture>>, name: string, text: string) {
  const file = path.join(f.root, name); await fs.writeFile(file, text); return (await f.manager.importResource(file)).resource;
}

test('归一化词对和0覆盖复用，只补新词，同标签并发请求不重复生成', async () => {
  const f = await fixture();
  try {
    const tag = await f.api.tags.create({ name: 'topic' });
    await f.api.relations.score(tag.id, ['topic']); assert.equal(f.transport.calls.length, 0);
    await agentMode(f);
    const first = await f.api.relations.score(tag.id, [' ALPHA ', 'alpha', 'ＺＥＲＯ']);
    assert.deepEqual(f.transport.calls[0].words, ['alpha', 'zero']); assert.equal(first.coverage.length, 2); assert.deepEqual(first.scores.map(score => score.keyword), ['alpha']);
    assert.equal((await f.api.relations.score(tag.id, ['alpha', 'ZERO'])).stats!.requests, 0); assert.equal(f.transport.calls.length, 1);
    await Promise.all([f.api.relations.score(tag.id, ['alpha', 'beta']), f.api.relations.score(tag.id, ['beta', 'gamma'])]);
    assert.equal(f.transport.calls.length, 3); assert.equal(f.transport.calls.flatMap(call => call.words).filter(word => word === 'beta').length, 1);
    const stored = JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null));
    assert.ok(!/"score":0(?:[,}])/u.test(stored)); assert.ok(stored.includes('"keyword":"zero"'));
    assert.deepEqual((await f.api.relations.plan(tag.id, ['alpha', 'zero'])).missing, []);
  } finally { await f.close(); }
});

test('标签定义变动保留旧词对追踪并提示，显式版本或生成语义变化才重评', async () => {
  const f = await fixture();
  try {
    const tag = await f.api.tags.create({ name: 'topic' }); await agentMode(f);
    await f.api.relations.score(tag.id, ['alpha']); await f.api.tags.update(tag.id, { description: 'changed definition' });
    const reused = await f.api.relations.score(tag.id, ['alpha']); assert.equal(f.transport.calls.length, 1); assert.equal(reused.coverage[0].tagRevision, 1); assert.ok(reused.warnings.length);
    const added = await f.api.relations.score(tag.id, ['alpha', 'beta']); assert.equal(f.transport.calls.length, 2); assert.equal(added.coverage.find(item => item.keyword === 'beta')!.tagRevision, 2);
    await f.api.agent.configureProfile({ id: 'deepseek-default', timeoutMs: 10_000, credentialEnv: 'FAKE_CREDENTIAL_NAME_ONLY' });
    await f.api.relations.score(tag.id, ['alpha']); assert.equal(f.transport.calls.length, 2);
    await f.api.relations.configure({ scoringLogicVersion: '2' }); await f.api.relations.score(tag.id, ['alpha']); assert.equal(f.transport.calls.length, 3);
    await f.api.agent.configureProfile({ id: 'deepseek-default', temperature: 0.5 }); await f.api.relations.score(tag.id, ['alpha']); assert.equal(f.transport.calls.length, 4);
    await f.api.agent.configureProfile({ id: 'deepseek-default', model: 'synthetic-model-2' }); await f.api.relations.score(tag.id, ['alpha']); assert.equal(f.transport.calls.length, 5);
    f.transport.provider.version = 'fake-2'; await f.api.relations.score(tag.id, ['alpha']); assert.equal(f.transport.calls.length, 6);
    const base = { id: 'deepseek', version: '1', kind: 'model' as const, promptVersion: '1', outputSchemaVersion: '1' };
    assert.notEqual(scopeKey(tag.id, '2', base), scopeKey(tag.id, '2', { ...base, promptVersion: '2' }));
    assert.notEqual(scopeKey(tag.id, '2', base), scopeKey(tag.id, '2', { ...base, outputSchemaVersion: '2' }));
    assert.equal(scopeKey(tag.id, '2', base), scopeKey(tag.id, '2', { ...base, profileRevision: 99, profileId: 'other' }));
  } finally { await f.close(); }
});

test('缺失、重复、越界、截断、失败、取消及多批半成品都不污染已有覆盖', async () => {
  const f = await fixture();
  try {
    const tag = await f.api.tags.create({ name: 'topic' }); await agentMode(f); await f.api.relations.score(tag.id, ['alpha']);
    const baseline = JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null));
    const beforeZeroBudget = f.transport.calls.length;
    await assert.rejects(f.api.relations.score(tag.id, ['new-a'], undefined, { maxRequests: 0 }), error => (error as { code?: string }).code === 'RELATION_MODEL_BUDGET');
    assert.equal(f.transport.calls.length, beforeZeroBudget);
    const bad = [
      (input: AgentProviderRequest) => ({ ...f.transport.response(input, []), text: '{"scores":[]}' }),
      (input: AgentProviderRequest, values: string[]) => f.transport.response(input, [values[0], values[0]]),
      (input: AgentProviderRequest, values: string[]) => ({ ...f.transport.response(input, values), text: JSON.stringify({ scores: values.map(keyword => ({ keyword, score: 2, reason: 'bad' })) }) }),
      (input: AgentProviderRequest, values: string[]) => ({ ...f.transport.response(input, values), finishReason: 'length' as const }),
      (input: AgentProviderRequest, values: string[]) => ({ ...f.transport.response(input, values), text: '{' }),
    ];
    for (const respond of bad) {
      f.transport.set(async (input, values) => respond(input, values));
      await assert.rejects(f.api.relations.score(tag.id, ['new-a', 'new-b']));
      assert.equal(JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null)), baseline);
    }
    f.transport.set(async () => { throw new Error('mock transport failure'); }); await assert.rejects(f.api.relations.score(tag.id, ['new-a']));
    assert.equal(JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null)), baseline);
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    f.transport.set(async (_, __, signal) => { ready(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); });
    const controller = new AbortController(); const cancel = f.api.relations.score(tag.id, ['new-a'], controller.signal); await started; controller.abort(); await assert.rejects(cancel);
    assert.equal(JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null)), baseline);
    await f.api.relations.configure({ maxBatchSize: 1 }); let batch = 0;
    f.transport.set(async (input, values) => ({ ...f.transport.response(input, values), finishReason: ++batch === 2 ? 'length' : 'stop' }));
    await assert.rejects(f.api.relations.score(tag.id, ['new-a', 'new-b'])); assert.equal(batch, 2);
    assert.equal(JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null)), baseline);
    f.transport.set(undefined); const beforeLimited = f.transport.calls.length;
    await assert.rejects(f.api.relations.score(tag.id, ['limited-a', 'limited-b'], undefined, { maxRequests: 1 }), error => (error as { code?: string }).code === 'RELATION_MODEL_BUDGET');
    assert.equal(f.transport.calls.length - beforeLimited, 1); assert.equal(JSON.stringify(await f.manager.pluginStore('relations').read(tag.id, null)), baseline);
    f.transport.set(async (input, values) => ({ ...f.transport.response(input, values), model: 'provider-response-alias' }));
    assert.equal((await f.api.relations.score(tag.id, ['new-a'])).coverage.length, 1);
  } finally { await f.close(); }
});

test('默认零模型预算阻止自动收费，缓存命中动态估0，显式版本补评不覆盖manual', async () => {
  const f = await fixture();
  try {
    const tag = await f.api.tags.create({ name: 'topic' }); await agentMode(f);
    const resource = await addResource(f, 'a.txt', 'alpha');
    const blocked = await f.api.organizer.run(); assert.equal(blocked.stopped, 'model-budget'); assert.equal(f.transport.calls.length, 0);
    const paid = await f.api.organizer.run({ maxCalls: 1 }); assert.equal(paid.calls, 1); assert.equal(f.transport.calls.length, 1);
    await addResource(f, 'a.txt', 'alpha alpha'); // 文件名及词对相同，但新资源UUID。
    const cached = await f.api.organizer.run(); assert.equal(cached.failed, 0); assert.equal(cached.unfinished, 0); assert.equal(f.transport.calls.length, 1);
    await f.api.tags.decide({ resourceId: resource.id, tagId: tag.id, accepted: false, source: 'manual', reason: '人工拒绝', contentVersion: 1, tagRevision: tag.revision });
    await f.api.relations.configure({ scoringLogicVersion: '2' }); assert.equal((await f.api.organizer.run()).stopped, 'model-budget'); assert.equal(f.transport.calls.length, 1);
    assert.equal((await f.api.organizer.run({ maxCalls: 1 })).failed, 0); assert.equal(f.transport.calls.length, 2);
    const decision = f.api.tags.decisions(await f.manager.getResource(resource.id))[0]; assert.equal(decision.source, 'manual'); assert.equal(decision.accepted, false);
    const newTag = await f.api.tags.create({ name: 'new-topic' });
    await f.api.organizer.run(); assert.equal(f.transport.calls.length, 2);
    const words = await f.api.keywords.vocabulary(); await f.api.relations.score(newTag.id, words);
    const reusedPending = await f.api.organizer.run(); assert.equal(reusedPending.unfinished, 0); assert.equal(f.transport.calls.length, 3);
  } finally { await f.close(); }
});

test('v001评分迁移保留provider并把0转coverage，future结构拒绝且备份恢复复用', async () => {
  let f = await fixture(); const root = f.root; let closed = false;
  try {
    const tag = await f.api.tags.create({ name: 'topic' }); await f.host.stop();
    const state = await f.manager.pluginStore('core-host').read<Record<string, unknown>>('state', {});
    (state.dataVersions as Record<string, number>).relations = 1; await f.manager.pluginStore('core-host').write('state', state);
    await f.manager.pluginStore('relations').write(tag.id, { tagId: tag.id, tagRevision: 1, provider: { id: 'offline-lexical', version: '1', kind: 'heuristic' }, scores: [{ keyword: ' Alpha ', score: 0.7, reason: 'legacy' }, { keyword: 'ZERO', score: 0, reason: 'legacy zero' }], at: '2026-11-10T00:00:00Z' });
    await f.manager.close(); closed = true; f = await fixture(root); closed = false;
    const migrated = await f.api.relations.score(tag.id, ['alpha', 'zero']); assert.equal(migrated.stats!.requests, 0); assert.equal(migrated.coverage.length, 2); assert.equal(migrated.scores.length, 1);
    const record = await f.manager.pluginStore('relations').read(tag.id, null); assert.ok(!/"score":0(?:[,}])/u.test(JSON.stringify(record)));
    assert.equal(readRelationRecord({ tagId: tag.id, tagRevision: 1, provider: { id: 'old-custom', version: '1', kind: 'model' }, scores: [], at: '2026-11-10' }, tag.id).record.scopes[0].scoringLogicVersion, 'legacy-v0.0.1');
    const backup = path.join(root, 'backup.json'); await f.manager.backup(backup); const restored = await CoreManager.open(path.join(root, 'restored'));
    try { await restored.restore(backup); assert.deepEqual(await restored.pluginStore('relations').read(tag.id, null), record); } finally { await restored.close(); }
    const future = { schemaVersion: 99, tagId: tag.id, mustRemain: true }; await f.manager.pluginStore('relations').write(tag.id, future);
    await assert.rejects(f.api.relations.get(tag.id), error => (error as { code?: string }).code === 'UNSUPPORTED_RELATION_SCHEMA');
    await assert.rejects(f.api.relations.score(tag.id, ['new']), error => (error as { code?: string }).code === 'UNSUPPORTED_RELATION_SCHEMA');
    assert.deepEqual(await f.manager.pluginStore('relations').read(tag.id, null), future);
  } finally { if (!closed) await f.close(); else await fs.rm(root, { recursive: true, force: true }); }
});
