import { createHash } from 'node:crypto';
import { openApplication } from '../index.js';
import { prepare } from './recall.js';
import { allowed, requireValue, resolveScope, snapshot } from './scope.js';
import type { ScopeInput, Usage } from './types.js';

const MODES = ['literal', 'bm25', 'semantic', 'hybrid', 'hybrid-rerank', 'task'] as const;
interface Case { id: string; query: string; scope: ScopeInput; expected: string[]; required?: string[]; split?: string }

/** 固定语料快照的消融评价；脚本查询结果不冒充真实工作 Agent 任务。 */
export async function evaluate(dataDir: string, input: Record<string, unknown>) {
  requireValue(Array.isArray(input.cases) && input.cases.length > 0, 'cases 必须为非空数组');
  const cases = input.cases as Case[]; const modes = input.modes === undefined ? [...MODES] : input.modes as string[];
  requireValue(Array.isArray(modes) && modes.every(m => MODES.includes(m as any)), '未知评价模式');
  const source = await snapshot(dataDir); const originals = await snapshot(dataDir, true); const originalById = new Map(originals.records.map(r => [r.resourceId, r])); const rows: any[] = [];
  for (const test of cases) {
    requireValue(test && typeof test.id === 'string' && typeof test.query === 'string' && Array.isArray(test.expected), '评价样本无效');
    const scope = resolveScope(source.config, { scope: test.scope });
    const allow = new Set(source.records.filter(r => allowed(r, scope)).map(r => r.resourceId));
    for (const mode of modes) {
      const started = performance.now(); let result: any;
      const common = { query: test.query, scope: test.scope, maxFragments: 5, maxBytes: 12_000, budgetTokens: 4000 };
      if (mode === 'literal') {
        const app = await openApplication(dataDir, { readOnly: true });
        try {
          const matches: any = await app.plugins.execute('organize query', { body: [test.query], limit: 1000 }, []);
          const ids = matches.items.map((x: any) => x.resource.id).filter((id: string) => allow.has(id));
          const evidence = [];
          for (const id of ids) { const read = await prepare(dataDir, { ...common, mode: 'read', id }); evidence.push(...read.evidence); }
          result = { evidence: evidence.slice(0, 5), warnings: [], usage: { embeddingTexts: 0, embeddingTokens: 0, rerankPairs: 0, rerankTokens: 0, modelCalls: 0, cacheHits: 0, generationTokens: 0, apiCost: 0 } };
          while (Buffer.byteLength(JSON.stringify(result)) > common.maxBytes && result.evidence.length) result.evidence.pop();
        } finally { await app.close(); }
      } else result = await prepare(dataDir, { ...common, mode: mode === 'task' ? 'task' : 'question', retrievalMode: mode === 'bm25' ? 'lexical' : mode === 'semantic' ? 'semantic' : 'hybrid', rerank: mode === 'hybrid-rerank' || mode === 'task' });
      const evidence = result.evidence as { resourceId: string; text: string; contentVersion: number; contentHash: string; start: number; end: number }[]; const ids: string[] = [...new Set(evidence.map(e => e.resourceId))];
      const required = test.required ?? [];
      const relevant = evidence.map(e => test.expected.includes(e.resourceId) && (!required.length || required.some(text => e.text.includes(text)))); const first = relevant.indexOf(true);
      const found = new Set(evidence.filter((_, i) => relevant[i]).map(e => e.resourceId)).size;
      const dcg = relevant.reduce((sum, yes, i) => sum + (yes ? 1 / Math.log2(i + 2) : 0), 0);
      const ideal = Array.from({ length: Math.min(5, test.expected.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
      const fullText = evidence.map(e => e.text).join('\n');
      const referenceFailures = evidence.filter(e => { const r = originalById.get(e.resourceId); return !r || r.contentVersion !== e.contentVersion || r.contentHash !== e.contentHash || r.text.slice(e.start, e.end) !== e.text; }).length;
      rows.push({ caseId: test.id, mode, split: test.split ?? 'unspecified', answerable: !!test.expected.length, recallAt5: test.expected.length ? found / test.expected.length : null, reciprocalRank: first < 0 ? 0 : 1 / (first + 1), ndcgAt5: ideal ? dcg / ideal : null, noAnswerFalse: !test.expected.length && !!ids.length, scopeLeaks: ids.filter(id => !allow.has(id)).length, referenceFailures, requiredCoverage: required.length ? required.filter(t => fullText.includes(t)).length / required.length : null, duplicateRatio: evidence.length ? 1 - new Set(evidence.map(e => e.text)).size / evidence.length : 0, resultBytes: Buffer.byteLength(JSON.stringify(result)), durationMs: performance.now() - started, usage: result.usage as Usage, verified: !result.warnings.some((w: string) => /MODEL_|INDEX_|EXECUTION_FAILED|SOURCE_CHANGED/.test(w)), warnings: result.warnings, evidence: evidence.map((e, i) => ({ resourceId: e.resourceId, start: e.start, end: e.end, relevant: relevant[i] })) });
    }
  }
  const after = await snapshot(dataDir); requireValue(source.fingerprint === after.fingerprint, '评价期间语料变化，本次结果无效');
  const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return { kind: 'retrieval-only', snapshot: source.fingerprint, casesHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'), sampleCount: cases.length, rows, summary: modes.map(mode => { const selected = rows.filter(r => r.mode === mode); return { mode, verified: selected.every(r => r.verified), recallAt5: average(selected.filter(r => r.answerable).map(r => r.recallAt5)), mrr: average(selected.filter(r => r.answerable).map(r => r.reciprocalRank)), ndcgAt5: average(selected.filter(r => r.answerable).map(r => r.ndcgAt5)), noAnswerFalse: selected.filter(r => r.noAnswerFalse).length, scopeLeaks: selected.reduce((s, r) => s + r.scopeLeaks, 0), referenceFailures: selected.reduce((s, r) => s + r.referenceFailures, 0), conditionCoverage: average(selected.filter(r => r.requiredCoverage !== null).map(r => r.requiredCoverage)), meanMs: average(selected.map(r => r.durationMs)) }; }), limitations: ['相关片元必须同时命中目标资源和标注原文条件；仅命中标题不算正确证据', '脚本查询不是工作Agent端到端评价', '本机API费用为0；电力/硬件/工作Agent费用未据此推断'] };
}
