import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const PRELOAD = new URL('./offline-model.mjs', import.meta.url).href;
const AT = '2026-01-01T00:00:00Z';

export async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-chain-'));
  const data = path.join(root, 'data'), source = path.join(root, 'source');
  await mkdir(source);
  const env = { ...process.env, NODE_OPTIONS: '--import=' + PRELOAD, DEEPSEEK_API_KEY: 'synthetic-fixture-only', KB_CHAIN_CALLS: path.join(root, 'calls.jsonl') };
  const issue = (words, input = {}, options = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...words, '--data-dir', data, '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8', env, windowsHide: true, timeout: 30000, ...options });
    if (result.error) throw result.error;
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stderr);
    return { exit: result.status, ...JSON.parse(result.stdout) };
  };
  const run = (words, input = {}) => { const reply = issue(words, input); assert.equal(reply.exit, 0, JSON.stringify(reply)); return reply.data; };
  t.after(async () => {
    issue(['service', 'stop']);
    const target = await realpath(root), base = await realpath(tmpdir()), relative = path.relative(base, target);
    assert.ok(relative.startsWith('kb-chain-') && !path.isAbsolute(relative) && !relative.startsWith('..'));
    await rm(target, { recursive: true, force: true });
  });
  const row = (type, payload) => JSON.stringify({ timestamp: AT, type, payload });
  for (const id of ['a', 'b']) await writeFile(path.join(source, id + '.jsonl'), [row('session_meta', { id, cwd: root, source: 'cli' }), row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '限制为8，测试失败，尚未验证通过。' }] }), row('event_msg', { type: 'task_complete' })].join('\n') + '\n');
  run(['service', 'start']);
  const org = run(['transcript', 'create'], { alias: 'probe', sourceRoot: source, projectDir: root, startDate: '2026-01-01', maxCalls: 2 });
  const scope = { projectId: 'probe' };
  const config = { expectedRevision: 0, projects: [{ id: 'probe', directories: [root] }], organizations: { [org.id]: { projectId: 'probe' } } };
  run(['recall', 'configure'], config);
  return { root, data, source, org, scope, issue, run };
}

test('CLI resolves aliases once for run, retry and backfill', async t => {
  const f = await fixture(t);
  for (const action of ['run', 'retry', 'backfill']) f.run(['transcript', action], { alias: 'probe', maxCalls: 0, ...(action === 'backfill' ? { from: '2026-01-01' } : {}) });
});

test('CLI preview applies execution budgets and rejects unknown options', async t => {
  const f = await fixture(t);
  assert.equal(f.run(['transcript', 'preview'], { id: f.org.id, maxSessions: 1 }).candidates.length, 1);
  assert.equal(f.issue(['transcript', 'preview'], { id: f.org.id, sessionTypo: 'a' }).exit, 2);
});

test('CLI continuation reads every fragment once', async t => {
  const f = await fixture(t);
  f.run(['transcript', 'run'], { id: f.org.id, maxSessions: 1 });
  const id = f.run(['transcript', 'records'], { id: f.org.id })[0].resourceId;
  const ordinals = []; let request = { id, scope: f.scope, maxFragments: 1 };
  for (let page = 0; page < 10; page++) {
    const result = f.run(['recall', 'read'], request);
    ordinals.push(...result.evidence.map(e => e.ordinal));
    if (!result.continue) break;
    request = { ...result.continue, maxFragments: 1 };
  }
  assert.deepEqual(ordinals, [0, 1, 2, 3, 4, 5]);
});

test('CLI indexes mixed-language identifiers and Chinese boundaries', async t => {
  const f = await fixture(t);
  f.run(['transcript', 'run'], { id: f.org.id, maxSessions: 1 });
  f.run(['recall', 'index', 'build']);
  for (const query of ['CHAIN_PROBE_8192', '限制']) {
    const result = f.run(['recall', 'search'], { scope: f.scope, query, retrievalMode: 'lexical' });
    assert.ok(result.evidence.length, query);
    assert.equal(result.usage.modelCalls, 0);
  }
  const unrelated = f.run(['recall', 'search'], { scope: f.scope, query: 'CHAIN_PROBE_9999', retrievalMode: 'lexical' });
  assert.equal(unrelated.evidence.length, 0);
});

test('single-session budgets, frozen retry and status stay isolated', async t => {
  const f = await fixture(t);
  const request = { alias: 'probe', sessionId: 'a', maxCalls: 0, maxSessions: 1 };
  const preview = f.run(['transcript', 'preview'], request);
  assert.deepEqual(preview.candidates.map(c => c.sessionId), ['a']);
  const pending = f.run(['transcript', 'run'], { ...request, to: preview.cutoff });
  assert.equal(pending.stopReason, 'call-budget'); assert.equal(pending.complete, false);
  assert.equal(f.issue(['transcript', 'retry'], { alias: 'probe', preprocessing: 'off' }).exit, 2);
  const status = f.run(['transcript', 'status'], { alias: 'probe' });
  assert.equal(status.status.pending, 1); assert.equal(status.tasks, undefined);
  assert.ok(!JSON.stringify(status).includes('尚未验证通过'));
  const done = f.run(['transcript', 'retry'], { alias: 'probe', sessionId: 'a', maxCalls: 1 });
  assert.equal(done.saved, 1); assert.equal(done.complete, true); assert.equal(done.records[0].sessionId, 'a');
  const replay = f.run(['transcript', 'run'], { id: f.org.id, sessionId: 'a' }); assert.equal(replay.calls, 0); assert.equal(replay.saved, 0);
  const missing = f.run(['transcript', 'run'], { id: f.org.id, sessionId: 'unknown' });
  assert.equal(missing.calls, 0); assert.equal(missing.complete, false); assert.equal(missing.stopReason, 'session-not-found');
  assert.deepEqual(f.run(['transcript', 'preview'], { id: f.org.id, sessionId: 'b' }).candidates.map(c => c.sessionId), ['b']);
});

