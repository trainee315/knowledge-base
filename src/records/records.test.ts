import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteCommand } from './note.js';
import { transcriptCommand, plan } from './transcript.js';
import { readSession } from './source.js';
import { configuration, directoryMatches, startTime } from './config.js';
import { openApplication } from '../index.js';
import { CoreManager } from '../core/manager.js';
import type { AgentApi, AgentResult } from '../agent/types.js';
import type { Organization } from '../contracts/index.js';
import { spawnSync } from 'node:child_process';
import { browse } from '../preview/browse.js';

const AT = '2026-01-01T01:00:00Z';
function rows(id = 's1', complete = true, cwd = 'D:/project/example') {
  const row = (type: string, payload: object) => JSON.stringify({ timestamp: AT, type, payload });
  return [row('session_meta', { id, cwd, source: 'cli' }), row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '要求将限制设为 12，先提出计划，不表示实施。' }] }), row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '纠正：实际设为 8，已执行命令，但测试失败，仍未验证通过。' }] }), ...(complete ? [row('event_msg', { type: 'task_complete' })] : [])].join('\n') + '\n';
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-records-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const sourceRoot = path.join(root, 'source'); await fs.mkdir(sourceRoot); return { root, sourceRoot, data: path.join(root, 'data') }; }
function fake(counter: { calls: number }, fail = false): Pick<AgentApi, 'generateObject'> { return { async generateObject<T>(input: import('../agent/types.js').GenerateObjectInput): Promise<AgentResult<T>> { counter.calls++; if (fail) throw new Error('SYNTHETIC_FAILURE'); const messages = JSON.parse(input.messages.at(-1)!.content).messages; return { value: { title: '合成转录', sections: [{ heading: '纠正与验证', body: '要求先提出12，实际改为8；测试失败，尚未通过。', evidence: messages.map((item: { position: number }) => item.position) }] } as T, profileId: 'test', profileRevision: 1, provider: { id: 'fake', version: '1' }, model: 'fake', configurationHash: 'test', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }; } }; }
const noStdin = async () => Buffer.alloc(0);

test('note preserves BOM/CRLF, independent identical submissions, request conflicts and deletion replay', async t => {
  const { root, data } = await fixture(t); const file = path.join(root, 'note.md'); const bytes = Buffer.from('\uFEFF# 标题\r\n\r\n 保留空白 \r\n'); await fs.writeFile(file, bytes);
  const first = await noteCommand(data, 'add', { file, requestId: 'one' }, noStdin) as { resourceId: string };
  const result = await noteCommand(data, 'get', { id: first.resourceId }, noStdin) as { content: string }; assert.deepEqual(Buffer.from(result.content), bytes);
  assert.equal((await noteCommand(data, 'add', { file, requestId: 'one' }, noStdin) as { replayed: boolean }).replayed, true);
  await assert.rejects(noteCommand(data, 'add', { text: 'different', requestId: 'one' }, noStdin), /冲突/);
  const second = await noteCommand(data, 'add', { file }, noStdin) as { resourceId: string }; assert.notEqual(second.resourceId, first.resourceId);
  const app = await openApplication(data); await app.manager.deleteResource(first.resourceId); await app.close();
  assert.equal((await noteCommand(data, 'add', { file, requestId: 'one' }, noStdin) as { replayed: boolean }).replayed, true);
  await assert.rejects(noteCommand(data, 'add', { stdin: true }, async () => Buffer.from([255])), /UTF-8/);
});

test('config validates alias, timezone, budgets and directory segment boundaries', () => {
  const c = configuration({ alias: 'demo', startDate: '2026-01-01', projectDir: 'D:/project/example' });
  assert.equal(directoryMatches(c, ['D:/project/example-two']), false);
  assert.equal(directoryMatches(c, ['D:/project/example/sub']), false);
  assert.equal(directoryMatches({ ...c, includeSubdirectories: true }, ['D:/project/example/sub']), true);
  assert.equal(startTime('2026-01-01', 'Asia/Shanghai'), Date.parse('2025-12-31T16:00:00Z'));
  assert.throws(() => configuration({ alias: 'x', startDate: '2026-02-30' }));
  assert.throws(() => configuration({ alias: 'x', startDate: AT, enabled: true }));
});

