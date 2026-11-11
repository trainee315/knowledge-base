import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from './service.js';
import { DeepSeekProvider } from './deepseek.js';
import type { AgentJsonSchema, AgentMessage, AgentProfile, AgentProvider } from './types.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreManager, PluginHost } from '../index.js';
import { builtinPlugins } from '../plugins/index.js';
import { createAgentPlugin } from '../plugins/agent/index.js';

// 仅为本地 HTTP 测试使用的合成凭证，不读取用户密钥或发送外部网络请求。
const CANARY = 'SYNTHETIC_CREDENTIAL_MUST_NOT_APPEAR';
const PROFILE: AgentProfile = { id: 'integration', revision: 1, providerId: 'deepseek', model: 'deepseek-flash', credentialEnv: 'MOCK_AGENT_KEY', timeoutMs: 1000, maxTokens: 256, temperature: 0, reasoning: 'off' };
const MESSAGES: AgentMessage[] = [{ role: 'system', content: 'Synthetic verification only.' }, { role: 'user', content: 'Return a short synthetic response.' }];
const OBJECT_SCHEMA: AgentJsonSchema = { type: 'object', properties: { title: { type: 'string', minLength: 1 }, score: { type: 'number', minimum: 0, maximum: 1 } }, required: ['title', 'score'], additionalProperties: false };
interface Seen { method?: string; path?: string; authorized: boolean; body: Record<string, unknown> }

function completion(content: string, finishReason = 'stop') {
  return { id: 'synthetic-request-id', model: PROFILE.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } };
}

