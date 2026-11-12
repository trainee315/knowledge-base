import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentService } from './service.js';
import { defaultProfiles } from './profiles.js';
import type { AgentProvider, AgentProviderResponse } from './types.js';
import { openApplication } from '../index.js';

const messages = [{ role: 'user' as const, content: 'A generic writing task' }];
const response = (text = 'ok', model = 'deepseek-flash'): AgentProviderResponse => ({ text, model, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, finishReason: 'stop' });
const provider = (invoke: AgentProvider['invoke'] = async () => response()): AgentProvider => ({ id: 'deepseek', version: 'test-1', invoke });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('semantic identity excludes transport/revision/credential references and in-flight calls retain snapshots', async () => {
  let release!: (value: AgentProviderResponse) => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let requestedModel = '';
  const service = new AgentService({ providers: [provider(async input => { requestedModel = input.profile.model; started(); return new Promise(resolve => { release = resolve; }); })] });
  const original = service.describeProfile();
  await service.configureProfile({ id: original.profileId, timeoutMs: 2000, credentialEnv: 'OTHER_AGENT_CREDENTIAL' });
  assert.equal(service.describeProfile().configurationHash, original.configurationHash); assert.notEqual(service.describeProfile().profileRevision, original.profileRevision);
  const pending = service.generateText({ messages }); await ready;
  const captured = service.describeProfile(); await service.configureProfile({ id: original.profileId, model: 'new-model' });
  release(response('old response', requestedModel)); const result = await pending;
  assert.equal(result.model, 'deepseek-flash'); assert.equal(result.profileRevision, captured.profileRevision); assert.equal(result.configurationHash, captured.configurationHash); assert.notEqual(service.describeProfile().configurationHash, captured.configurationHash);
});

test('canonical upstream model aliases do not change requested semantic identity', async () => {
  const service = new AgentService({ providers: [provider(async () => response('ok', 'canonical-served-model'))] });
  const before = service.describeProfile(); const result = await service.generateText({ messages });
  assert.equal(result.model, before.model); assert.equal(result.actualModel, 'canonical-served-model'); assert.equal(result.configurationHash, before.configurationHash);
});

test('aborted non-cooperative providers retain actual concurrency slots until settled', async () => {
  let release!: (value: AgentProviderResponse) => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let calls = 0;
  const service = new AgentService({ providers: [provider(async () => { calls++; started(); return new Promise(resolve => { release = resolve; }); })], maxConcurrent: 1 });
  const control = new AbortController(); const first = service.generateText({ messages, signal: control.signal }); await ready; control.abort(new Error('must not escape'));
  await assert.rejects(first, error => (error as { code: string }).code === 'AGENT_ABORTED'); assert.equal(service.status().active, 1);
  await assert.rejects(service.generateText({ messages, timeoutMs: 10 }), error => (error as { code: string }).code === 'AGENT_TIMEOUT'); assert.equal(calls, 1); assert.equal(service.status().queued, 0);
  release(response()); await pause(0); assert.equal(service.status().active, 0); service.stop();
  await assert.rejects(service.generateText({ messages }), error => (error as { code: string }).code === 'AGENT_STOPPED');
});

test('profile whitelist rejects secrets, nulls, stale revisions and failed persistence without mutation', async () => {
  let writes = 0; const service = new AgentService({ providers: [provider()], saveProfiles: async () => { writes++; throw new Error('storage unavailable'); } }); const before = service.listProfiles();
  for (const bad of [{ id: 'a', apiKey: 'fixture-not-a-key' }, { id: 'a', credentialEnv: null }, { id: 'a', maxTokens: null }, { id: 'a', timeoutMs: 1.5 }, { id: 'a', reasoning: 'deepseek-specific' }]) await assert.rejects(service.configureProfile(bad as never), error => (error as { code: string }).code === 'AGENT_INVALID_INPUT');
  await assert.rejects(service.configureProfile({ id: 'deepseek-default', expectedRevision: 99 }), error => (error as { code: string }).code === 'AGENT_PROFILE_CONFLICT'); assert.equal(writes, 0);
  await assert.rejects(service.configureProfile({ id: 'deepseek-default', model: 'new-model' }), error => (error as { code: string }).code === 'AGENT_CONFIG_WRITE_FAILED'); assert.deepEqual(service.listProfiles(), before);
});

