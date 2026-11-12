import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { CoreManager } from '../core/manager.js';
import { allowed, configure, fail, hash, requireValue, resolveScope, snapshot } from './scope.js';
import { split, terms } from './fragments.js';
import { buildIndex, indexStatus, lexical, openIndex, scopedFragments } from './index.js';
import { emptyUsage, infer, modelLock, prepareModels } from './models.js';
import type { Fragment, Hit, Request, Scope, SourceRecord, Usage } from './types.js';
import { requireDevelopmentIdle } from './development.js';

const RRF_K = 60; // 按排名融合，不混加 BM25/cosine/logits。
const DEFAULT_CANDIDATES = 20;
const SEMANTIC_MIN = 0.40; // 调优集最低正确Top1=.420、无答案最高=.375，门槛冻结见 tuning-scores.json。
const DEFAULT_BYTES = 12_000;
const MIN_BYTES = 1200; // 足够容纳范围、限制和至少一个继续读取入口。
const MAX_BYTES = 100_000;
const SCOPE_CACHE_LIMIT = 64; // 元数据修订、完整范围和索引状态共同限定缓存，避免跨项目复用。
const scopeCache = new Map<string, any>();
const TASK_MARKERS: Record<string, string[]> = { '适用约束': ['约束','必须','不得','仅','只有'], '相关设计与决策': ['设计','决定','方案','计划'], '已知问题与例外': ['失败','例外','问题','被打断','无敌','取消'], '验证依据': ['验证','测试','实测'] };

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number { const n = value === undefined ? fallback : Number(value); requireValue(Number.isSafeInteger(n) && n >= min && n <= max, `${name} 必须在 ${min}..${max}`); return n; }
function bool(value: unknown): boolean { requireValue(value === undefined || [true, false, 'true', 'false'].includes(value as any), '布尔参数无效'); return value === true || value === 'true'; }
function parse(input: Record<string, unknown>): Request {
  requireValue(Object.keys(input).every(k => ['mode','id','version','query','task','needs','scope','contextProjectId','cwd','retrievalMode','rerank','budgetTokens','maxBytes','maxFragments','candidates','neighbors','section','offset','limit','sort','direction','debug','projectId','input','json'].includes(k)), '未知召回请求字段');
  const request = { ...input } as Request;
  if (!request.scope && input.projectId) request.scope = { projectId: String(input.projectId) };
  requireValue(request.mode === undefined || ['auto', 'read', 'list', 'question', 'task'].includes(request.mode), 'mode 无效');
  requireValue(request.retrievalMode === undefined || ['lexical', 'semantic', 'hybrid'].includes(request.retrievalMode), 'retrievalMode 无效');
  for (const key of ['id', 'query', 'task', 'contextProjectId', 'cwd', 'section'] as const) requireValue(request[key] === undefined || typeof request[key] === 'string' && request[key]!.trim().length > 0 && request[key]!.length <= 16_000, `${key} 无效`);
  requireValue(request.needs === undefined || Array.isArray(request.needs) && request.needs.length > 0 && request.needs.length <= 8 && request.needs.every(n => typeof n === 'string' && n.trim().length > 0 && n.length < 1000), 'needs 必须为1..8个问题');
  request.budgetTokens = integer(request.budgetTokens, 3000, 400, 32_000, 'budgetTokens');
  request.maxBytes = Math.min(integer(request.maxBytes, DEFAULT_BYTES, MIN_BYTES, MAX_BYTES, 'maxBytes'), request.budgetTokens * 3);
  request.maxFragments = integer(request.maxFragments, 6, 1, 50, 'maxFragments'); request.candidates = integer(request.candidates, DEFAULT_CANDIDATES, 1, 100, 'candidates');
  request.neighbors = integer(request.neighbors, 0, 0, 3, 'neighbors'); request.offset = integer(request.offset, 0, 0, 1_000_000, 'offset'); request.limit = integer(request.limit, 20, 1, 100, 'limit');
  if (request.version !== undefined) request.version = integer(request.version, 1, 1, 1_000_000, 'version');
  requireValue(request.sort === undefined || ['recordedAt', 'title'].includes(request.sort), 'sort 无效'); requireValue(request.direction === undefined || ['asc', 'desc'].includes(request.direction), 'direction 无效');
  request.rerank = bool(request.rerank); request.debug = bool(request.debug);
  if (request.retrievalMode === 'lexical') request.rerank = false;
  return request;
}
function hit(fragment: Fragment, scope: Scope, methods: string[], score?: number, ranks?: Record<string, number>): Hit { return { ...fragment, methods, ...(score !== undefined ? { score } : {}), ...(ranks ? { ranks } : {}), read: { id: fragment.resourceId, version: fragment.contentVersion, scope, offset: fragment.ordinal } }; }