test('source retains equal timestamps and skips active turns, detects unknown message formats', async t => {
  const { sourceRoot } = await fixture(t); const file = path.join(sourceRoot, 'a.jsonl'); await fs.writeFile(file, rows());
  const session = await readSession(file, Date.now()); assert.equal(session.turns[0].messages.length, 2); assert.notEqual(session.turns[0].messages[0].fingerprint, session.turns[0].messages[1].fingerprint);
  await fs.writeFile(file, rows('s1', false)); assert.equal((await readSession(file, Date.now())).turns[0].complete, false);
  await fs.writeFile(file, rows().replace('input_text', 'unknown_media')); await assert.rejects(readSession(file, Date.now()), /格式/);
  const legacy = rows().split('\n').filter(line => !line.includes('task_started') && !line.includes('task_complete')).join('\n');
  await fs.writeFile(file, legacy); assert.equal((await readSession(file, Date.now())).turns[0].complete, false);
  const old = new Date(Date.now() - 700_000); await fs.utimes(file, old, old); assert.equal((await readSession(file, Date.now())).turns[0].complete, true);
  await fs.writeFile(file, rows().replace('"source":"cli"', '"source":{"subagent":"worker"}')); assert.equal((await readSession(file, Date.now())).child, true);
});

test('preview is read only, failure retry, old session append, rename and processor-independent coverage', async t => {
  const { data, sourceRoot } = await fixture(t); const file = path.join(sourceRoot, 's.jsonl'); await fs.writeFile(file, rows());
  const org = await transcriptCommand(data, 'create', { alias: 'demo', startDate: '2025-01-01', sourceRoot, maxCalls: 5 }) as Organization;
  const counter = { calls: 0 }; const agent = fake(counter);
  const before = await fs.readFile(path.join(data, 'organizations', org.id + '.json'));
  const preview = await transcriptCommand(data, 'preview', { alias: 'demo' }, agent) as { candidates: unknown[] }; assert.equal(preview.candidates.length, 1); assert.equal(counter.calls, 0);
  assert.deepEqual(await fs.readFile(path.join(data, 'organizations', org.id + '.json')), before);
  await assert.rejects(transcriptCommand(data, 'run', { alias: 'demo' }, fake(counter, true)), /TRANSCRIPT|SYNTHETIC/);
  await transcriptCommand(data, 'retry', { id: org.id }, agent);
  assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 1);
  await transcriptCommand(data, 'run', { id: org.id }, agent); assert.equal(counter.calls, 2);
  const tail = rows().split('\n').slice(1).join('\n'); await fs.appendFile(file, tail);
  await transcriptCommand(data, 'run', { id: org.id }, agent);
  const entries = await transcriptCommand(data, 'records', { id: org.id }) as { resourceId: string; previousResourceId?: string }[];
  assert.equal(entries.length, 2); assert.equal(entries[1].previousResourceId, entries[0].resourceId);
  await transcriptCommand(data, 'configure', { id: org.id, alias: 'renamed', profile: 'different-profile' });
  assert.equal((await transcriptCommand(data, 'get', { alias: 'renamed' }) as Organization).id, org.id);
  await transcriptCommand(data, 'backfill', { id: org.id, from: '2025-01-01' }, agent); assert.equal(counter.calls, 3);
  await assert.rejects(transcriptCommand(data, 'create', { alias: ' RENAMED ', startDate: AT, sourceRoot }), /别名/);
  const app = await openApplication(data, { readOnly: true }); assert.equal((await app.manager.check()).valid, true); await app.close();
});

test('model does not hold writer lock; output references validated and no resource on failure', async t => {
  const { data, sourceRoot } = await fixture(t); await fs.writeFile(path.join(sourceRoot, 's.jsonl'), rows());
  const org = await transcriptCommand(data, 'create', { alias: 'lock', startDate: '2025-01-01', sourceRoot, maxCalls: 1 }) as Organization;
  const generator: Pick<AgentApi, 'generateObject'> = { async generateObject<T>(input: import('../agent/types.js').GenerateObjectInput) {
    const writer = await openApplication(data); await writer.manager.pluginStore('records').write('during-model', true); await writer.close();
    await assert.rejects(transcriptCommand(data, 'run', { id: org.id }, fake({ calls: 0 })), /执行者/);
    const response = await fake({ calls: 0 }).generateObject<any>(input); response.value.sections[0].evidence = [999999]; return response as AgentResult<T>;
  } };
  await assert.rejects(transcriptCommand(data, 'run', { id: org.id }, generator), /校验/);
  assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 0);
});