test('schema snapshots remain stable and unknown provider exceptions are sanitized', async () => {
  let release!: (value: AgentProviderResponse) => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); const service = new AgentService({ providers: [provider(async () => { started(); return new Promise(resolve => { release = resolve; }); })] });
  const schema = { type: 'object' as const, properties: { title: { type: 'string' as const } }, required: ['title'], additionalProperties: false };
  const result = service.generateObject<{ title: string }>({ messages, schema }); await ready; schema.properties.title.type = 'number' as 'string'; release(response('{"title":"old schema"}')); assert.equal((await result).value.title, 'old schema');
  const failing = new AgentService({ providers: [{ ...provider(async () => { throw new Error('private-response-detail'); }), isConfigured() { throw new Error('private-status-detail'); } }] });
  assert.equal(failing.status().profiles[0].credentialConfigured, false);
  await assert.rejects(failing.generateText({ messages }), error => { assert.equal((error as { code: string }).code, 'AGENT_PROVIDER_ERROR'); assert(!JSON.stringify(error).includes('private')); return true; });
});

test('agent CLI inspection is read-only without keys and profiles/backups only persist references', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-agent-config-')); const dataDir = path.join(dir, 'data'); const cli = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  const env = { ...process.env }; delete env.DEEPSEEK_API_KEY;
  try {
    const started = spawnSync(process.execPath, [cli, 'service', 'start', '--data-dir', dataDir, '--json'], { encoding: 'utf8', env });
    assert.equal(started.status, 0, started.stdout + started.stderr);
    for (const args of [['status'], ['profile', 'list'], ['profile', 'get'], ['config', 'get']]) { const child = spawnSync(process.execPath, [cli, 'agent', ...args, '--data-dir', dataDir, '--json'], { encoding: 'utf8', env }); assert.equal(child.status, 0, child.stdout); assert.equal(JSON.parse(child.stdout).ok, true); }
    await assert.rejects(readFile(path.join(dataDir, 'state/generation.json')), { code: 'ENOENT' });
    const app = await openApplication(dataDir);
    try {
      await app.plugins.execute('agent profile set', { id: 'deepseek-default', credentialEnv: 'AGENT_TEST_ENV', maxTokens: 100 }, []);
      const stored = await readFile(path.join(dataDir, 'plugins/agent/data/profiles.json'), 'utf8'); assert(stored.includes('AGENT_TEST_ENV')); assert(!stored.includes('apiKey'));
      await assert.rejects(app.plugins.execute('agent profile set', { id: 'deepseek-default', apiKey: 'forbidden-fixture' }, []));
      assert.equal(await readFile(path.join(dataDir, 'plugins/agent/data/profiles.json'), 'utf8'), stored);
      const backup = path.join(dir, 'backup.json'); await app.manager.backup(backup); const encoded = JSON.parse(await readFile(backup, 'utf8')); const all = encoded.entries.map((entry: { content: string }) => Buffer.from(entry.content, 'base64').toString('utf8')).join('\n'); assert(!all.includes('forbidden-fixture'));
      const reader = spawnSync(process.execPath, [cli, 'agent', 'status', '--data-dir', dataDir, '--json'], { encoding: 'utf8', env }); assert.equal(reader.status, 0, reader.stdout);
    } finally { await app.close(); }
  } finally {
    spawnSync(process.execPath, [cli, 'service', 'stop', '--data-dir', dataDir, '--json'], { encoding: 'utf8', env });
    await rm(dir, { recursive: true, force: true });
  }
});
