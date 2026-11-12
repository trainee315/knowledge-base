import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreManager } from '../core/manager.js';
import { callService, handleService } from './client.js';
import type { Organization } from '../contracts/index.js';

test('plugin detail exposes safe projections, enforces CAS and remains readable after plugin failure', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'knowledge-plugin-detail-'));
  const dataDir = resolve(root, 'data');
  try {
    const started = await handleService(['start'], dataDir);
    assert(started.running && 'url' in started);
    const origin = started.url;
    const cli = (words: string[], input: Record<string, unknown> = {}) => callService(dataDir, { words, input });
    async function request(path: string, init?: RequestInit) {
      const response = await fetch(origin + '/api/plugins' + path, init);
      return { status: response.status, ...(await response.json() as any) };
    }
    const patch = (id: string, values: unknown, expectedConfigVersion: string, configKey?: string, headerOrigin = origin) => request('/' + id + '/config', {
      method: 'PATCH', headers: { Origin: headerOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values, expectedConfigVersion, ...(configKey === undefined ? {} : { configKey }) }),
    });

    const list = await request('');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 12);
    for (const { id } of list.data as { id: string }[]) {
      const plugin = await request('/' + id);
      assert.equal(plugin.status, 200);
      assert.equal(plugin.data.id, id);
      assert.ok(plugin.data.description && plugin.data.maintains && plugin.data.collections.length);
      for (const collection of plugin.data.collections as { id: string }[]) {
        const page = await request('/' + id + '/data/' + collection.id + '?limit=1');
        assert.equal(page.status, 200);
        assert.equal(page.data.limit, 1);
        assert.equal(page.data.offset, 0);
      }
    }
    await assert.rejects(readFile(resolve(dataDir, 'state/generation.json')), { code: 'ENOENT' });
    assert.equal((await request('/missing')).status, 404);
    assert.equal((await request('/agent/data/profiles?limit=0')).status, 400);

    const profile = 'plugin-detail-fixture';
    const sentinel = 'PRIVATE_FIXTURE_CREDENTIAL_REF';
    await cli(['agent', 'profile', 'set'], { id: profile, credentialEnv: sentinel, model: 'test-model' });
    const before = (await request('/agent?configKey=' + profile)).data.configuration;
    assert.equal(before.kind, 'form');
    assert.equal(before.key, profile);
    assert.equal(before.values.model, 'test-model');
    assert.doesNotMatch(JSON.stringify(before), new RegExp(sentinel));
    assert.equal((await patch('agent', { model: 'changed' }, before.configVersion, profile, 'https://example.test')).status, 403);
    assert.equal((await patch('agent', { credentialEnv: 'FORBIDDEN' }, before.configVersion, profile)).status, 400);
    await cli(['agent', 'profile', 'set'], { id: profile, model: 'updated-cli' });
    const stale = await patch('agent', { model: 'changed' }, before.configVersion, profile);
    assert.equal(stale.status, 409);
    assert.equal(stale.error.code, 'CONFIG_CONFLICT');

    const current = (await request('/agent?configKey=' + profile)).data.configuration;
    const simultaneous = await Promise.all([
      patch('agent', { maxTokens: 123 }, current.configVersion, profile),
      patch('agent', { maxTokens: 456 }, current.configVersion, profile),
    ]);
    assert.deepEqual(simultaneous.map(item => item.status).sort(), [200, 409]);
    const saved = await cli(['agent', 'profile', 'get'], { id: profile }) as { maxTokens: number };
    assert.equal(saved.maxTokens, simultaneous.find(item => item.status === 200)!.data.configuration.values.maxTokens);

    const relation = (await request('/relations')).data.configuration;
    const relationPatch = await patch('relations', { maxBatchSize: 12, agentProfile: profile }, relation.configVersion);
    assert.equal(relationPatch.status, 200);
    const cleared = await patch('relations', { agentProfile: '' }, relationPatch.data.configuration.configVersion);
    assert.equal(cleared.status, 200);
    assert.equal((await cli(['relation', 'get-config']) as { agentProfile?: string }).agentProfile, undefined);

    const file = resolve(root, 'document.md');
    await writeFile(file, '# Fixture\nPRIVATE_DOCUMENT_BODY');
    const imported = await cli(['resource', 'import'], { file }) as { resource: { id: string } };
    const generation = await readFile(resolve(dataDir, 'state/generation.json'));
    const contents = await request('/content/data/resources?limit=1');
    assert.deepEqual(contents.data.items.map((item: { href: string }) => item.href), ['#resource/' + imported.resource.id]);
    assert.doesNotMatch(JSON.stringify(contents.data), /PRIVATE_DOCUMENT_BODY/);
    assert.deepEqual(await readFile(resolve(dataDir, 'state/generation.json')), generation);
    await cli(['plugin', 'disable'], { id: 'content', cascade: true });
    const disabled = await request('/content');
    assert.equal(disabled.data.status, 'disabled');
    assert.equal((await request('/content/data/resources')).data.total, 1);

    // A broken enabled plugin can fail host initialization; status and other data must remain reachable.
    const manager = await CoreManager.open(dataDir);
    try { await manager.pluginStore('agent').write('profiles', { schemaVersion: 99, profiles: [], secret: 'PRIVATE_INVALID_PROFILE_STATE' }); }
    finally { await manager.close(); }
    const failedList = await request('');
    assert.equal(failedList.status, 200);
    assert.equal(failedList.data.find((plugin: { id: string }) => plugin.id === 'agent').status, 'failed');
    const failed = await request('/agent');
    assert.equal(failed.status, 200);
    assert.equal(failed.data.status, 'failed');
    assert.equal(failed.data.configuration.editable, false);
    assert.doesNotMatch(JSON.stringify(failed.data), /PRIVATE_INVALID_PROFILE_STATE/);
    assert.equal((await request('/content/data/resources')).data.total, 1);
  } finally {
    await handleService(['stop'], dataDir);
    await rm(root, { recursive: true, force: true });
  }
});