async function original(dataDir: string, record: SourceRecord): Promise<SourceRecord> {
  const manager = await CoreManager.open(dataDir, { readOnly: true });
  try {
    return await manager.storage.snapshot(async () => {
      const resource = await manager.getResource(record.resourceId); if (resource.deletedAt) fail('RESOURCE_DELETED', '资源已删除');
      const bytes = await manager.readContent(record.resourceId, record.contentVersion);
      if (hash(bytes) !== record.contentHash) fail('CONTENT_HASH_MISMATCH', '原件与索引固定版本不同');
      return { ...record, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    });
  } finally { await manager.close(); }
}

/** 对完整 JSON 响应计预算，保留完整片元；省略不冒充原文完整。 */
function budget(result: any, request: Request) {
  result.budget = { maxBytes: request.maxBytes, maxTokens: request.budgetTokens, returnedBytes: 0, estimatedTokens: 0, counting: 'utf8-bytes/3 estimate', omitted: 0 };
  const measure = () => Buffer.byteLength(JSON.stringify({ ok: true, data: result }));
  const remove = () => {
    const removed = result.evidence?.pop() ?? result.items?.pop();
    if (!removed) return false;
    result.budget.omitted++; if (result.status !== 'ambiguous') result.status = 'insufficient';
    if (removed.need && !result.gaps.includes(removed.need)) result.gaps.push(removed.need);
    if (!result.continue) result.continue = removed.read ?? { id: removed.resourceId, scope: result.scope };
    if (!result.warnings.includes('OUTPUT_BUDGET_OMITTED')) result.warnings.push('OUTPUT_BUDGET_OMITTED');
    return true;
  };
  while (result.evidence?.length > request.maxFragments! || measure() > request.maxBytes! - 100) if (!remove()) break;
  if (measure() > request.maxBytes! - 100) { delete result.debug; result.warnings = ['OUTPUT_METADATA_BUDGET']; result.gaps = ['完整请求元数据超出预算，请缩小范围或增加预算']; if (result.needs) result.needs = []; }
  for (let i = 0; i < 4; i++) { result.budget.returnedBytes = measure(); result.budget.estimatedTokens = Math.ceil(result.budget.returnedBytes / 3); }
  if (measure() > request.maxBytes!) fail('OUTPUT_BUDGET', '预算不足以容纳必要定位和范围，请增加预算');
  return result;
}

function meaningfulMatch(query: string, text: string) {
  const wanted = [...new Set(terms(query).filter(t => [...t].length >= 2))];
  if (!wanted.length) return text.normalize('NFKC').includes(query.normalize('NFKC'));
  const actual = new Set(terms(text)); return wanted.filter(t => actual.has(t)).length >= Math.min(2, wanted.length);
}

export async function prepare(dataDir: string, raw: Record<string, unknown>) {
  if (!raw.id && raw.mode !== 'read' && raw.mode !== 'list' && (raw.query || raw.task)) await requireDevelopmentIdle();
  const start = performance.now(); const request = parse(raw); const source = await snapshot(dataDir, false, request.id && request.version ? { [request.id]: request.version } : {});
  const scope = resolveScope(source.config, request); const records = source.records.filter(r => allowed(r, scope)); const byId = new Map(records.map(r => [r.resourceId, r]));
  const route = request.mode && request.mode !== 'auto' ? request.mode : request.id ? 'read' : request.task ? 'task' : request.query ? 'question' : 'list';
  const usage = emptyUsage(); const stages: string[] = ['scope']; const warnings: string[] = []; const needs: string[] = []; const gaps: string[] = [];
  const result: any = { requestId: randomUUID(), route, reason: request.mode && request.mode !== 'auto' ? 'explicit' : 'deterministic-input-route', scope, status: 'ok', stages, evidence: [], needs, gaps, warnings, usage, timings: {} };
  if (source.records.some(r => !r.projectId)) warnings.push('UNKNOWN_SCOPE_RECORDS_EXCLUDED');
  let index: Awaited<ReturnType<typeof openIndex>> = null;
  const finish = () => { result.timings.totalMs = performance.now() - start; if (!result.evidence.length && !result.items?.length && !['unavailable', 'ambiguous'].includes(result.status)) result.status = 'insufficient'; return budget(result, request); };
  if (route === 'list') {
    stages.push('metadata-list'); const direction = request.direction ?? 'desc'; const field = request.sort ?? 'recordedAt';
    let selected = records;
    if (request.query) { // 显式列举全文筛选只走 lexical 路径。
      index = await openIndex(dataDir); if (!index) { warnings.push('INDEX_NOT_READY'); result.items = []; return finish(); }
      try { const ids = new Set(lexical(index.db, records.map(r => r.resourceId), request.query, 100_000).filter(h => { const current = byId.get(h.fragment.resourceId); return current?.contentVersion === h.fragment.contentVersion && current.contentHash === h.fragment.contentHash && meaningfulMatch(request.query!, h.fragment.text); }).map(h => h.fragment.resourceId)); selected = selected.filter(r => ids.has(r.resourceId)); stages.push('bm25-filter'); } finally { index.db.close(); }
      if (index.active.fingerprint !== source.fingerprint) warnings.push('INDEX_STALE');
    }
    selected.sort((a, b) => (direction === 'asc' ? 1 : -1) * a[field].localeCompare(b[field]) || a.resourceId.localeCompare(b.resourceId));
    result.items = selected.slice(request.offset, request.offset! + request.limit!).map(({ text, ...record }) => record);
    result.page = { offset: request.offset, limit: request.limit, total: selected.length, sort: field, direction }; return finish();
  }
  if (route === 'read') {
    requireValue(request.id, 'read 需要明确 id'); stages.push('direct-read');
    let fragment: Fragment | undefined;
    if (request.id.startsWith('f-')) {
      index = await openIndex(dataDir); if (!index) fail('INDEX_NOT_READY', '片元定位需要已有索引；可直接用资源 ID 和版本读取');
      try { const row = index.db.prepare('SELECT payload FROM fragments WHERE id=?').get(request.id) as { payload: string } | undefined; if (row) fragment = JSON.parse(row.payload); } finally { index.db.close(); }
      if (!fragment) fail('NOT_FOUND', '片元不在当前代次，请用原引用的资源 ID/版本读取');
    }
    const id = fragment?.resourceId ?? request.id; let record = byId.get(id);
    if (!record && !fragment) {
      const matches = records.filter(r => r.title === request.id);
      if (matches.length > 1) {
        result.status = 'ambiguous'; result.reason = 'exact-title-multiple-matches';
        result.items = matches.map(r => ({ resourceId: r.resourceId, title: r.title, read: { id: r.resourceId, scope } }));
        return finish();
      }
      record = matches[0];
      if (record && request.version) record = (await snapshot(dataDir, false, { [record.resourceId]: request.version })).records.find(r => r.resourceId === record!.resourceId && allowed(r, scope));
    }
    if (!record) fail('SCOPE_NOT_FOUND', '资源不存在、已删除或不在允许范围');
    if (fragment && (record.contentVersion !== fragment.contentVersion || record.contentHash !== fragment.contentHash)) fail('INDEX_STALE', '片元版本已改变，请按资源固定版本读取');
    record = await original(dataDir, record); const all = split(record, source.config.chunking);
    if (fragment && !all.some(f => f.id === fragment!.id)) fail('INDEX_STALE', '切分配置已变化，请重建或按固定资源版本读取');
    let selected = fragment ? all.filter(f => Math.abs(f.ordinal - fragment!.ordinal) <= request.neighbors!) : all.slice(request.offset);
    if (request.section) selected = selected.filter(f => f.headings.includes(request.section!));
    result.evidence = selected.map(f => hit(f, scope, ['direct']));
    if (selected.some(f => f.continued)) warnings.push('LONG_BLOCK_REQUIRES_ADJACENT_CONTEXT');
    return finish();
  }
  const query = request.query ?? request.task; requireValue(query, '检索需要 query 或 task');
  index = await openIndex(dataDir);
  if (!index) { warnings.push('INDEX_NOT_READY'); gaps.push('先执行 recall index build；缺失索引不等于无资料'); return finish(); }
  result.index = { generation: index.active.generation, stale: index.active.fingerprint !== source.fingerprint };
  if (result.index.stale) warnings.push('INDEX_STALE');
  if (index.active.truncatedEncodingInputs) warnings.push('INDEX_ENCODING_INPUTS_TRUNCATED');
  try {
    const current = (fragment: Fragment) => { const record = byId.get(fragment.resourceId); return !!record && record.contentVersion === fragment.contentVersion && record.contentHash === fragment.contentHash; };
    const candidates = scopedFragments(index.db, records.map(r => r.resourceId)).filter(x => current(x.fragment));
    const currentIds = [...new Set(candidates.map(x => x.fragment.resourceId))];
    const mode = request.retrievalMode ?? 'hybrid'; let lock: Awaited<ReturnType<typeof modelLock>>;
    try { lock = mode !== 'lexical' || request.rerank ? await modelLock(dataDir) : undefined; }
    catch (error) { if ((error as { code?: string }).code !== 'MODEL_INVALID') throw error; warnings.push('MODEL_INVALID'); }
    let semantic = mode !== 'lexical' && !!lock && lock.fingerprint === index.active.model;
    if (mode !== 'lexical' && !semantic) warnings.push(!lock ? 'MODEL_NOT_READY' : 'VECTOR_INDEX_NOT_READY');
    if (mode === 'semantic' && !semantic) { result.status = 'unavailable'; gaps.push('纯向量路径不可用，不以全文结果冒充'); return finish(); }
    const questions = route === 'task' ? request.needs ?? ['适用约束', '相关设计与决策', '已知问题与例外', '验证依据'] : [query];
    needs.push(...questions);
    const selected = new Map<string, Hit>();
    if (route === 'task') {
      stages.push('registered-entries');
      for (const id of source.config.projects.filter(p => scope.projectIds.includes(p.id)).flatMap(p => p.entries)) {
        const record = byId.get(id);
        if (!record) { gaps.push('固定入口不在范围或已不可用'); continue; }
        for (const f of split(await original(dataDir, record), source.config.chunking)) selected.set(f.id, { ...hit(f, scope, ['registered']), need: '适用约束' });
      }
    }
    const rankedCache = new Map<string, { fragment: Fragment; ranks: Record<string, number>; score: number }[]>();
    for (const need of questions) {
      const question = route === 'task' && request.needs ? `${query}\n${need}` : query;
      const cached = rankedCache.get(question);
      const ranks = new Map<string, { fragment: Fragment; ranks: Record<string, number>; score: number }>();
      const add = (fragment: Fragment, method: string, rank: number) => { const entry = ranks.get(fragment.id) ?? { fragment, ranks: {}, score: 0 }; entry.ranks[method] = rank; entry.score += 1 / ((source.config.ranking?.rrfK ?? RRF_K) + rank); ranks.set(fragment.id, entry); };
      if (mode !== 'semantic' && !cached) {
        const at = performance.now(); const found = lexical(index.db, currentIds, question, request.candidates!, source.config.ranking?.bm25TitleWeight).filter(x => meaningfulMatch(query, x.fragment.title + '\n' + x.fragment.text));
        found.forEach((x, i) => add(x.fragment, 'bm25', i + 1)); if (!stages.includes('bm25')) stages.push('bm25'); result.timings.bm25Ms = (result.timings.bm25Ms ?? 0) + performance.now() - at;
      }
      if (semantic && lock && !cached) {
        const at = performance.now();
        try {
          const encoded = await infer(dataDir, lock, 'embed', [question], usage, true); const vector = encoded.values[0] as number[];
          if (encoded.truncated) warnings.push('QUERY_ENCODING_TRUNCATED');
          const found = candidates.filter(x => x.vector).map(x => ({ fragment: x.fragment, score: x.vector!.reduce((sum, v, i) => sum + v * vector[i], 0) })).filter(x => x.score >= (source.config.ranking?.semanticMinScore ?? SEMANTIC_MIN)).sort((a, b) => b.score - a.score || a.fragment.id.localeCompare(b.fragment.id)).slice(0, request.candidates);
          found.forEach((x, i) => add(x.fragment, 'vector', i + 1)); if (!stages.includes('vector')) stages.push('vector');
        } catch (error) { if ((error as { code?: string }).code === 'DEVELOPMENT_BUSY') throw error; semantic = false; warnings.push('MODEL_EXECUTION_FAILED'); if (mode === 'semantic') { result.status = 'unavailable'; return finish(); } }
        result.timings.vectorMs = (result.timings.vectorMs ?? 0) + performance.now() - at;
      }
      let ranked = cached ?? [...ranks.values()].sort((a, b) => b.score - a.score || a.fragment.id.localeCompare(b.fragment.id)).slice(0, request.candidates);
      if (mode === 'hybrid' && semantic && !stages.includes('rrf')) stages.push('rrf');
      if (request.rerank && ranked.length && !cached) {
        if (!lock) warnings.push('RERANK_MODEL_NOT_READY');
        else {
          const at = performance.now();
          try { const ordered = await infer(dataDir, lock, 'rerank', ranked.map(r => r.fragment.text), usage, question); if (ordered.truncated) warnings.push('RERANK_INPUT_TRUNCATED'); ranked = ranked.map((r, i) => ({ ...r, score: ordered.values[i] as number })).sort((a, b) => b.score - a.score || a.fragment.id.localeCompare(b.fragment.id)); if (!stages.includes('rerank')) stages.push('rerank'); }
          catch (error) { if ((error as { code?: string }).code === 'DEVELOPMENT_BUSY') throw error; warnings.push('RERANK_EXECUTION_FAILED'); }
          result.timings.rerankMs = (result.timings.rerankMs ?? 0) + performance.now() - at;
        }
      }
      rankedCache.set(question, ranked);
      const relevant = ranked.filter(r => route !== 'task' || request.needs || (TASK_MARKERS[need] ?? [need]).some(marker => (r.fragment.headings.join(' ') + ' ' + r.fragment.text).includes(marker)));
      if (!relevant.length) gaps.push(need);
      for (const r of relevant.slice(0, route === 'task' ? 2 : request.maxFragments)) {
        if (!selected.has(r.fragment.id)) selected.set(r.fragment.id, { ...hit(r.fragment, scope, Object.keys(r.ranks), r.score, request.debug ? r.ranks : undefined), need });
      }
    }
    if (request.neighbors || [...selected.values()].some(f => f.continued)) {
      if ([...selected.values()].some(f => f.continued)) warnings.push('LONG_BLOCK_REQUIRES_ADJACENT_CONTEXT');
      stages.push('adjacent'); const originals = [...selected.values()];
      for (const item of originals) for (const { fragment } of candidates) if (fragment.resourceId === item.resourceId && Math.abs(fragment.ordinal - item.ordinal) <= (request.neighbors || (item.continued ? 1 : 0)) && !selected.has(fragment.id)) selected.set(fragment.id, hit(fragment, scope, ['adjacent']));
    }
    // 模型执行期间可能发生删除/映射变化；最终快照校验不能只信旧索引。
    const fresh = await snapshot(dataDir); const freshScope = resolveScope(fresh.config, request); const valid = new Map(fresh.records.filter(r => allowed(r, freshScope)).map(r => [r.resourceId, r]));
    const checked = new Map<string, SourceRecord>();
    for (const item of selected.values()) {
      const record = valid.get(item.resourceId); if (!record || record.contentVersion !== item.contentVersion || record.contentHash !== item.contentHash) { warnings.push('SOURCE_CHANGED_EVIDENCE_REMOVED'); continue; }
      const body = checked.get(record.resourceId) ?? await original(dataDir, record); checked.set(record.resourceId, body);
      if (body.text.slice(item.start, item.end) !== item.text) fail('INDEX_INVALID', '片元与原文偏移不匹配');
      const { text, ...metadata } = record; result.evidence.push({ ...item, ...metadata });
    }
    if (route === 'task') stages.push('task-assembly');
    result.warnings = [...new Set(warnings)]; if (gaps.length || warnings.length) result.status = 'partial'; return finish();
  } finally { index.db.close(); }
}

export async function recallCommand(dataDir: string, words: string[], input: Record<string, unknown>) {
  const action = words[1];
  if (action === 'configure') return configure(dataDir, input);
  if (action === 'model') { if (words[2] === 'prepare') return prepareModels(dataDir); requireValue(words[2] === 'status', '未知 model 操作'); const lock = await modelLock(dataDir); return { ready: !!lock, ...(lock ? { identity: lock.fingerprint, embedding: lock.embedding, reranker: lock.reranker, runtime: lock.runtime } : {}) }; }
  if (action === 'index') { if (words[2] === 'build') return buildIndex(dataDir, bool(input.vectors), bool(input.rebuild)); requireValue(words[2] === 'status', '未知 index 操作'); return indexStatus(dataDir); }
  if (action === 'scope') return scopeSummary(dataDir, input);
  if (action === 'eval') { const { evaluate } = await import('./evaluate.js'); return evaluate(dataDir, input); }
  requireValue(['prepare', 'read', 'list', 'search'].includes(action), '未知 recall 操作');
  return prepare(dataDir, { ...input, ...(action === 'read' || action === 'list' ? { mode: action } : action === 'search' ? { mode: 'question' } : {}) });
}

/** 仅缓存精简元数据；每次核验源修订，读取者不能修改其他请求的缓存。 */
async function scopeSummary(dataDir: string, input: Record<string, unknown>) {
  const request = parse(input); const source = await snapshot(dataDir); const scope = resolveScope(source.config, request);
  const index = await indexStatus(dataDir); const key = hash(JSON.stringify([dataDir, source.fingerprint, scope, index, request.maxBytes]));
  if (scopeCache.has(key)) return structuredClone(scopeCache.get(key));
  const records = source.records.filter(r => allowed(r, scope)); const dates = records.map(r => r.recordedAt).sort();
  const summary = { scope, revision: source.config.revision, projects: source.config.projects.filter(p => scope.projectIds.includes(p.id)).map(({ id, modules }) => ({ id, modules: [...modules] })), organizations: [...new Set(records.flatMap(r => r.organizationIds))], records: records.length, unknownScopeRecords: source.records.filter(r => !r.projectId).length, recordedFrom: dates[0], recordedTo: dates.at(-1), index, capabilities: ['read', 'list', 'question', 'task'], omittedMetadata: 0 };
  while (Buffer.byteLength(JSON.stringify({ ok: true, data: summary })) > request.maxBytes!) {
    if (summary.organizations.length) summary.organizations.pop();
    else if (summary.projects.some(p => p.modules.length)) summary.projects.find(p => p.modules.length)!.modules.pop();
    else if (summary.projects.length) summary.projects.pop();
    else fail('OUTPUT_BUDGET', '范围元数据超出预算，请缩小范围');
    summary.omittedMetadata++;
  }
  if (scopeCache.size >= SCOPE_CACHE_LIMIT) scopeCache.delete(scopeCache.keys().next().value!);
  scopeCache.set(key, structuredClone(summary)); return summary;
}