test('atomic append redo recovery keeps organization and resource consistent', async t => {
  const { data } = await fixture(t);
  const org = await transcriptCommand(data, 'create', { alias: 'crash', startDate: AT }) as Organization;
  const id = '11111111-1111-4111-8111-111111111111';
  const manager = await CoreManager.open(data, { failAfterWrites: 1 });
  await assert.rejects(manager.appendRecord({ id, title: 'crash', content: Buffer.from('body'), plugins: {}, organization: org })); await manager.close();
  const recovered = await CoreManager.open(data); assert.equal((await recovered.getResource(id)).id, id); assert.equal((await recovered.getOrganization(org.id)).references[0].id, id); assert.equal((await recovered.check()).valid, true); await recovered.close();
});

test('filters, budgets and backfill retain excluded historical material', async t => {
  const { data, sourceRoot } = await fixture(t); await fs.writeFile(path.join(sourceRoot, 's.jsonl'), rows());
  const org = await transcriptCommand(data, 'create', { alias: 'filter', startDate: '2025-01-01', sourceRoot, include: { sessionIds: ['s1'] }, exclude: { bodyKeywords: ['纠正'] } }) as Organization;
  assert.equal((await plan(org, {})).skips[0].reason, 'excluded');
  await transcriptCommand(data, 'configure', { id: org.id, exclude: {}, maxCalls: 1 });
  assert.equal((await transcriptCommand(data, 'preview', { id: org.id }) as { candidates: unknown[] }).candidates.length, 0);
  const counter = { calls: 0 }; await transcriptCommand(data, 'backfill', { id: org.id, from: '2025-01-01' }, fake(counter)); assert.equal(counter.calls, 1);
});

test('CLI stdin is byte faithful, JSON stdout and invalid arguments exit 2', async t => {
  const { data } = await fixture(t);
  const cli = (args: string[], input?: Buffer) => spawnSync(process.execPath, ['dist/cli/main.js', ...args, '--data-dir', data, '--json'], { input });
  const bytes = Buffer.from('\uFEFF# CLI\r\n body  \r\n');
  const added = cli(['note', 'add', '--stdin'], bytes); assert.equal(added.status, 0, added.stderr.toString()); const result = JSON.parse(added.stdout.toString()); assert.equal(result.ok, true);
  const got = cli(['note', 'get', '--id', result.data.resourceId]); assert.equal(got.status, 0); assert.deepEqual(Buffer.from(JSON.parse(got.stdout.toString()).data.content), bytes);
  assert.equal(cli(['note', 'add', '--text', 'x', '--file', 'missing']).status, 2);
});

test('multiple batches use whole turns, fixed snapshot excludes new messages during model', async t => {
  const { data, sourceRoot } = await fixture(t); const file = path.join(sourceRoot, 's.jsonl');
  const large = rows().replace('要求将限制设为 12，先提出计划，不表示实施。', '要求：' + '测试内容。'.repeat(230));
  await fs.writeFile(file, large + large.split('\n').slice(1).join('\n'));
  const org = await transcriptCommand(data, 'create', { alias: 'segments', sourceRoot, startDate: '2025-01-01', maxChunkBytes: 7000, maxCalls: 1 }) as Organization;
  const counter = { calls: 0 };
  const first = await transcriptCommand(data, 'run', { id: org.id }, fake(counter)) as { saved: number; remaining: number };
  assert.equal(first.saved, 1); assert.equal(first.remaining, 1);
  await transcriptCommand(data, 'retry', { id: org.id }, fake(counter));
  assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 2);
  await fs.appendFile(file, rows().split('\n').slice(1).join('\n'));
  const generator: Pick<AgentApi, 'generateObject'> = { async generateObject<T>(input: import('../agent/types.js').GenerateObjectInput) { await fs.appendFile(file, rows().split('\n').slice(1).join('\n')); return fake(counter).generateObject<T>(input); } };
  await transcriptCommand(data, 'run', { id: org.id }, generator);
  assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 3);
  await transcriptCommand(data, 'run', { id: org.id }, fake(counter));
  assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 4);
  await fs.writeFile(file, rows());
  await assert.rejects(transcriptCommand(data, 'run', { id: org.id }, fake(counter)), /改写或截断/);
});

test('zero call budget, tick due dedup and oversized turns never fake successful output', async t => {
  const { data, sourceRoot } = await fixture(t); const file = path.join(sourceRoot, 's.jsonl'); await fs.writeFile(file, rows());
  const org = await transcriptCommand(data, 'create', { alias: 'tick', projectDir: 'D:/project/example', sourceRoot, startDate: '2025-01-01', enabled: true, intervalMinutes: 60 }) as Organization;
  const counter = { calls: 0 };
  await transcriptCommand(data, 'tick', {}, fake(counter)); assert.equal(counter.calls, 0);
  assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 0);
  assert.equal((await transcriptCommand(data, 'tick', {}, fake(counter)) as { results: unknown[] }).results.length, 0);
  await transcriptCommand(data, 'retry', { id: org.id, maxCalls: 1 }, fake(counter)); assert.equal(counter.calls, 1);
  await fs.appendFile(file, rows().split('\n').slice(1).join('\n').replace('要求将限制设为 12，先提出计划，不表示实施。', 'x'.repeat(50_000)));
  const preview = await transcriptCommand(data, 'preview', { id: org.id }) as { skips: { reason: string }[] }; assert.ok(preview.skips.some(skip => skip.reason === 'oversized-turn'));
});

