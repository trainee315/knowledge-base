import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanInput, textSize } from './preprocess.js';
import { hash } from './common.js';
import type { Message } from './source.js';
import { transcriptCommand, prepareTranscriptInput } from './transcript.js';
import { openApplication } from '../index.js';
import type { AgentApi, GenerateObjectInput } from '../agent/types.js';
import type { Organization } from '../contracts/index.js';
import { configuration, discoveryChanged } from './config.js';

function message(position: number, role: string, content: string): Message {
  return { position, role, content, fingerprint: hash(content), at: '2026-01-01T01:00:00Z' };
}
const successful = '✔ alpha (1.2ms)\n✔ beta (2ms)\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 3.2\n';
const wrapper = (output: string, exitCode = 0) => JSON.stringify([{ type: 'input_text', text: 'Script completed\nWall time 1.2 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ chunk_id: 'synthetic', exit_code: exitCode, output, wall_time_seconds: 1 }) }]);

test('preprocessing preserves conversation, commands, provenance and Unicode character counts', () => {
  const originals = [message(1, 'user', '改为8，保留条件😀\r\n'), message(2, 'assistant', '仅计划，测试未通过。'), message(3, 'tool-call', 'apply_patch\n*** actual code ***')];
  const result = cleanInput([], originals);
  assert.deepEqual(result.messages, originals);
  assert.deepEqual(cleanInput([], [message(4, 'tool-result', wrapper(successful))], 'off').messages[0].content, wrapper(successful));
  assert.deepEqual(textSize('中😀\r\n'), { characters: 4, bytes: 9 });
  assert.equal(result.stats.before.characters, originals.reduce((sum, item) => sum + [...item.content].length, 0));
});

test('recognized wrappers and complete successful test streams compact with diagnostic fallback', () => {
  const result = cleanInput([], [message(1, 'tool-result', wrapper(successful))]);
  assert.match(result.messages[0].content, /exit_code=0/);
  assert.match(result.messages[0].content, /ℹ tests 2/);
  assert.doesNotMatch(result.messages[0].content, /✔ alpha/);
  assert.ok(result.stats.after.characters < result.stats.before.characters);
  assert.deepEqual(result.stats.changes.map(change => change.rule), ['tool-wrapper', 'successful-test-lines']);
  for (const body of [successful.replace('ℹ fail 0', 'ℹ fail 1') + 'ERROR E_SYNTHETIC\n at source.ts:9', successful.replace('ℹ duration_ms 3.2', ''), 'unknown\rmeaningful', JSON.stringify({ output: 'keep', undocumented: true }), 'truncated output\n' + wrapper(successful)]) {
    const raw = body.startsWith('truncated') ? body : wrapper(body);
    const cleaned = cleanInput([], [message(1, 'tool-result', raw)]).messages[0].content;
    assert.ok(cleaned.includes(body), body);
  }
  const image = JSON.stringify([{ type: 'input_image', image_url: 'synthetic' }]);
  assert.equal(cleanInput([], [message(1, 'tool-result', image)]).messages[0].content, image);
});

test('terminal formatting and duplicates preserve statuses and stay within an input segment', () => {
  const content = '\u001b[31mcritical condition\u001b[0m\n' + 'condition\n'.repeat(100);
  const first = message(1, 'tool-result', wrapper(content)), second = message(2, 'tool-result', wrapper(content));
  const result = cleanInput([], [first, second]);
  assert.doesNotMatch(result.messages[0].content, /\u001b/u);
  assert.match(result.messages[1].content, /消息 1 完全相同/);
  assert.equal(result.messages[1].fingerprint, second.fingerprint);
  assert.match(cleanInput([], [second]).messages[0].content, /critical condition/);
  const changed = cleanInput([], [first, message(3, 'tool-result', wrapper(content, 1))]);
  assert.match(changed.messages[1].content, /exit_code=1/);
  assert.doesNotMatch(changed.messages[1].content, /完全相同/);
  assert.match(cleanInput([], [message(4, 'tool-result', wrapper(successful, 1))]).messages[0].content, /✔ alpha/);
});

test('image encoding becomes only a source path and preserves original provenance', () => {
  const bytes = Buffer.from('synthetic image bytes');
  const content = JSON.stringify([{ type: 'input_text', text: '截图已保存，尚待用户验收。' }, { type: 'input_image', image_url: 'data:image/png;base64,' + bytes.toString('base64'), detail: 'original' }]);
  const result = cleanInput([], [{ ...message(98, 'tool-call', 'view_image\n{"path":"D:/assets/texture.png"}'), toolCallId: 'asset' }, { ...message(99, 'tool-result', content), toolCallId: 'asset' }]);
  assert.match(result.messages[1].content, /截图已保存，尚待用户验收/);
  assert.match(result.messages[1].content, /D:\/assets\/texture.png/);
  assert.doesNotMatch(result.messages[1].content, /sha256|字节|base64/);
  assert.equal(result.messages[1].fingerprint, hash(content));
  for (const image_url of ['https://example.invalid/image.png']) {
    const unknown = JSON.stringify([{ type: 'input_image', image_url }]);
    assert.equal(cleanInput([], [message(1, 'tool-result', unknown)]).messages[0].content, unknown);
  }
});

test('long single-line tool output is preserved with linear formatting cleanup', () => {
  const content = 'x'.repeat(200_000);
  const started = performance.now();
  assert.equal(cleanInput([], [message(1, 'tool-result', content)]).messages[0].content, content);
  assert.ok(performance.now() - started < 5000);
});

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-preprocess-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'sessions'), data = path.join(root, 'data');
  await fs.mkdir(sourceRoot);
  const row = (timestamp: string, type: string, payload: object) => JSON.stringify({ timestamp, type, payload });
  const at = '2026-01-01T01:00:00Z', future = '2026-01-02T01:00:00Z';
  const turn = (time: string) => [row(time, 'event_msg', { type: 'task_started' }), row(time, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '纠正为8；实施和验证分开。' }] }), row(time, 'response_item', { type: 'function_call_output', output: wrapper(successful.repeat(5)) }), row(time, 'event_msg', { type: 'task_complete' })];
  await fs.writeFile(path.join(sourceRoot, 'synthetic.jsonl'), [row(at, 'session_meta', { id: 'synthetic', cwd: root, source: 'cli' }), ...turn(at), ...turn(future)].join('\n') + '\n');
  const org = await transcriptCommand(data, 'create', { alias: 'synthetic', startDate: '2026-01-01', sourceRoot, maxInputBytes: 20000, maxChunkBytes: 20000 }) as Organization;
  return { data, sourceRoot, org };
}
function generator(inputs: GenerateObjectInput[], fail = false): Pick<AgentApi, 'generateObject'> {
  return { async generateObject<T>(input: GenerateObjectInput) {
    inputs.push(input);
    if (fail) throw new Error('synthetic failure');
    return { value: { title: '合成', sections: [{ heading: '纠正', body: '纠正为8，尚未验证通过。', evidence: JSON.parse(input.messages.at(-1)!.content).messages.map((m: Message) => m.position) }] } as T, profileId: 'test', profileRevision: 1, provider: { id: 'fake', version: '1' }, model: 'fake', configurationHash: 'fake', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' };
  } };
}

test('preview exposes cleaning, fixed run cutoff and configuration changes preserve successful progress', async t => {
  const { data, org } = await fixture(t);
  const before = await fs.readFile(path.join(data, 'organizations', org.id + '.json'));
  const preview = await transcriptCommand(data, 'preview', { id: org.id, to: '2026-01-01T23:59:59Z' }) as any;
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].messageCount, 2);
  assert.ok(preview.candidates[0].cleaning.stats.after.characters < preview.candidates[0].cleaning.stats.before.characters);
  assert.deepEqual(await fs.readFile(path.join(data, 'organizations', org.id + '.json')), before);
  const inputs: GenerateObjectInput[] = [];
  await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 1 }, generator(inputs));
  await transcriptCommand(data, 'configure', { id: org.id, preprocessing: 'off' });
  await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 1 }, generator(inputs));
  assert.equal(inputs.length, 1);
  const app = await openApplication(data, { readOnly: true });
  try {
    const state = (await app.manager.getOrganization(org.id)).data as any;
    const metadata = (await app.manager.getResource(state.entries[0].resourceId)).plugins.transcripts.data as any;
    assert.equal(metadata.preprocessing.cleaning.mode, 'conservative');
    assert.deepEqual(metadata.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    assert.equal(state.tasks[0].prepared, undefined);
  } finally { await app.close(); }
  const config = configuration({ alias: 'x', startDate: '2026-01-01' });
  assert.equal(discoveryChanged(config, { ...config, preprocessing: 'off' }), false);
  assert.throws(() => configuration({ ...config, preprocessing: 'invalid' }));
});

