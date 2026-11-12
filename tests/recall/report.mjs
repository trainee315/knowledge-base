import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/verification/v0.0.8/';
const campaign = process.argv.find(a => a.startsWith('--campaign='))?.slice('--campaign='.length) ?? 'final';
if (!/^[a-z0-9-]{1,40}$/.test(campaign)) throw new Error('INVALID_CAMPAIGN');
const read = async name => JSON.parse(await readFile(root + name + '.json', 'utf8'));
const thresholds = JSON.parse(await readFile('doc/新增需求/v0.0.8/thresholds.json', 'utf8'));
const retrieval = await read('acceptance-models'), latency = await read('latency'), agent = await read('agent-tasks-' + campaign), ledger = await read('agent-ledger-' + campaign), workload = await read('developer-load-guarded-extended-stream-atomic-v2');
if (!agent.complete || !ledger.closed || !workload.complete) throw new Error('INCOMPLETE_EVALUATION');
const median = values => { const v = [...values].sort((a,b) => a-b); return (v[Math.floor((v.length-1)/2)] + v[Math.ceil((v.length-1)/2)])/2; };
const sumUsage = (rows, field) => Object.fromEntries((field === 'usage' ? ['inputTokens','outputTokens'] : ['embeddingTexts','embeddingTokens','rerankPairs','rerankTokens','modelCalls','generationTokens','apiCost']).map(key => [key, rows.reduce((sum,row) => sum + (row[field]?.[key] ?? 0),0)]));
const tasks = [...new Set(agent.rows.map(r => r.mode))].map(mode => {
  const rows = agent.rows.filter(r => r.mode === mode), history = rows.filter(r => r.task !== 'self-contained');
  return { mode, samples: rows.length, completedWithEvidence: rows.filter(r => r.success && r.evidenceCorrect).length, historyMedianQueries: median(history.map(r => r.queries)), missedQueries: rows.filter(r => r.missedQuery).length, unnecessaryQueries: rows.reduce((sum,r) => sum+r.unnecessaryQueries,0), repeatedQueries: rows.reduce((sum,r) => sum+r.repeatedQueries,0), historicalTaskFailures: history.filter(r => r.task === 'history' && (!r.success || !r.evidenceCorrect)).length, agentUsage: { ...sumUsage(rows,'usage'), calls: rows.reduce((sum,r) => sum+r.calls,0) }, retrievalUsage: sumUsage(rows,'retrievalUsage') };
});
const baseline = tasks.find(r => r.mode === 'literal');
const quality = retrieval.summary.filter(r => ['hybrid','hybrid-rerank','task'].includes(r.mode)).every(r => r.verified && r.recallAt5 >= thresholds.quality.acceptanceRecallAt5Min && r.mrr >= thresholds.quality.acceptanceMrrMin && r.conditionCoverage >= thresholds.quality.conditionCoverageMin);
const references = retrieval.rows.every(r => r.scopeLeaks === 0 && r.referenceFailures === 0 && !r.noAnswerFalse);
const task = tasks.filter(r => r.mode !== 'literal').every(r => r.completedWithEvidence >= baseline.completedWithEvidence && r.historyMedianQueries < baseline.historyMedianQueries && r.historicalTaskFailures === 0 && r.missedQueries === 0 && r.unnecessaryQueries === 0);
const latencyPassed = latency.summary.every(r => r.p95Ms <= (['read','list','scope'].includes(r.mode) ? thresholds.latency.metadataP95Ms : r.mode === 'bm25' ? thresholds.latency.lexicalP95Ms : r.mode === 'rerank' ? thresholds.latency.rerankedColdP95Ms : r.mode === 'task' ? thresholds.latency.taskColdP95Ms : thresholds.latency.semanticColdP95Ms));
const modelPeakRssBytes = Math.max(...[...latency.rows,...retrieval.rows].map(r => r.usage?.modelPeakRssBytes ?? 0));
const gates = { retrievalQuality: quality, referencesAndIsolation: references, agentTasks: task, latency: latencyPassed, modelRss: modelPeakRssBytes <= thresholds.resources.modelPeakRssBytes, developmentWorkload: workload.summary.every(r => r.passed) };
const result = { measuredGatesPassed: Object.values(gates).every(Boolean), userAcceptance: 'pending', performanceScope: 'explicit recall workload protection; unguarded concurrent execution failed', gates, retrieval: retrieval.summary, tasks, modelPeakRssBytes, finalAgentCostUpperUsd: ledger.costUpperUsd, finalAgentCalls: ledger.calls, finalAgentCacheHitTokens: ledger.attempts.reduce((s,a) => s+(a.usage?.cacheHitTokens??0),0), finalAgentCacheMissTokens: ledger.attempts.reduce((s,a) => s+(a.usage?.cacheMissTokens??0),0), workload: workload.summary, limitations: ['门槛不自动覆盖未测规模和机器', '历史误用以函数测试和证据定位判断，不是通用真伪判定', '全部通过也仍需用户验收；本脚本不执行发布'] };
await writeFile(root + 'summary.json', JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
if (!result.measuredGatesPassed) process.exitCode = 1;