test('project-tracking compression form configures selected session with CAS and zero model calls', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'knowledge-compression-form-'));
  const dataDir = resolve(root, 'data'), sourceRoot = resolve(root, 'source');
  try {
    await mkdir(sourceRoot);
    const row = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-01-01T01:00:00Z', type, payload }) + '\n';
    await writeFile(resolve(sourceRoot, 'fixture.jsonl'), row('session_meta', { id: 'fixture', cwd: root, source: 'cli' }) + row('event_msg', { type: 'task_started' }) + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_SESSION_BODY' }] }) + row('event_msg', { type: 'task_complete' }));
    const started = await handleService(['start'], dataDir);
    assert(started.running && 'url' in started);
    const cli = (words: string[], input: Record<string, unknown> = {}) => callService(dataDir, { words, input });
    const origin = started.url;
    async function request(suffix = '', body?: object) {
      const response = await fetch(origin + '/api/plugins/project-tracking' + suffix, body ? { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
      return { status: response.status, ...(await response.json() as any) };
    }
    const patch = (key: string | undefined, expected: string, values: object) => request('/config', { configKey: key, expectedConfigVersion: expected, values });
    assert.equal((await request()).data.configuration.kind, 'link');
    const first = await cli(['transcript', 'create'], { alias: '甲', startDate: '2026-01-01', sourceRoot, maxChunkBytes: 20000, maxInputBytes: 20000 }) as Organization;
    const second = await cli(['transcript', 'create'], { alias: '乙', startDate: '2026-01-01', sourceRoot }) as Organization;
    await cli(['transcript', 'run'], { id: first.id, maxCalls: 0 });
    const before = await cli(['transcript', 'get'], { id: first.id }) as Organization;
    const generation = await readFile(resolve(dataDir, 'state/generation.json'));
    const get = async () => (await request('?configKey=' + first.id)).data.configuration;
    let config = await get();
    assert.equal(config.key, first.id);
    assert.deepEqual(config.fields.find((field: { key: string }) => field.key === 'preprocessing').options.map((option: { value: string }) => option.value), ['off', 'conservative', 'aggressive']);
    assert.ok(config.fields.find((field: { key: string }) => field.key === 'preprocessing').options.every((option: { description: string }) => option.description));
    assert.doesNotMatch(JSON.stringify(config), /PRIVATE_SESSION_BODY|prepared|lease/);
    assert.deepEqual(await readFile(resolve(dataDir, 'state/generation.json')), generation);
    assert.equal((await patch(first.id, config.configVersion, { preprocessing: 'unknown' })).status, 400);
    assert.equal((await patch(undefined, config.configVersion, { preprocessing: 'aggressive' })).status, 400);
    assert.equal((await patch(first.id, config.configVersion, { focus: 'wrong field' })).status, 400);
    for (const mode of ['off', 'conservative', 'aggressive']) {
      const saved = await patch(first.id, config.configVersion, { preprocessing: mode });
      assert.equal(saved.status, 200);
      config = saved.data.configuration;
      const org = await cli(['transcript', 'get'], { id: first.id }) as Organization;
      assert.equal((org.data.config as any).preprocessing, mode);
      assert.deepEqual(org.data.tasks, before.data.tasks);
      assert.deepEqual(org.data.entries, before.data.entries);
      assert.equal(org.data.effectiveFrom, before.data.effectiveFrom);
    }
    assert.equal(((await cli(['transcript', 'get'], { id: second.id }) as Organization).data.config as any).preprocessing, 'conservative');
    await cli(['transcript', 'configure'], { id: first.id, focus: '并发修改' });
    const conflict = await patch(first.id, config.configVersion, { preprocessing: 'off' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.error.code, 'CONFIG_CONFLICT');
    config = await get();
    const racing = await Promise.all([patch(first.id, config.configVersion, { preprocessing: 'off' }), patch(first.id, config.configVersion, { preprocessing: 'conservative' })]);
    assert.deepEqual(racing.map(item => item.status).sort(), [200, 409]);
    const manager = await CoreManager.open(dataDir);
    try {
      const org = await manager.getOrganization(first.id);
      await manager.updateOrganization(org.id, { data: { ...org.data, lease: { token: 'synthetic', expires: Date.now() + 60000 } } }, org.revision);
    } finally { await manager.close(); }
    config = await get();
    assert.equal(config.editable, false);
    assert.match(config.message, /正在转录/);
    assert.equal((await patch(first.id, config.configVersion, { preprocessing: 'aggressive' })).status, 409);
    await cli(['plugin', 'disable'], { id: 'transcripts' });
    assert.equal((await request('?configKey=' + second.id)).data.configuration.editable, false);
  } finally {
    await handleService(['stop'], dataDir);
    await rm(root, { recursive: true, force: true });
  }
});
