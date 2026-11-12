import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const base = 'artifacts/verification/v0.0.10/';
const json = async name => JSON.parse(await readFile(base + name + '.json', 'utf8'));
const [live, agent, recall, demo] = await Promise.all(['live', 'agent', 'final-recall', 'demo'].map(json));
for (const result of [live, agent, recall, demo]) assert.equal(result.passed, true);
const counts = {};
for (const name of ['baseline', 'final', 'final-cli']) {
  const log = await readFile(base + name + '.tap', 'utf8');
  const total = Number(log.match(/(?:ℹ|#) tests (\d+)/)?.[1]), passed = Number(log.match(/(?:ℹ|#) pass (\d+)/)?.[1]);
  assert.ok(total > 0 && total === passed, name); counts[name] = { total, passed };
}
const peakModelRssBytes = Math.max(...recall.evaluation.rows.map(row => row.usage.modelPeakRssBytes ?? 0));
assert.ok(peakModelRssBytes < 1610612736);
assert.equal(agent.cases.length, 6); assert.ok(agent.cases.every(c => c.passed));
assert.equal(recall.migration.usage.embeddingTexts, 0); assert.ok(recall.migration.usage.cacheHits > 0);
const cloud = agent.ledger.attempts.reduce((sum, a) => ({ calls: sum.calls + 1, inputTokens: sum.inputTokens + a.usage.prompt_tokens, outputTokens: sum.outputTokens + a.usage.completion_tokens }), { calls: 0, inputTokens: 0, outputTokens: 0 });
assert.ok(cloud.calls <= agent.ledger.maximumCalls);
// 记录候选工作树内容身份；不把未提交改动伪装成已发布提交。
const files = ['package.json', 'package-lock.json', 'src/cli/main.ts', 'src/cli/contract.ts', 'src/records/transcript.ts', 'src/service/cron-service.ts', 'src/recall/fragments.ts', 'src/recall/index.ts', 'src/recall/recall.ts', 'src/recall/types.ts', 'src/recall/recall.test.ts', 'tests/chains/chain.test.mjs', 'tests/chains/offline-model.mjs', 'tests/chains/live.mjs', 'tests/chains/live-ledger.mjs', 'tests/chains/agent.mjs', 'tests/chains/final-recall.mjs', 'examples/agent/project-integration.mjs', 'examples/agent/offline-provider.mjs', 'doc/新增需求/v0.0.10/agent-project-prompt.md'];
const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { measuredGatesPassed: true, userAcceptance: 'pending', released: false, mcpImplemented: false, at: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), sourceHashes, counts, realAgentCases: agent.cases.map(c => ({ name: c.name, passed: c.passed })), frozenRecallCases: recall.evaluation.sampleCount, retrieval: recall.evaluation.summary, latency: recall.latency, peakModelRssBytes, migration: recall.migration.usage, model: live.model, cloud: { ...cloud, totalTokens: cloud.inputTokens + cloud.outputTokens, limit: agent.ledger.maximumCalls, budgetChange: agent.ledger.budgetChange, monetaryCost: '未查询账单/未换算货币费用' }, limitations: ['合成数据与每类一个Agent任务，不代表任意长会话完整性', '本轮未重复开发负载配对非劣试验；3%结论仍限定既有显式workload保护', '全量149项之后仅修改CLI传输参数校验，最终10项CLI链路另行复测通过', '真实Agent调试失败及预算追加保留在账本和agent-before-*记录中'] };
await writeFile(base + 'summary.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ measuredGatesPassed: true, counts, realAgentCases: 6, cloud, peakModelRssBytes }));