/** 用真实 loopback HTTP 验证 transport 映射；观察结果不保存请求头。 */
async function mockHttp(reply: (request: Seen, response: ServerResponse) => Promise<void> | void) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const item = { method: request.method, path: request.url, authorized: request.headers.authorization === `Bearer ${CANARY}`, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      seen.push(item); await reply(item, response);
    })().catch(() => { if (!response.destroyed) { response.writeHead(500); response.end('{}'); } });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { seen, endpoint: `http://127.0.0.1:${address.port}`, close: async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); } };
}
function respond(response: ServerResponse, value: unknown, status = 200): void { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
function createAgent(endpoint: string, options: { credential?: string | undefined; missingCredential?: boolean; maxConcurrent?: number; maxQueue?: number } = {}) {
  const provider = new DeepSeekProvider({ endpoint, resolveCredential: () => options.missingCredential ? undefined : options.credential ?? CANARY });
  return new AgentService({ providers: [provider], profiles: [{ ...PROFILE }], maxConcurrent: options.maxConcurrent ?? 2, maxQueue: options.maxQueue ?? 4 });
}
async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: any) => {
    assert.equal(error.code, `AGENT_${code}`);
    const serialized = [String(error), JSON.stringify(error), error.stack ?? ''].join('\n');
    assert.equal(serialized.includes(CANARY), false);
    assert.equal(serialized.includes('private-upstream-body'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}
async function withPlugins(mock: Awaited<ReturnType<typeof mockHttp>>, action: (value: { host: PluginHost; manager: CoreManager; root: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'kb-agent-business-integration-'));
  const manager = await CoreManager.open(join(root, 'data'));
  const host = new PluginHost(manager, builtinPlugins.map((definition) => definition.manifest.id === 'agent' ? createAgentPlugin({ providers: [new DeepSeekProvider({ endpoint: mock.endpoint, resolveCredential: () => CANARY })] }) : definition));
  try {
    await host.start(); await host.execute('agent profile set', { id: 'deepseek-default', maxTokens: 256 }, []);
    await action({ host, manager, root });
  } finally { await host.stop(); await manager.close(); await rm(root, { recursive: true, force: true }); }
}
function relationKeywords(request: Seen): string[] {
  const messages = request.body.messages as { content: string }[];
  return JSON.parse(messages.at(-1)!.content).keywords;
}
function relationCompletion(request: Seen, scores: unknown[]) { return { ...completion(JSON.stringify({ scores })), model: String(request.body.model) }; }

test('DeepSeek text maps generic messages and bounded non-thinking options through real HTTP', async () => {
  const mock = await mockHttp((_request, response) => respond(response, completion('synthetic hello')));
  try {
    const service = createAgent(mock.endpoint);
    const result = await service.generateText({ profile: PROFILE.id, messages: MESSAGES });
    assert.equal(mock.seen.length, 1);
    const request = mock.seen[0];
    assert.equal(request.method, 'POST'); assert.equal(request.path, '/chat/completions'); assert.equal(request.authorized, true);
    assert.equal(request.body.model, PROFILE.model); assert.deepEqual(request.body.messages, MESSAGES);
    assert.equal(request.body.max_tokens, 256); assert.equal(request.body.stream, false);
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    assert.equal(JSON.stringify(request.body).includes(CANARY), false);
    assert.equal(result.value, 'synthetic hello'); assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    assert.equal(result.profileId, PROFILE.id); assert.equal(result.model, PROFILE.model);
  } finally { await mock.close(); }
});

test('JSON purpose maps response_format and validates a generic schema outside scoring', async () => {
  const mock = await mockHttp((_request, response) => respond(response, completion('{"title":"synthetic","score":0.75}')));
  try {
    const service = createAgent(mock.endpoint + '/chat/completions');
    const result = await service.generateObject({ profile: PROFILE.id, messages: [{ role: 'user', content: 'Return json with title and score.' }], schema: OBJECT_SCHEMA, maxTokens: 128 });
    assert.deepEqual(result.value, { title: 'synthetic', score: 0.75 });
    assert.equal(mock.seen[0].path, '/chat/completions');
    assert.deepEqual(mock.seen[0].body.response_format, { type: 'json_object' });
    assert.equal(mock.seen[0].body.max_tokens, 128);
  } finally { await mock.close(); }
});

test('blank stop, truncation, invalid JSON and schema mismatch reject once without hidden retries', async () => {
  for (const [content, finish, code] of [
    ['   \n  ', 'stop', 'EMPTY_OUTPUT'], ['{"title":"cut","score":0.5}', 'length', 'TRUNCATED'],
    [`private-upstream-body ${CANARY}`, 'stop', 'INVALID_JSON'], ['{"title":"x","score":2}', 'stop', 'SCHEMA_MISMATCH'],
    ['{"title":"x","score":"0.5"}', 'stop', 'SCHEMA_MISMATCH'], ['{"title":"x"}', 'stop', 'SCHEMA_MISMATCH'],
    ['{"title":"x","score":0.5,"extra":true}', 'stop', 'SCHEMA_MISMATCH'],
  ]) {
    const mock = await mockHttp((_request, response) => respond(response, completion(content, finish)));
    try {
      await rejectsCode(createAgent(mock.endpoint).generateObject({ profile: PROFILE.id, messages: MESSAGES, schema: OBJECT_SCHEMA }), code);
      assert.equal(mock.seen.length, 1);
    } finally { await mock.close(); }
  }
});

test('401, 429 and 5xx have sanitized classifications and exactly one HTTP attempt', async () => {
  for (const [status, code] of [[401, 'AUTH_FAILED'], [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
    const mock = await mockHttp((_request, response) => respond(response, { error: { message: `private-upstream-body ${CANARY}` } }, status));
    try {
      await rejectsCode(createAgent(mock.endpoint).generateText({ profile: PROFILE.id, messages: MESSAGES }), code);
      assert.equal(mock.seen.length, 1);
    } finally { await mock.close(); }
  }
});

test('transport error causes never escape as credential-bearing errors', async () => {
  let calls = 0;
  const provider = new DeepSeekProvider({ resolveCredential: () => CANARY, fetch: async () => { calls++; throw new Error(`private-upstream-body ${CANARY}`); } });
  const service = new AgentService({ providers: [provider], profiles: [PROFILE] });
  await rejectsCode(service.generateText({ profile: PROFILE.id, messages: MESSAGES }), 'PROVIDER_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('profile/status/schema/no-key validation perform no HTTP requests', async () => {
  const mock = await mockHttp((_request, response) => respond(response, completion('unreachable')));
  try {
    const service = createAgent(mock.endpoint, { missingCredential: true });
    service.listProfiles(); service.getProfile(PROFILE.id); service.describeProfile(PROFILE.id); service.status();
    await service.configureProfile({ id: PROFILE.id, maxTokens: 128, expectedRevision: 1 });
    assert.equal(mock.seen.length, 0);
    assert.equal(JSON.stringify(service.status()).includes(CANARY), false);
    await rejectsCode(service.generateText({ profile: PROFILE.id, messages: MESSAGES }), 'CREDENTIAL_MISSING');
    await rejectsCode(service.generateObject({ profile: PROFILE.id, messages: MESSAGES, schema: { type: 'object', patternProperties: {} } as unknown as AgentJsonSchema }), 'UNSUPPORTED_SCHEMA');
    await rejectsCode(service.configureProfile({ id: PROFILE.id, apiKey: CANARY } as any), 'INVALID_INPUT');
    assert.equal(mock.seen.length, 0);
    assert.equal(JSON.stringify(service.listProfiles()).includes(CANARY), false);
  } finally { await mock.close(); }
});

test('AbortSignal and timeout cover the active HTTP request', async () => {
  const mock = await mockHttp(async (_request, response) => { await delay(100); if (!response.destroyed) respond(response, completion('too late')); });
  try {
    const service = createAgent(mock.endpoint);
    await rejectsCode(service.generateText({ profile: PROFILE.id, messages: MESSAGES, timeoutMs: 20 }), 'TIMEOUT');
    const controller = new AbortController();
    const call = service.generateText({ profile: PROFILE.id, messages: MESSAGES, signal: controller.signal });
    controller.abort(); await rejectsCode(call, 'ABORTED');
    assert.ok(mock.seen.length <= 2);
  } finally { await mock.close(); }
});

test('queued cancellation, queue timeout and queue limit never invoke an extra request', async () => {
  for (const mode of ['abort', 'timeout'] as const) {
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const mock = await mockHttp(async (_request, response) => { await held; if (!response.destroyed) respond(response, completion('first completed')); });
    try {
      const service = createAgent(mock.endpoint, { maxConcurrent: 1, maxQueue: 1 });
      const first = service.generateText({ profile: PROFILE.id, messages: MESSAGES });
      while (!mock.seen.length) await delay(1);
      const controller = new AbortController();
      const second = service.generateText({ profile: PROFILE.id, messages: MESSAGES, signal: controller.signal, timeoutMs: mode === 'timeout' ? 20 : 500 });
      const secondCheck = rejectsCode(second, mode === 'timeout' ? 'TIMEOUT' : 'ABORTED');
      await rejectsCode(service.generateText({ profile: PROFILE.id, messages: MESSAGES }), 'QUEUE_FULL');
      if (mode === 'abort') controller.abort();
      await secondCheck; release(); await first;
      assert.equal(mock.seen.length, 1);
    } finally { release(); await mock.close(); }
  }
});

test('a replacement generic provider serves text and object purposes without changing business code', async () => {
  const purposes: string[] = [];
  const fake: AgentProvider = {
    id: 'generic-fake', version: '7',
    async invoke(input, signal) {
      signal.throwIfAborted(); purposes.push(input.output);
      return { text: input.output === 'text' ? 'synthetic summary' : '{"title":"synthetic record","score":0.8}', model: input.profile.model, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
    },
  };
  const service = new AgentService({ providers: [fake], profiles: [{ ...PROFILE, providerId: fake.id }] });
  assert.equal((await service.generateText({ profile: PROFILE.id, messages: MESSAGES })).value, 'synthetic summary');
  const object = await service.generateObject({ profile: PROFILE.id, messages: MESSAGES, schema: OBJECT_SCHEMA });
  assert.deepEqual(object.value, { title: 'synthetic record', score: 0.8 });
  assert.equal(object.provider.id, fake.id); assert.deepEqual(purposes, ['text', 'object']);
});

test('plugin load, read-only configuration and backup keep credentials out of formal data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-agent-plugin-integration-'));
  const dataDir = join(root, 'data'), backup = join(root, 'formal.backup.json');
  const mock = await mockHttp((_request, response) => respond(response, completion('synthetic result')));
  const definitions = () => builtinPlugins.map((definition) => definition.manifest.id === 'agent' ? createAgentPlugin({ providers: [new DeepSeekProvider({ endpoint: mock.endpoint, resolveCredential: () => CANARY })] }) : definition);
  let manager: CoreManager | undefined, host: PluginHost | undefined;
  try {
    manager = await CoreManager.open(dataDir); host = new PluginHost(manager, definitions()); await host.start();
    await host.execute('agent status', {}, []); await host.execute('agent profile list', {}, []);
    await host.execute('agent profile set', { id: 'mock-store', credentialEnv: 'MOCK_KEY', maxTokens: 128 }, []);
    assert.equal(mock.seen.length, 0);
    await host.execute('agent generate text', { profile: 'mock-store', messages: MESSAGES }, []);
    assert.equal(mock.seen.length, 1);
    await manager.backup(backup);
    const saved = JSON.parse(await readFile(backup, 'utf8')) as { entries: { file: string; content: string }[] };
    assert.ok(saved.entries.some((entry) => entry.file === 'plugins/agent/data/profiles.json'));
    for (const entry of saved.entries) assert.equal(Buffer.from(entry.content, 'base64').includes(Buffer.from(CANARY)), false);
    const profileFile = join(dataDir, 'plugins/agent/data/profiles.json');
    const before = await readFile(profileFile, 'utf8'); assert.equal(before.includes(CANARY), false);
    await host.stop(); await manager.close(); host = undefined; manager = undefined;
    manager = await CoreManager.open(dataDir, { readOnly: true }); host = new PluginHost(manager, definitions()); await host.start();
    await host.execute('agent status', {}, []); await host.execute('agent config get', {}, []); await host.execute('agent profile list', {}, []);
    assert.equal(mock.seen.length, 1);
    await assert.rejects(host.execute('agent profile set', { id: 'mock-store', maxTokens: 64 }, []), (error: any) => error.code === 'READ_ONLY');
    assert.equal(await readFile(profileFile, 'utf8'), before);
    assert.equal(mock.seen.length, 1);
  } finally { await host?.stop(); await manager?.close(); await mock.close(); await rm(root, { recursive: true, force: true }); }
});

test('relation cache normalizes words, stores zero coverage sparsely, and follows explicit scope versions', async () => {
  const mock = await mockHttp((request, response) => respond(response, relationCompletion(request, relationKeywords(request).map((keyword) => ({ keyword, score: keyword === 'zero' ? 0 : 0.6, reason: 'synthetic relation' })))));
  try {
    await withPlugins(mock, async ({ host }) => {
      const tag = await host.execute('tag create', { name: 'Synthetic cache tag' }, []) as any;
      await host.execute('relation configure', { mode: 'agent', scoringLogicVersion: 'integration-1', maxBatchSize: 2 }, []);
      assert.equal(mock.seen.length, 0);
      const first = await host.execute('relation score', { id: tag.id, keywords: [' Alpha ', 'ZERO', 'alpha'] }, []) as any;
      assert.equal(mock.seen.length, 1); assert.equal(first.coverage.length, 2); assert.equal(first.scores.length, 1); assert.equal(first.scores[0].keyword, 'alpha');
      const cached = await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'zero'] }, []) as any;
      assert.equal(mock.seen.length, 1); assert.equal(cached.stats.requests, 0); assert.equal(cached.stats.reused, 2);
      await host.execute('tag update', { id: tag.id, description: 'Explicitly changed synthetic definition' }, []);
      const reused = await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'zero'] }, []) as any;
      assert.equal(mock.seen.length, 1); assert.ok(reused.warnings.length); assert.equal(reused.coverage[0].tagRevision, 1);
      await host.execute('relation configure', { scoringLogicVersion: 'integration-2' }, []);
      await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'zero'] }, []); assert.equal(mock.seen.length, 2);
      await host.execute('agent profile set', { id: 'deepseek-default', timeoutMs: 2000 }, []);
      await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'zero'] }, []); assert.equal(mock.seen.length, 2);
      await host.execute('agent profile set', { id: 'deepseek-default', maxTokens: 128 }, []);
      await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'zero'] }, []); assert.equal(mock.seen.length, 3);
      await host.execute('agent profile set', { id: 'deepseek-default', model: 'synthetic-other-model' }, []);
      await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'zero'] }, []); assert.equal(mock.seen.length, 4);
    });
  } finally { await mock.close(); }
});

