import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInput } from './preprocess.js';
import { stripPayloads, sourcePaths } from './payloads.js';
import { prepareTranscriptInput } from './transcript.js';
import { hash } from './common.js';
import type { Message } from './source.js';
import { configuration, discoveryChanged } from './config.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSession } from './source.js';
import { aggressiveCall } from './aggressive.js';

const message = (position: number, role: string, content: string, toolCallId?: string): Message => ({ position, role, content, at: '2026-01-01T00:00:00Z', fingerprint: hash(content), ...(toolCallId ? { toolCallId } : {}) });
const encoded = Buffer.from('synthetic binary audio payload '.repeat(100)).toString('base64');

test('all modes strip media, data URLs and long encoding while preserving short semantic values', () => {
  const bodies = [
    JSON.stringify([{ type: 'input_audio', input_audio: { data: encoded, format: 'wav' } }]),
    JSON.stringify({ type: 'input_video', data: 'data:video/mp4;base64,' + encoded }),
    JSON.stringify({ file_path: 'D:/assets/archive.zip', base64: encoded }),
    'data:application/octet-stream;base64,' + encoded,
    encoded,
    'deadbeef'.repeat(200),
    JSON.stringify({ type: 'Buffer', data: Array(100).fill(255) }),
    JSON.stringify({ encoding: 'base85', data: 'Ab0+'.repeat(200), path: 'D:/assets/archive.zip' }),
    '\\xff'.repeat(100),
    '01010101 '.repeat(100).trim(),
    encoded.match(/.{1,76}/g)!.join('\n'),
    Array.from({ length: 5 }, (_, index) => index.toString(16).padStart(8, '0') + ': ' + 'ff '.repeat(16)).join('\n'),
  ];
  for (const mode of ['off', 'conservative', 'aggressive'] as const) for (const body of bodies) {
    const result = cleanInput([], [message(1, 'user', '错误码0x80070005，位掩码0xff，hash=' + 'a'.repeat(64) + '\n' + body)], mode);
    assert.doesNotMatch(result.messages[0].content, new RegExp(encoded.slice(0, 100)));
    assert.doesNotMatch(result.messages[0].content, /data:|deadbeefdeadbeef|ff ff ff ff ff/);
    assert.match(result.messages[0].content, /0x80070005/);
    assert.match(result.messages[0].content, new RegExp('a'.repeat(64)));
    assert.match(result.messages[0].content, /文件路径/);
  }
});

test('payload removal handles nested and truncated results and never invents ambiguous paths', () => {
  const code = 'const image = await tools.view_image({path:"D:/assets/a.png"}); image(image.image_url);';
  const call = message(1, 'tool-call', 'exec\n' + JSON.stringify({ code }), 'first');
  const second = message(2, 'tool-call', 'exec\n' + JSON.stringify({ code: 'view_image({path:"D:/assets/b.png"})' }), 'second');
  const response = message(3, 'tool-result', JSON.stringify([{ type: 'input_image', image_url: 'data:image/png;base64,' + encoded }]), 'first');
  const result = cleanInput([], [call, second, response], 'off');
  assert.match(result.messages[2].content, /D:\/assets\/a.png/);
  assert.doesNotMatch(result.messages[2].content, /b.png|sha256|字节/);
  assert.deepEqual(sourcePaths('exec\n' + JSON.stringify({ code })), ['D:/assets/a.png']);
  assert.match(stripPayloads('Output truncated\n' + JSON.stringify({ output: 'data:audio/wav;base64,' + encoded })), /文件路径未知/);
  const ambiguous = stripPayloads('data:image/png;base64,' + encoded, ['D:/a.png', 'D:/b.png']);
  assert.equal(ambiguous, '[文件路径未知]');
  const explicit = stripPayloads(JSON.stringify({ original_path: 'D:/sound.wav', bytes: Array(100).fill(100) }));
  assert.match(explicit, /D:\/sound.wav/);
  assert.doesNotMatch(explicit, /100,100/);
});