test('frozen prepared input survives retries and legacy pending tasks retain original format', async t => {
  const { data, org } = await fixture(t);
  const inputs: GenerateObjectInput[] = [];
  await assert.rejects(transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 1 }, generator(inputs, true)));
  await transcriptCommand(data, 'configure', { id: org.id, preprocessing: 'off', focus: 'changed focus' });
  await transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, generator(inputs));
  assert.equal(inputs[0].messages.at(-1)!.content, inputs[1].messages.at(-1)!.content);
  assert.deepEqual(inputs[0].messages, inputs[1].messages);
  assert.deepEqual(inputs[0].schema, inputs[1].schema);
  const legacy = await fixture(t);
  await transcriptCommand(legacy.data, 'run', { id: legacy.org.id, to: '2026-01-01T23:59:59Z', maxCalls: 0 });
  const app = await openApplication(legacy.data);
  try {
    const current = await app.manager.getOrganization(legacy.org.id), state = current.data as any;
    delete state.tasks[0].prepared; delete state.tasks[0].config.preprocessing;
    await app.manager.updateOrganization(current.id, { data: state }, current.revision);
  } finally { await app.close(); }
  const oldInputs: GenerateObjectInput[] = [];
  await transcriptCommand(legacy.data, 'retry', { id: legacy.org.id, maxCalls: 1 }, generator(oldInputs));
  assert.match(oldInputs[0].messages.at(-1)!.content, /Script completed/);
});

