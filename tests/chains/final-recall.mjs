import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { TOPICS } from '../recall/fixture.mjs';
import { snapshot } from '../../dist/recall/scope.js';
import { buildIndex } from '../../dist/recall/index.js';
import { evaluate } from '../../dist/recall/evaluate.js';
import { recallCommand } from '../../dist/recall/recall.js';
import { CoreManager } from '../../dist/core/manager.js';

// 最终源码复测既有冻结问题与逐字条件；只复用已核验本机模型，不调用云端或下载。
globalThis.fetch = async () => { throw new Error('FINAL_RECALL_NETWORK_FORBIDDEN'); };
const fixture = JSON.parse(await readFile('.recall-local/v0.0.10/latest.json', 'utf8'));
const source = await snapshot(fixture.data);
const cases = TOPICS.slice(4).flatMap(([key, module, title, body, paraphrase, exact]) => {
  const record = source.records.find(r => r.title.replace(/(?:\.md)+$/, '') === `${title}-alpha` && r.projectId === 'alpha'); assert.ok(record, title);
  return [['exact', exact], ['paraphrase', paraphrase]].map(([kind, query]) => ({ id: `${key}-${kind}`, split: 'acceptance', query, scope: { projectId: 'alpha', modules: [module] }, expected: [record.resourceId], required: [body], noAnswer: false }));
});
cases.push({ id: 'beta-no-answer', split: 'acceptance', query: '税务申报的发票编号规则', scope: { projectId: 'beta', modules: ['battle'] }, expected: [], required: [], noAnswer: true });
const index = await buildIndex(fixture.data, true, false);
const manager = await CoreManager.open(fixture.data);
try { const store = manager.pluginStore('recall'); const active = await store.read('active-index', null, 'cache'); await store.write('active-index', { ...active, tokenizer: 'nfkc-cjk-bigram-1' }, 'cache'); } finally { await manager.close(); }
const migration = await buildIndex(fixture.data, true, false); assert.equal(migration.usage.embeddingTexts, 0); assert.ok(migration.usage.cacheHits > 0);
const evaluation = await evaluate(fixture.data, { cases, modes: ['literal', 'bm25', 'semantic', 'hybrid', 'hybrid-rerank', 'task'] });
const earlier = JSON.parse(await readFile('artifacts/verification/v0.0.10/live.json', 'utf8')); assert.equal(evaluation.casesHash, earlier.evaluation.casesHash);
for (const result of evaluation.summary.filter(s => ['semantic', 'hybrid', 'hybrid-rerank', 'task'].includes(s.mode))) {
  assert.equal(result.verified, true); assert.equal(result.scopeLeaks, 0); assert.equal(result.referenceFailures, 0); assert.equal(result.noAnswerFalse, 0); assert.ok(result.recallAt5 >= 0.75); assert.ok(result.mrr >= 0.75); assert.ok(result.conditionCoverage >= 0.9);
}
const latency = evaluation.summary.map(s => { const times = evaluation.rows.filter(r => r.mode === s.mode).map(r => r.durationMs).sort((a, b) => a - b); return { mode: s.mode, p95Ms: times[Math.ceil(times.length * 0.95) - 1] }; });
for (const action of ['scope', 'read', 'list']) {
  const times = [];
  for (let i = 0; i < 5; i++) { const at = performance.now(); await recallCommand(fixture.data, ['recall', action], { scope: cases[0].scope, ...(action === 'read' ? { id: cases[0].expected[0] } : {}) }); times.push(performance.now() - at); }
  latency.push({ mode: action, p95Ms: Math.max(...times) });
}
const limits = { scope: 500, read: 500, list: 500, bm25: 1000, semantic: 10000, hybrid: 10000, 'hybrid-rerank': 15000, task: 30000 };
for (const result of latency) if (limits[result.mode]) assert.ok(result.p95Ms < limits[result.mode], JSON.stringify(result));
const report = { passed: true, syntheticOnly: true, finalSource: true, index, migration, evaluation, latency };
await writeFile('artifacts/verification/v0.0.10/final-recall.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, summary: evaluation.summary, latency }));