test('relation malformed or duplicate batches never persist partial coverage', async () => {
  let duplicate = true;
  const mock = await mockHttp((request, response) => {
    const words = relationKeywords(request);
    respond(response, relationCompletion(request, words.map((keyword) => ({ keyword: duplicate ? words[0] : keyword, score: 0.4, reason: 'synthetic relation' }))));
  });
  try {
    await withPlugins(mock, async ({ host }) => {
      const tag = await host.execute('tag create', { name: 'Synthetic invalid batch' }, []) as any;
      await host.execute('relation configure', { mode: 'agent', maxBatchSize: 2 }, []);
      await assert.rejects(host.execute('relation score', { id: tag.id, keywords: ['alpha', 'beta'] }, []), (error: any) => error.code === 'INVALID_SCORE');
      assert.equal(await host.execute('relation get', { id: tag.id }, []), undefined);
      duplicate = false;
      const success = await host.execute('relation score', { id: tag.id, keywords: ['alpha', 'beta'] }, []) as any;
      assert.equal(success.stats.missing, 2); assert.equal(success.coverage.length, 2); assert.equal(mock.seen.length, 2);
    });
  } finally { await mock.close(); }
});

test('organizer and scheduled runs with zero model-call budget never reach HTTP', async () => {
  const mock = await mockHttp((request, response) => respond(response, relationCompletion(request, relationKeywords(request).map((keyword) => ({ keyword, score: 0.7, reason: 'synthetic relation' })))));
  try {
    await withPlugins(mock, async ({ host, manager, root }) => {
      await host.execute('tag create', { name: 'Synthetic knowledge' }, []);
      const file = join(root, 'synthetic.txt'); await writeFile(file, 'synthetic knowledge resource');
      const imported = await manager.importResource(file);
      await host.execute('relation configure', { mode: 'agent', maxBatchSize: 32 }, []);
      await host.refresh(); assert.equal(mock.seen.length, 0);
      const normal = await host.execute('organize run', { maxCalls: 0, maxTasks: 100 }, []) as any;
      assert.equal(normal.stopped, 'model-budget'); assert.equal(mock.seen.length, 0);
      const nightly = await host.execute('schedule run', { now: '2026-11-12T04:00:00+08:00' }, []) as any;
      assert.equal(nightly.complete, false); assert.equal(mock.seen.length, 0);
      const allowed = await host.execute('organize run', { maxCalls: 1, maxTasks: 100 }, []) as any;
      assert.equal(allowed.calls, 1); assert.equal(mock.seen.length, 1);
      const resource = await manager.getResource(imported.resource.id);
      assert.equal((resource.plugins.tags?.data.decisions as unknown[] | undefined)?.length ?? 0, 0);
    });
  } finally { await mock.close(); }
});