test('prepared input redacts credentials and cleaned input determines segment budgets', () => {
  const content = wrapper('source key sk-syntheticCredential012345678901234567890\n' + successful);
  const raw = [message(1, 'tool-result', content), message(2, 'tool-result', content)];
  const prepared = prepareTranscriptInput('', [], raw);
  assert.doesNotMatch(prepared.text, /sk-syntheticCredential/);
  assert.equal(prepared.fingerprint, hash(prepared.text));
  assert.ok(prepared.bytes < prepareTranscriptInput('', [], raw, 'off').bytes);
});

test('cleaned complete turns fit a budget that rejects raw turns, and preview overrides are read only', async t => {
  const { data, org } = await fixture(t);
  const input = { id: org.id, to: '2026-01-01T23:59:59Z' };
  const cleaned = await transcriptCommand(data, 'preview', input) as any;
  const raw = await transcriptCommand(data, 'preview', { ...input, preprocessing: 'off' }) as any;
  assert.ok(raw.inputBytes > cleaned.inputBytes);
  const maxChunkBytes = Math.floor((raw.inputBytes + cleaned.inputBytes) / 2);
  await transcriptCommand(data, 'configure', { id: org.id, maxChunkBytes });
  assert.equal((await transcriptCommand(data, 'preview', input) as any).candidates.length, 1);
  const blocked = await transcriptCommand(data, 'preview', { ...input, preprocessing: 'off' }) as any;
  assert.ok(blocked.skips.some((skip: any) => skip.reason === 'oversized-turn'));
});

test('frozen input tampering fails explicitly before a model call', async t => {
  const { data, org } = await fixture(t);
  await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 0 });
  const app = await openApplication(data);
  try {
    const current = await app.manager.getOrganization(org.id), state = current.data as any;
    state.tasks[0].prepared.text += 'tampered';
    await app.manager.updateOrganization(current.id, { data: state }, current.revision);
  } finally { await app.close(); }
  const inputs: GenerateObjectInput[] = [];
  await assert.rejects(transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, generator(inputs)), /冻结输入指纹不一致/);
  assert.equal(inputs.length, 0);
});

test('fixed run cutoff defers newer frozen tasks until an explicit retry', async t => {
  const { data, org } = await fixture(t);
  await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-03T00:00:00Z', maxCalls: 0 });
  const inputs: GenerateObjectInput[] = [];
  const result = await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 1 }, generator(inputs)) as any;
  assert.equal(result.calls, 0);
  assert.equal(result.deferred, 1);
  assert.equal(result.remaining, 1);
  await transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, generator(inputs));
  assert.equal(inputs.length, 1);
});