test('aggressive mode reduces file dumps and orchestration while retaining spoken facts and failure evidence', () => {
  const spoken = message(1, 'user', '纠正为8，开发机10%退化不可接受，方案已撤回。');
  const output = Array.from({ length: 1000 }, (_, index) => `const field${index} = "routine implementation";`).join('\n') + '\nrequireValue(maxBytes <= 128 * 1024, "请求上限128KiB");\nℹ tests 88\nℹ pass 88\nℹ fail 0';
  const calls = 'exec\n' + JSON.stringify({ code: 'for(let n=0;n<100;n++){ await tools.exec_command({cmd:"npm test",workdir:"D:/project/example"}); }\n' + '// polling\n'.repeat(1000) });
  const original = [spoken, message(2, 'tool-call', calls), message(3, 'tool-result', JSON.stringify({ output, exit_code: 0 })), message(4, 'tool-result', JSON.stringify({ output: 'ERROR E_SYNTHETIC\n at source.ts:9\n' + 'diagnostic\n'.repeat(1000), exit_code: 1 }))];
  const conservative = cleanInput([], original);
  const aggressive = cleanInput([], original, 'aggressive');
  assert.equal(aggressive.messages[0].content, spoken.content);
  assert.match(aggressive.messages[1].content, /npm test/);
  assert.match(aggressive.messages[2].content, /128KiB|128 \* 1024/);
  assert.match(aggressive.messages[2].content, /ℹ pass 88/);
  assert.match(aggressive.messages[2].content, /原消息 3/);
  assert.match(aggressive.messages[3].content, /diagnostic\ndiagnostic/);
  assert.match(aggressive.messages[3].content, /E_SYNTHETIC/);
  assert.ok(aggressive.stats.after.characters < conservative.stats.after.characters / 2);
  assert.equal(aggressive.messages[2].fingerprint, original[2].fingerprint);
  const request = JSON.parse(prepareTranscriptInput('', [], original, 'aggressive').text);
  assert.equal(request.messages[0].fingerprint, undefined);
  assert.equal(request.messages[0].position, 1);
  assert.ok(request.sourceTime.from);
  assert.ok(prepareTranscriptInput('', [], original, 'aggressive').bytes < prepareTranscriptInput('', [], original).bytes);
  assert.equal(discoveryChanged(configuration({ alias: 'test', startDate: '2026-01-01' }), configuration({ alias: 'test', startDate: '2026-01-01', preprocessing: 'aggressive' })), false);
});

test('source call association preserves existing fingerprints', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kb-tool-association-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const row = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type, payload }) + '\n';
  const file = join(root, 'source.jsonl');
  await fs.writeFile(file, row('session_meta', { id: 'fixture', cwd: root, source: 'cli' }) + row('response_item', { type: 'function_call', name: 'view_image', arguments: '{"path":"D:/a.png"}', call_id: 'same' }) + row('response_item', { type: 'function_call_output', output: 'data:image/png;base64,' + encoded, call_id: 'same' }));
  const session = await readSession(file, Date.now());
  const item = session.turns[0].messages[0];
  assert.equal(item.toolCallId, 'same');
  assert.equal(item.fingerprint, hash(JSON.stringify({ position: item.position, at: item.at, role: item.role, content: item.content })));
});

test('mixed command and patch scripts retain conditions inside literal patches', () => {
  const patch = '*** Begin Patch\n*** Add File: limits.ts\n' + '+const routine = true;\n'.repeat(300) + '+requireValue(size <= 128 * 1024, "上限128KiB");\n+// projectDir/intervalMinutes 用 JSON null 显式清除，省略沿用旧值。\n*** End Patch';
  const code = 'text(await tools.exec_command({cmd:"npm test",sandbox_permissions:"require_escalated",justification:"沙箱内已出现 connect EACCES，需沙箱外复测"}));\ntext(await tools.apply_patch(' + JSON.stringify(patch) + '));';
  const cleaned = aggressiveCall('exec\n' + JSON.stringify({ code }), 44);
  assert.match(cleaned, /npm test/);
  assert.match(cleaned, /128KiB/);
  assert.match(cleaned, /null 显式清除/);
  assert.match(cleaned, /sandbox_permissions=require_escalated/);
  assert.match(cleaned, /沙箱内已出现 connect EACCES/);
  assert.match(cleaned, /原消息 44/);
});
