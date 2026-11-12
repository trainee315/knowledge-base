import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture as recallFixture } from '../recall/fixture.mjs';
import { evaluate } from '../../dist/recall/evaluate.js';

if (!process.argv.includes('--live')) throw new Error('Requires --live: synthetic data only, at most 24 cloud calls / 2048 output tokens each');
if (!process.env.DEEPSEEK_API_KEY) throw new Error('AGENT_CREDENTIAL_MISSING');
const base = path.resolve('.recall-local/v0.0.10'); await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'campaign-')), data = path.join(root, 'data'), source = path.join(root, 'source'); await mkdir(source);
const ledger = path.join(root, 'ledger.json'); await writeFile(ledger, JSON.stringify({ syntheticOnly: true, maximumCalls: 24, attempts: [] }));
process.env.KB_CHAIN_LIVE_LEDGER = ledger;
await import('./live-ledger.mjs');
const env = { ...process.env, NODE_OPTIONS: '--import=' + new URL('./live-ledger.mjs', import.meta.url).href };
const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const reportFile = path.resolve('artifacts/verification/v0.0.10/live.json');
const report = { syntheticOnly: true, checks: [], root, failures: [] };
const save = async () => writeFile(reportFile, JSON.stringify(report, null, 2));
const issue = (words, input = {}) => {
  const p = spawnSync(process.execPath, [CLI, ...words, '--data-dir', data, '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8', env, windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (p.error) throw p.error; const reply = JSON.parse(p.stdout); if (p.status !== 0 || !reply.ok) throw new Error(JSON.stringify({ words, reply })); return reply.data;
};
let started = false;
try {
  const fixture = await recallFixture(data);
  // 复用上一版合成验收的公开模型缓存，正式库与旧验收数据均不写入。
  const previous = JSON.parse(await readFile('artifacts/verification/v0.0.8/baseline.json', 'utf8'));
  await cp(path.join(previous.dataDir, 'cache/recall-models'), path.join(data, 'cache/recall-models'), { recursive: true, errorOnExist: true, force: false });
  issue(['service', 'start']); started = true;
  const model = issue(['recall', 'model', 'status']); assert.equal(model.ready, true); report.model = model;
  issue(['agent', 'profile', 'set'], { id: 'chain-live', providerId: 'deepseek', model: 'deepseek-flash', credentialEnv: 'DEEPSEEK_API_KEY', maxTokens: 2048, temperature: 0, reasoning: 'off', timeoutMs: 120000 });
  const at = '2026-01-01T00:00:00Z';
  const row = (type, payload) => JSON.stringify({ timestamp: at, type, payload });
  const turn = (user, assistant) => [row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }), row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] }), row('event_msg', { type: 'task_complete' })].join('\n') + '\n';
  const file = path.join(source, 's1.jsonl');
  const first = row('session_meta', { id: 'chain-live-session', cwd: root, source: 'cli' }) + '\n' + turn('连击仅普通攻击命中后累计，窗口300毫秒，闪避和受击必须清空计数。禁止改成500毫秒。事务B：缓存全部战斗帧的方案因内存超限否决，只保留最近60帧。', '已实施300毫秒窗口和60帧上限；执行测试出现 E_COMBO_8192，测试失败，尚未验证通过。推测失败与计时边界有关，未证实。');
  await writeFile(file, first);
  const org = issue(['transcript', 'create'], { alias: 'chain-live', projectDir: root, sourceRoot: source, startDate: '2026-01-01', profile: 'chain-live', maxCalls: 1 });
  const config = issue(['recall', 'config', 'get']);
  issue(['recall', 'configure'], { ...config, expectedRevision: config.revision, projects: [...config.projects, { id: 'chain-project', directories: [root] }], organizations: { ...config.organizations, [org.id]: { projectId: 'chain-project' } } });
  const scope = { projectId: 'chain-project', sessionId: 'chain-live-session' };
  const preview = issue(['transcript', 'preview'], { alias: 'chain-live', sessionId: scope.sessionId, maxCalls: 1 });
  const run = issue(['transcript', 'run'], { alias: 'chain-live', sessionId: scope.sessionId, to: preview.cutoff, maxCalls: 1 }); assert.equal(run.saved, 1); assert.equal(run.complete, true);
  const resourceId = run.records[0].resourceId;
  const read = issue(['recall', 'read'], { id: resourceId, scope }); const body = read.evidence.map(e => e.text).join('');
  for (const text of ['300', '60', '失败', 'E_COMBO_8192']) assert.ok(body.includes(text), text);
  assert.match(body, /未验证|未通过|尚未|未证实/); report.compression = { run, body, usage: issue(['resource', 'get'], { id: resourceId }).plugins.transcripts.data.usage };
  assert.equal(issue(['recall', 'scope'], { scope }).records, 1);
  report.checks.push('real CLI compression -> atomic write -> scope -> pinned direct read'); await save();
  report.index = issue(['recall', 'index', 'build'], { vectors: true }); assert.ok(report.index.usage.embeddingTexts > 0);
  const request = { scope, query: '连续命中攻击的有效间隔以及被打断时如何处理', retrievalMode: 'semantic', maxBytes: 12000, budgetTokens: 4000 };
  const semantic = issue(['recall', 'search'], request); assert.ok(semantic.stages.includes('vector')); assert.ok(semantic.evidence.some(e => e.resourceId === resourceId)); assert.ok(semantic.usage.modelCalls > 0);
  const hybrid = issue(['recall', 'search'], { ...request, retrievalMode: 'hybrid', rerank: true }); assert.ok(hybrid.stages.includes('rerank')); assert.ok(hybrid.stages.includes('rrf'));
  report.retrieval = { semantic, hybrid }; report.checks.push('real embedding / semantic paraphrase / hybrid RRF / reranking'); await save();
  await writeFile(file, first + turn('纠正：连击窗口改为280毫秒，原300毫秒不再适用。60帧上限不变。', '已修改280毫秒，但尚未重跑测试。不得报告验证通过。'));
  const second = issue(['transcript', 'run'], { id: org.id, sessionId: scope.sessionId, maxCalls: 1 }); assert.equal(second.saved, 1);
  report.incremental = issue(['recall', 'index', 'build'], { vectors: true }); assert.ok(report.incremental.usage.cacheHits > 0); assert.ok(report.incremental.usage.embeddingTexts > 0);
  assert.equal(issue(['transcript', 'run'], { id: org.id, sessionId: scope.sessionId, maxCalls: 1 }).calls, 0);
  report.repeatedIndex = issue(['recall', 'index', 'build'], { vectors: true }); assert.equal(report.repeatedIndex.usage.embeddingTexts, 0);
  const correction = issue(['recall', 'search'], { scope, query: '现在连续攻击的时间窗口是多少', retrievalMode: 'semantic' });
  assert.ok(correction.evidence.some(e => e.resourceId === second.records[0].resourceId));
  report.correction = correction; report.checks.push('incremental correction / vector cache / compression idempotency'); await save();
  const firstPage = issue(['recall', 'read'], { id: resourceId, scope, maxFragments: 1 });
  let page = firstPage, texts = page.evidence.map(e => e.text), guard = 0;
  while (page.continue && guard++ < 20) { page = issue(['recall', 'read'], page.continue); texts.push(...page.evidence.map(e => e.text)); }
  assert.equal(texts.join(''), body); report.checks.push('real compressed record continuation preserves all text');
  issue(['resource', 'delete'], { id: second.records[0].resourceId });
  assert.ok(issue(['recall', 'search'], request).evidence.every(e => e.resourceId !== second.records[0].resourceId));
  issue(['resource', 'restore'], { id: second.records[0].resourceId }); issue(['recall', 'index', 'build'], { vectors: true });
  report.checks.push('deleted evidence excluded before rebuild / restore'); await save();
  const cases = fixture.queries.filter(c => c.split === 'acceptance');
  report.evaluation = await evaluate(data, { cases, modes: ['literal', 'bm25', 'semantic', 'hybrid', 'hybrid-rerank', 'task'] });
  for (const result of report.evaluation.summary.filter(s => ['semantic', 'hybrid', 'hybrid-rerank', 'task'].includes(s.mode))) {
    assert.equal(result.verified, true); assert.equal(result.scopeLeaks, 0); assert.equal(result.referenceFailures, 0); assert.equal(result.noAnswerFalse, 0); assert.ok(result.recallAt5 >= 0.75); assert.ok(result.mrr >= 0.75); assert.ok(result.conditionCoverage >= 0.9);
  }
  report.checks.push('frozen v0.0.8 acceptance cases / six modes / original thresholds');
  await writeFile(path.join(base, 'latest.json'), JSON.stringify({ root, data, orgId: org.id, scope, resourceId, ledger }, null, 2));
} catch (error) { report.failures.push(String(error)); process.exitCode = 1; }
finally { if (started) issue(['service', 'stop']); report.ledger = JSON.parse(await readFile(ledger, 'utf8')); report.passed = !report.failures.length; await save(); }
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failures: report.failures, cloudCalls: report.ledger.attempts.length, reportFile }));
