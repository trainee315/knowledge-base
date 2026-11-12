import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { transcriptCommand } from '../../dist/records/transcript.js';
import { openApplication } from '../../dist/index.js';

// 单独的005账本，最多三次；不访问或修改002账本。材料完全合成。
if (!process.argv.includes('--live')) throw new Error('Requires explicit --live');
const ledgerPath = join(homedir(), 'AppData/Local/knowledge-base/verification/v0.0.5-live-ledger.json');
const mutex = createServer(socket => socket.destroy());
await new Promise((resolve, reject) => { mutex.once('error', reject); mutex.listen(process.platform === 'win32' ? '\\\\.\\pipe\\knowledge-base-v005-live' : '\0knowledge-base-v005-live', resolve); });
mutex.unref();
await mkdir(join(homedir(), 'AppData/Local/knowledge-base/verification'), { recursive: true });
let ledger;
try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { requests: 0, syntheticOnly: true, attempts: [] }; }
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (ledger.requests >= 3) throw new Error('LIVE_BUDGET_EXHAUSTED');
  ledger.requests++; ledger.attempts.push({ at: new Date().toISOString() }); await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
  return nativeFetch(url, options);
};
const root = await mkdtemp(join(tmpdir(), 'kb-v005-live-')); const sourceRoot = join(root, 'sessions'); const data = join(root, 'data'); await mkdir(sourceRoot);
const cases = [
  ['请计划将重试上限设为12，先不要实施。', '提出方案：上限12，尚未获得实施批准；没有修改代码，也没有执行验证。'],
  ['纠正：同意上限改为8，原先12方案作废。', '已修改为8并执行 npm test；错误 E_SYNTHETIC，测试失败。当前仍未验证通过，修复未完成。'],
  ['事务A：保留8，待修复测试。事务B：讨论缓存TTL=90秒，目前只是提议。', '事务A仍未解决；事务B建议试验，未实施，也没有验证。推测TTL可能减少请求，但无测量证据。'],
];
const file = join(sourceRoot, 'synthetic.jsonl'); let raw = '';
const row = (type, payload) => JSON.stringify({ timestamp: '2026-01-01T01:00:00Z', type, payload }) + '\n';
raw += row('session_meta', { id: 'synthetic-live-v005', cwd: root, source: 'cli' });
const org = await transcriptCommand(data, 'create', { alias: 'quality', sourceRoot, projectDir: root, startDate: '2026-01-01', maxCalls: 1 });
const outputs = [];
for (const [user, assistant] of cases) {
  raw += row('event_msg', { type: 'task_started' }) + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }) + row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] }) + row('event_msg', { type: 'task_complete' });
  await writeFile(file, raw);
  try {
    const run = await transcriptCommand(data, 'run', { id: org.id });
    const entries = await transcriptCommand(data, 'records', { id: org.id });
    const app = await openApplication(data, { readOnly: true });
    try { const resource = await app.manager.getResource(entries.at(-1).resourceId); outputs.push({ run, metadata: resource.plugins.transcripts.data, body: (await app.manager.readContent(resource.id)).toString('utf8') }); } finally { await app.close(); }
  } catch (error) { outputs.push({ error: String(error) }); break; }
}
const report = { ok: outputs.length === cases.length && outputs.every(output => !output.error), syntheticOnly: true, root, requestsUsedTotal: ledger.requests, outputs };
await mkdir('artifacts/verification/v0.0.5', { recursive: true });
await writeFile('artifacts/verification/v0.0.5/live-synthetic.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await new Promise(resolve => mutex.close(resolve));
if (!report.ok) process.exitCode = 1;