test('frozen system prompt and schema are included in request integrity checks', async t => {
  const { data, org } = await fixture(t);
  await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 0 });
  const app = await openApplication(data);
  try {
    const current = await app.manager.getOrganization(org.id), state = current.data as any;
    state.tasks[0].prepared.prompt += 'tampered';
    await app.manager.updateOrganization(current.id, { data: state }, current.revision);
  } finally { await app.close(); }
  const inputs: GenerateObjectInput[] = [];
  await assert.rejects(transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, generator(inputs)), /冻结请求指纹不一致/);
  assert.equal(inputs.length, 0);
});

test('legacy pending inputs migrate only payload policy and freeze the sanitized retry material', async t => {
  const encoded = Buffer.from('synthetic audio bytes '.repeat(100)).toString('base64');
  for (const preparedLegacy of [true, false]) {
    const { data, org } = await fixture(t);
    await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 0 });
    const app = await openApplication(data);
    let positions: number[];
    let prompt: string | undefined;
    try {
      const current = await app.manager.getOrganization(org.id), state = current.data as any;
      const task = state.tasks[0];
      task.messages[0].content += '\nD:/assets/audio.wav\ndata:audio/wav;base64,' + encoded;
      task.messages[0].fingerprint = hash(task.messages[0].content);
      positions = task.messages.map((item: Message) => item.position);
      if (preparedLegacy) {
        const payload = JSON.parse(task.prepared.text);
        payload.messages = task.messages;
        task.prepared.text = JSON.stringify(payload);
        task.prepared.fingerprint = hash(task.prepared.text);
        task.prepared.cleaning.version = 'legacy-before-payload-policy';
        task.prepared.requestFingerprint = hash(JSON.stringify({ prompt: task.prepared.prompt, schema: task.prepared.schema, text: task.prepared.text }));
        prompt = task.prepared.prompt;
      } else delete task.prepared;
      await app.manager.updateOrganization(current.id, { data: state }, current.revision);
    } finally { await app.close(); }
    const inputs: GenerateObjectInput[] = [];
    await assert.rejects(transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, generator(inputs, true)));
    assert.doesNotMatch(inputs[0].messages.at(-1)!.content, /data:audio|c3ludGhldGlj/);
    assert.match(inputs[0].messages.at(-1)!.content, /D:\/assets\/audio.wav/);
    assert.deepEqual(JSON.parse(inputs[0].messages.at(-1)!.content).messages.map((item: Message) => item.position), positions!);
    if (prompt) assert.equal(inputs[0].messages[0].content, prompt);
    else assert.doesNotMatch(inputs[0].messages[0].content, /覆盖每个独立事务/);
    await transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, generator(inputs));
    assert.deepEqual(inputs[1].messages, inputs[0].messages);
  }
});

test('cached legacy model results recover without calls and output payloads become source paths', async t => {
  const { data, org } = await fixture(t);
  await transcriptCommand(data, 'run', { id: org.id, to: '2026-01-01T23:59:59Z', maxCalls: 0 });
  const app = await openApplication(data);
  try {
    const current = await app.manager.getOrganization(org.id), state = current.data as any;
    const task = state.tasks[0];
    delete task.prepared;
    const input = { messages: [{ role: 'user', content: JSON.stringify({ messages: task.messages }) }] } as GenerateObjectInput;
    task.result = await generator([]).generateObject(input);
    task.result.value.sections[0].body += '\nD:/assets/video.mp4\ndata:video/mp4;base64,' + Buffer.from('synthetic video'.repeat(100)).toString('base64');
    await app.manager.updateOrganization(current.id, { data: state }, current.revision);
  } finally { await app.close(); }
  const inputs: GenerateObjectInput[] = [];
  const outcome = await transcriptCommand(data, 'retry', { id: org.id, maxCalls: 0 }, generator(inputs)) as any;
  assert.equal(outcome.saved, 1);
  assert.equal(inputs.length, 0);
  const reader = await openApplication(data, { readOnly: true });
  try {
    const state = (await reader.manager.getOrganization(org.id)).data as any;
    const body = (await reader.manager.readContent(state.entries[0].resourceId)).toString();
    assert.match(body, /D:\/assets\/video.mp4/);
    assert.doesNotMatch(body, /data:|c3ludGhldGlj/);
  } finally { await reader.close(); }
});
