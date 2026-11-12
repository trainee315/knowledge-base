import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactCredentials } from './redaction.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptCommand } from './transcript.js';
import { openApplication } from '../index.js';
import type { AgentApi, AgentResult, GenerateObjectInput } from '../agent/types.js';
import type { Organization } from '../contracts/index.js';

test('credential redaction handles historical keys, authorization values and known credentials', () => {
  const synthetic = 'sk-' + 'syntheticcredential'.repeat(2);
  const source = JSON.stringify({ messages: [{ content: `已保存测试密钥 ${synthetic}，命令 npm test 失败 E_SYNTHETIC。Bearer synthetic-authentication-value` }] });
  const result = redactCredentials(source, ['custom-known-secret']);
  assert.equal(result.replacements, 2);
  assert.doesNotMatch(result.text, /syntheticcredential|synthetic-authentication/);
  assert.match(JSON.parse(result.text).messages[0].content, /npm test 失败 E_SYNTHETIC/);
  assert.ok(source.includes(synthetic));
  assert.equal(redactCredentials('value=custom-known-secret', ['custom-known-secret']).text, 'value=[REDACTED_CREDENTIAL]');
  assert.equal(redactCredentials('credentialEnv=DEEPSEEK_API_KEY').replacements, 0);
});

test('formal transcript boundary redacts source and response without changing message provenance', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kb-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const dataDir = join(root, 'data');
  await fs.mkdir(sourceRoot);
  const synthetic = 'sk-' + 'only-synthetic-for-test'.repeat(2);
  const row = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type, payload }) + '\n';
  await fs.writeFile(join(sourceRoot, 'session.jsonl'), row('session_meta', { id: 'synthetic-redaction', cwd: root, source: 'cli' }) + row('event_msg', { type: 'task_started' }) + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `测试凭证 ${synthetic}，验证失败。` }] }) + row('event_msg', { type: 'task_complete' }));
  const org = await transcriptCommand(dataDir, 'create', { alias: 'redaction', startDate: '2025-01-01', sourceRoot, maxCalls: 1 }) as Organization;
  const generator: Pick<AgentApi, 'generateObject'> = { async generateObject<T>(input: GenerateObjectInput): Promise<AgentResult<T>> {
    const raw = input.messages.at(-1)!.content;
    assert.ok(!raw.includes(synthetic));
    const messages = JSON.parse(raw).messages;
    assert.match(messages[0].content, /REDACTED_CREDENTIAL/);
    return { value: { title: '验证失败', sections: [{ heading: '未解决事项', body: `验证失败。凭证 ${synthetic}`, evidence: [messages[0].position] }] } as T, profileId: 'synthetic', profileRevision: 1, provider: { id: 'synthetic', version: '1' }, model: 'synthetic', configurationHash: 'synthetic', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
  } };
  await transcriptCommand(dataDir, 'run', { id: org.id }, generator);
  const app = await openApplication(dataDir, { readOnly: true });
  try {
    const saved = await app.manager.getOrganization(org.id);
    const entry = (saved.data.entries as any[])[0];
    const resource = await app.manager.getResource(entry.resourceId);
    const body = (await app.manager.readContent(resource.id)).toString('utf8');
    assert.ok(!body.includes(synthetic));
    assert.match(body, /验证失败/);
    assert.equal(entry.messages[0].position, 2);
    assert.equal(resource.plugins.transcripts.data.redactionVersion, 'credentials-1');
  } finally { await app.close(); }
});
