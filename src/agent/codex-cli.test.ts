import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentService } from './service.js';
import { CodexCliProvider, parseCodexOutput } from './codex-cli.js';
import { runCodexProcess, subscriptionEnvironment } from './codex-process.js';
import { mergeProfile, profileHash } from './profiles.js';

const SCHEMA = { type: 'object' as const, properties: { ok: { type: 'boolean' as const, const: true } }, required: ['ok'], additionalProperties: false };
const messages = [{ role: 'user' as const, content: 'input contains $(echo secret) and 中文😀' }];
const event = (type: string, value: object) => JSON.stringify({ type, ...value });
const completed = event('turn.completed', { usage: { input_tokens: 10, output_tokens: 2 } });

async function fixture(mode = 'ok') {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-codex-fixture-'));
  const capture = path.join(root, 'capture.json');
  const script = path.join(root, 'fixture.mjs');
  await writeFile(script, `import fs from 'node:fs';
const args = process.argv.slice(2), mode = process.env.FIXTURE_MODE;
if(args.includes('--version')) { console.log(mode === 'old' ? 'codex-cli 0.100.0' : 'codex-cli 0.167.2'); }
else if(args.includes('login')) { console.error(mode === 'logout' ? 'Not logged in' : mode === 'api' ? 'Logged in using an API key' : 'Logged in using ChatGPT'); process.exitCode = mode === 'logout' ? 1 : 0; }
else {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const index = args.indexOf('--output-schema');
  fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({args, input, pid:process.pid, cwd:process.cwd(), schema:index >= 0 ? JSON.parse(fs.readFileSync(args[index+1],'utf8')) : null, api:process.env.OPENAI_API_KEY, secret:process.env.DEEPSEEK_API_KEY}));
  if(mode === 'hang') { setInterval(()=>{},1000); }
  else if(mode === 'exit') { console.error('private raw error'); process.exitCode=7; }
  else if(mode === 'rate') console.log(JSON.stringify({type:'turn.failed',error:{message:'429 usage limit private'}}));
  else { console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:mode === 'bad-json' ? 'not json' : index >= 0 ? '{"ok":true}' : '中文😀'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:mode === 'large' ? 99999 : 2}})); }
}
`);
  const provider = new CodexCliProvider({ command: { file: process.execPath, args: [script] }, env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_CAPTURE: capture, OPENAI_API_KEY: 'secret-one', DEEPSEEK_API_KEY: 'secret-two' } });
  const profile = mergeProfile({ id: 'codex-test', providerId: 'codex-cli', model: 'chosen-model', timeoutMs: 5000 });
  const service = new AgentService({ providers: [provider], profiles: [profile], maxConcurrent: 1 });
  return { root, capture, provider, profile, service, async close() { service.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('Codex subscription configuration has no fake credentials; changes affect identity', () => {
  const profile = mergeProfile({ id: 'cli', providerId: 'codex-cli', model: 'selected' });
  assert.equal(profile.credentialEnv, '');
  assert.notEqual(profileHash(profile, '1'), profileHash({ ...profile, reasoningEffort: 'high' }, '1'));
  assert.throws(() => mergeProfile({ id: 'bad', providerId: 'codex-cli', temperature: 0.7 }), { code: 'AGENT_UNSUPPORTED_OPTION' });
  assert.throws(() => mergeProfile({ id: 'bad', providerId: 'codex-cli', credentialEnv: 'KEY' }), { code: 'AGENT_INVALID_INPUT' });
  assert.throws(() => mergeProfile({ id: 'bad', reasoningEffort: 'invalid' as never }), { code: 'AGENT_INVALID_INPUT' });
  assert.deepEqual(subscriptionEnvironment({ OPENAI_API_KEY: 'a', CODEX_API_KEY: 'b', DEEPSEEK_API_KEY: 'c', CODEX_HOME: 'home', PATH: 'path' }), { CODEX_HOME: 'home', PATH: 'path' });
});

test('Codex sends chosen model/schema over isolated exec; JSONL and Unicode round-trip', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.provider.check()).state, 'ready');
    assert.equal(f.service.status().profiles[0].readiness, 'unchecked');
    const result = await f.service.generateObject({ profile: f.profile.id, messages, schema: SCHEMA });
    assert.deepEqual(result.value, { ok: true }); assert.equal(result.model, 'chosen-model'); assert.equal(result.actualModel, undefined);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(capture.args[capture.args.indexOf('--model')+1], 'chosen-model');
    assert(capture.args.includes('--ephemeral')); assert(capture.args.includes('--ignore-user-config')); assert(capture.args.includes('forced_login_method="chatgpt"'));
    assert.deepEqual(capture.schema, SCHEMA); assert.equal(capture.api, undefined); assert.equal(capture.secret, undefined);
    assert(!capture.args.join(' ').includes('echo secret')); assert(capture.input.includes('中文😀'));
    await assert.rejects(stat(capture.cwd), { code: 'ENOENT' });
    const text = await f.service.generateText({ profile: f.profile.id, messages });
    assert.equal(text.value, '中文😀');
  } finally { await f.close(); }
});

