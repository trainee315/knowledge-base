import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSession, joinSessions } from './source.js';
import { plan } from './transcript.js';
import { configuration } from './config.js';
import type { Organization } from '../contracts/index.js';

test('checkpoint fragments retain global positions and reconstruct a completed turn', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kb-checkpoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const row = (ordinal: number, type: string, payload: object) => JSON.stringify({ ordinal, timestamp: '2026-01-01T00:00:00Z', type, payload }) + '\n';
  const meta = { id: 'synthetic', cwd: root, source: 'vscode' };
  const message = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const first = join(root, 'first.jsonl');
  const second = join(root, 'second.jsonl');
  await fs.writeFile(first, row(0, 'session_meta', meta) + row(1, 'event_msg', { type: 'task_started', turn_id: 'turn' }) + row(2, 'response_item', message('继承前文')) + row(3, 'response_item', message('旧检查点之后的尾部')));
  await fs.writeFile(second, row(3, 'session_meta', { ...meta, history_base: { thread_id: 'synthetic', end_ordinal_exclusive: 3 } }) + row(4, 'response_item', message('续存新增内容')) + row(5, 'event_msg', { type: 'task_complete', turn_id: 'turn' }));
  const merged = joinSessions([await readSession(second, Date.now()), await readSession(first, Date.now())])[0];
  assert.equal(merged.turns.length, 1);
  assert.equal(merged.turns[0].complete, true);
  assert.deepEqual(merged.turns[0].messages.map(message => message.position), [2, 4]);
  assert.doesNotMatch(merged.turns[0].messages.map(message => message.content).join('\n'), /旧检查点/);
  const head = await readSession(first, Date.now());
  assert.throws(() => joinSessions([head, structuredClone(head)]), /续存依据/);
});

test('child metadata with embedded parent session is excluded before inherited material parsing', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kb-child-meta-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, 'child.jsonl');
  const row = (payload: object) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload }) + '\n';
  await fs.writeFile(file, row({ id: 'child', cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }) + row({ id: 'parent', cwd: root, source: 'vscode' }));
  const session = await readSession(file, Date.now());
  assert.equal(session.id, 'child');
  assert.equal(session.child, true);
  assert.equal(session.turns.length, 0);
});

test('historical cutoff excludes a turn completed after that cutoff', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kb-cutoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const row = (hour: string, type: string, payload: object) => JSON.stringify({ timestamp: `2026-01-01T${hour}:00:00Z`, type, payload }) + '\n';
  await fs.writeFile(join(root, 'session.jsonl'), row('00', 'session_meta', { id: 'synthetic-cutoff', cwd: root, source: 'cli' }) + row('00', 'event_msg', { type: 'task_started' }) + row('01', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '未完成任务' }] }) + row('03', 'event_msg', { type: 'task_complete' }));
  await fs.writeFile(join(root, 'later.jsonl'), row('05', 'session_meta', { id: 'synthetic-later', cwd: root, source: 'cli' }));
  const config = configuration({ alias: 'cutoff', sourceRoot: root, startDate: '2025-01-01' });
  const organization = { type: 'session-transcript', data: { schemaVersion: 1, config, entries: [], tasks: [], skips: [] } } as unknown as Organization;
  const preview = await plan(organization, { backfill: true, from: '2025-01-01', to: '2026-01-01T02:00:00Z' }, Date.parse('2026-01-01T04:00:00Z'));
  assert.equal(preview.candidates.length, 0);
  assert.ok(preview.skips.some(skip => skip.reason === 'active-turn'));
  assert.ok(preview.skips.every(skip => !skip.reason.startsWith('source-error:')));
});