test('partial errors retain structured results and retry frozen input once', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'calls.jsonl.fail-next'), '1');
  const failed = f.issue(['transcript', 'run'], { alias: 'probe' });
  assert.equal(failed.exit, 1); assert.equal(failed.error.code, 'TRANSCRIPT_FAILED');
  assert.equal(failed.error.details.saved, 1); assert.equal(failed.error.details.records.length, 1);
  assert.ok(failed.error.details.failures[0].taskId); assert.equal(failed.error.details.remaining, 1);
  const recovered = f.run(['transcript', 'retry'], { alias: 'probe', maxCalls: 1 }); assert.equal(recovered.saved, 1);
  const attempts = (await readFile(path.join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(attempts[0].requestHash, attempts[2].requestHash);
  assert.equal(f.run(['transcript', 'records'], { id: f.org.id }).length, 2);
});

test('help is offline and effect-free, CLI options cannot silently widen scope', async t => {
  const f = await fixture(t); f.run(['service', 'stop']);
  for (const args of [['--data-dir'], ['--help=wrong'], ['--json=wrong']]) {
    const p = spawnSync(process.execPath, [CLI, 'transcript', 'run', '--id', f.org.id, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).error.code, 'INVALID_ARGUMENT');
  }
  for (const words of [['recall', 'workload'], ['recall', 'model', 'prepare'], ['transcript', 'run']]) {
    const result = f.issue([...words, '--help', '--input', 'missing.json']);
    assert.equal(result.exit, 0); assert.equal(result.data.command, words.join(' '));
  }
  f.run(['service', 'start']);
  for (const [words, input] of [
    [['transcript', 'run', 'extra'], { id: f.org.id }], [['transcript', 'run', '--max-calls'], { id: f.org.id }],
    [['transcript', 'run'], { id: f.org.id, maxCalls: true }], [['recall', 'index', 'build'], { vector: true }],
    [['recall', 'read'], { id: 'x', scope: f.scope, maxFragments: false }],
  ]) assert.equal(f.issue(words, input).exit, 2);
  const preview = f.run(['transcript', 'preview', '--max-sessions', '1'], { id: f.org.id, maxSessions: 2 }); assert.equal(preview.candidates.length, 1);
  const config = f.run(['recall', 'config', 'get']); assert.equal(config.revision, 1); assert.ok(config.organizations[f.org.id]);
});

test('list continuation preserves filters and rejects changed snapshots', async t => {
  const f = await fixture(t); f.run(['transcript', 'run'], { id: f.org.id });
  const first = f.run(['recall', 'list'], { scope: f.scope, limit: 1, direction: 'asc' });
  assert.equal(first.continueCommand, 'recall list'); assert.equal(first.continue.offset, 1);
  const second = f.run(['recall', 'list'], first.continue); assert.notEqual(first.items[0].resourceId, second.items[0].resourceId); assert.equal(second.continue, undefined);
  f.run(['resource', 'delete'], { id: second.items[0].resourceId });
  assert.equal(f.issue(['recall', 'list'], first.continue).error.code, 'CONTINUATION_STALE');
});

test('section continuations preserve original hashes and splitting identity', async t => {
  const f = await fixture(t); f.run(['transcript', 'run'], { id: f.org.id, sessionId: 'a' });
  const id = f.run(['transcript', 'records'], { id: f.org.id })[0].resourceId;
  const section = f.run(['recall', 'read'], { id, scope: f.scope, section: '事务3' }); assert.deepEqual(section.evidence.map(e => e.ordinal), [3]);
  const first = f.run(['recall', 'read'], { id, scope: f.scope, maxFragments: 1 });
  assert.equal(f.issue(['recall', 'read'], { ...first.continue, contentHash: 'changed' }).error.code, 'CONTINUATION_STALE');
  const config = f.run(['recall', 'config', 'get']);
  f.run(['recall', 'configure'], { ...config, expectedRevision: config.revision, chunking: { targetChars: 128, maxBlockChars: 256 } });
  assert.equal(f.issue(['recall', 'read'], first.continue).error.code, 'CONTINUATION_STALE');
});

test('completed work followed by an active turn cannot report full completion', async t => {
  const f = await fixture(t), file = path.join(f.source, 'a.jsonl');
  const row = (type, payload) => JSON.stringify({ timestamp: '2026-01-02T00:00:00Z', type, payload });
  await writeFile(file, await readFile(file, 'utf8') + [row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '尚在进行，不能压缩本轮。' }] })].join('\n') + '\n');
  const preview = f.run(['transcript', 'preview'], { id: f.org.id, sessionId: 'a' });
  assert.equal(preview.candidates[0].messageCount, 1); assert.ok(preview.skips.some(s => s.reason === 'active-turn'));
  const result = f.run(['transcript', 'run'], { id: f.org.id, sessionId: 'a', to: preview.cutoff });
  assert.equal(result.saved, 1); assert.equal(result.remaining, 0); assert.equal(result.complete, false); assert.equal(result.stopReason, 'active-turn');
});