test('Codex checks fail closed without inference or raw diagnostics', async () => {
  for (const [mode, state] of [['old', 'unsupported'], ['logout', 'not-logged-in'], ['api', 'not-logged-in']]) {
    const f = await fixture(mode);
    try { assert.equal((await f.provider.check()).state, state); await assert.rejects(f.service.generateText({ profile: f.profile.id, messages })); await assert.rejects(readFile(f.capture), { code: 'ENOENT' }); }
    finally { await f.close(); }
  }
  assert.equal((await new CodexCliProvider({ command: { file: path.join(tmpdir(), 'missing-codex-executable'), args: [] } }).check()).state, 'missing');
});

test('Codex handles bad output, process failure, limits and output acceptance budget', async () => {
  for (const [mode, code] of [['exit', 'AGENT_PROVIDER_ERROR'], ['rate', 'AGENT_RATE_LIMITED'], ['bad-json', 'AGENT_INVALID_JSON'], ['large', 'AGENT_TRUNCATED']]) {
    const f = await fixture(mode);
    try { await assert.rejects(f.service.generateObject({ profile: f.profile.id, messages, schema: SCHEMA }), (error: any) => { assert.equal(error.code, code); assert(!JSON.stringify(error).includes('private')); return true; }); }
    finally { await f.close(); }
  }
  for (const output of ['', '{}', 'garbage', event('item.completed', { item: { type: 'agent_message', text: 'ok' } }), completed + '\n' + completed]) assert.throws(() => parseCodexOutput(output, 0, 'model'));
  assert.throws(() => parseCodexOutput(event('item.completed', { item: { type: 'agent_message', text: 'ok' } })+'\n'+completed, 3, 'model'));
});

test('Codex cancellation kills the actual process and cleans isolated working files', async () => {
  const f = await fixture('hang');
  try {
    const controller = new AbortController();
    const result = f.provider.invoke({ profile: f.profile, messages, output: 'text', maxTokens: 100, temperature: 0, reasoning: 'off' }, controller.signal);
    const rejection = assert.rejects(result, { code: 'AGENT_ABORTED' });
    let capture: any;
    for (let index=0; index<100; index++) { try { capture = JSON.parse(await readFile(f.capture, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    assert(capture); controller.abort(); await rejection;
    assert.throws(() => process.kill(capture.pid, 0));
    await assert.rejects(stat(capture.cwd), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('Codex process output is bounded', async () => {
  await assert.rejects(runCodexProcess({ file: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(5*1024*1024));setInterval(()=>{},1000)'] }, [], tmpdir(), process.env, AbortSignal.timeout(5000)), { code: 'AGENT_INVALID_RESPONSE' });
});

test('Codex service timeout eventually releases actual process slot', async () => {
  const f = await fixture('hang');
  try {
    await assert.rejects(f.service.generateText({ profile: f.profile.id, messages, timeoutMs: 700 }), { code: 'AGENT_TIMEOUT' });
    for (let index=0; index<100 && f.service.status().active; index++) await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(f.service.status().active,0);
    const capture=JSON.parse(await readFile(f.capture,'utf8'));
    assert.throws(()=>process.kill(capture.pid,0));
    await assert.rejects(stat(capture.cwd),{code:'ENOENT'});
  } finally { await f.close(); }
});