test('saved model result resumes without another call and survives backup restore', async t => {
  const { root, data, sourceRoot } = await fixture(t); await fs.writeFile(path.join(sourceRoot, 's.jsonl'), rows());
  const org = await transcriptCommand(data, 'create', { alias: 'resume', sourceRoot, startDate: '2025-01-01', maxCalls: 0 }) as Organization;
  await transcriptCommand(data, 'run', { id: org.id }, fake({ calls: 0 }));
  const app = await openApplication(data); const current = await app.manager.getOrganization(org.id); const s = current.data as any;
  const result = await fake({ calls: 0 }).generateObject<any>({ messages: [{ role: 'user', content: JSON.stringify({ messages: s.tasks[0].messages }) }], schema: { type: 'object' } });
  s.tasks[0].result = result; s.tasks[0].status = 'failed'; s.lease = { token: 'dead', expires: 0 };
  await app.manager.updateOrganization(org.id, { data: s }, current.revision);
  const backup = path.join(root, 'test.backup.json'); await app.manager.backup(backup); await app.close();
  const restored = path.join(root, 'restored'); const manager = await CoreManager.open(restored); await manager.restore(backup); await manager.close();
  const counter = { calls: 0 }; await transcriptCommand(restored, 'retry', { id: org.id }, fake(counter)); assert.equal(counter.calls, 0);
  assert.equal((await transcriptCommand(restored, 'records', { id: org.id }) as unknown[]).length, 1);
});

test('explicit note tags and transcript generic organization browsing reuse existing semantics', async t => {
  const { data, sourceRoot } = await fixture(t);
  const app = await openApplication(data); const tag = await app.plugins.execute('tag create', { name: '兼容标签' }) as Organization; await app.close();
  const note = await noteCommand(data, 'add', { text: '# 内容\n关键词内容', tags: [tag.id] }, noStdin) as { resourceId: string };
  await fs.writeFile(path.join(sourceRoot, 's.jsonl'), rows());
  await fs.writeFile(path.join(sourceRoot, 'session_index.jsonl'), JSON.stringify({ id: 's1', thread_name: '精确展示标题', updated_at: AT }) + '\n');
  const org = await transcriptCommand(data, 'create', { alias: 'browse', sourceRoot, startDate: '2025-01-01', maxCalls: 1, include: { titleKeywords: ['展示标题'] } }) as Organization;
  await transcriptCommand(data, 'run', { id: org.id }, fake({ calls: 0 }));
  const reader = await openApplication(data, { readOnly: true });
  try {
    const tagged = await browse(reader, new URL(`http://localhost/api/browse/documents?type=tag&id=${tag.id}`)) as any; assert.equal(tagged.total, 1); assert.equal(tagged.items[0].resource.id, note.resourceId);
    const documents = await browse(reader, new URL(`http://localhost/api/browse/documents?type=session-transcript&id=${org.id}`)) as any; assert.equal(documents.total, 1);
  } finally { await reader.close(); }
});

test('malformed source fails explicitly but does not prevent independent session progress', async t => {
  const { data, sourceRoot } = await fixture(t); await fs.writeFile(path.join(sourceRoot, 'bad.jsonl'), '{}\n'); await fs.writeFile(path.join(sourceRoot, 'good.jsonl'), rows());
  const org = await transcriptCommand(data, 'create', { alias: 'sources', sourceRoot, startDate: '2025-01-01', maxCalls: 2 }) as Organization;
  const counter = { calls: 0 };
  await assert.rejects(transcriptCommand(data, 'run', { id: org.id }, fake(counter)), /source-error/);
  assert.equal(counter.calls, 1); assert.equal((await transcriptCommand(data, 'records', { id: org.id }) as unknown[]).length, 1);
  await fs.writeFile(path.join(sourceRoot, 'bad.jsonl'), rows('s2'));
  await transcriptCommand(data, 'run', { id: org.id }, fake(counter)); assert.equal(counter.calls, 2);
});
