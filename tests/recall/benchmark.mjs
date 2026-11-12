import { readFile, writeFile } from 'node:fs/promises';
import { prepare, recallCommand } from '../../dist/recall/recall.js';
import { buildIndex } from '../../dist/recall/index.js';
import { prepareModels, modelLock, infer, emptyUsage } from '../../dist/recall/models.js';
import { runDevelopmentWorkload } from '../../dist/recall/development.js';

// 只读取基线脚本生成的隔离库；热运行仍启动独立模型进程，不伪称常驻模型延迟。
const { dataDir } = JSON.parse(await readFile('artifacts/verification/v0.0.8/baseline.json', 'utf8'));
if (process.argv.includes('--prepare')) await prepareModels(dataDir);
const model = await modelLock(dataDir); if (!model) throw new Error('MODEL_NOT_READY');
const indexFirst = await buildIndex(dataDir, true, false);
const indexCached = await buildIndex(dataDir, true, false);
const scope = { projectId: 'alpha', modules: ['battle'] };
const listed = await prepare(dataDir, { mode: 'list', scope }); const id = listed.items[0].resourceId;
const requests = {
  read: { id, scope }, list: { mode: 'list', scope },
  bm25: { query: '连击窗口', scope, retrievalMode: 'lexical' },
  semantic: { query: '如何实现连续命中的攻击加成', scope, retrievalMode: 'semantic' },
  hybrid: { query: '如何实现连续命中的攻击加成', scope },
  rerank: { query: '如何实现连续命中的攻击加成', scope, rerank: true },
  task: { task: '如何实现连续命中的攻击加成', scope, rerank: true },
};
const rows = [];
for (const [mode, request] of Object.entries(requests)) for (let repeat = 0; repeat < 5; repeat++) {
  const started = performance.now(); const result = await prepare(dataDir, request);
  rows.push({ mode, repeat, durationMs: performance.now() - started, usage: result.usage, stages: result.stages, warnings: result.warnings });
}
for (let repeat = 0; repeat < 5; repeat++) {
  const started = performance.now(); await recallCommand(dataDir, ['recall', 'scope'], { scope });
  rows.push({ mode: 'scope', repeat, durationMs: performance.now() - started });
}
// 使用真实本机模型进程验证取消后互斥释放和后续重试，无模拟模型结果。
const running = infer(dataDir, model, 'rerank', Array(32).fill('只有普通攻击命中才开始计时。'), emptyUsage(), '连击窗口');
const outcome = running.then(() => 'completed', error => error.code ?? error.message);
await new Promise(resolve => setTimeout(resolve, 150));
await runDevelopmentWorkload({ command: 'node', args: ['-e', 'setTimeout(()=>{},300)'] });
const cancellation = await outcome;
const recovered = await infer(dataDir, model, 'embed', ['重试'], emptyUsage(), true);
if (cancellation !== 'DEVELOPMENT_BUSY' || recovered.values.length !== 1) throw new Error('MODEL_RECOVERY_FAILED');
const summary = [...new Set(rows.map(r => r.mode))].map(mode => {
  const selected = rows.filter(r => r.mode === mode); const times = selected.map(r => r.durationMs).sort((a,b) => a-b);
  return { mode, firstMs: selected[0].durationMs, subsequentMeanMs: selected.slice(1).reduce((sum,r) => sum+r.durationMs,0)/4, p95Ms: times[Math.ceil(times.length*.95)-1] };
});
await writeFile('artifacts/verification/v0.0.8/latency.json', JSON.stringify({ model, indexFirst, indexCached, rows, summary, cancellation, recovered: true, limitations: ['每组5次；p95在此样本中等于最大值', '同进程元数据/文件页缓存会变热，每个模型调用仍冷启动子进程', '未清空OS文件页缓存，不代表机器重启后的磁盘冷启动', '不与开发负载并行；负载退化结果见developer-load报告'] }, null, 2));
console.log(JSON.stringify({ summary, cancellation, firstIndex: indexFirst.durationMs, cachedIndex: indexCached.durationMs }));
