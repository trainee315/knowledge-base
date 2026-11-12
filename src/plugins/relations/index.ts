import type { PluginDefinition } from '../../contracts/index.js';
import type { AgentApi } from '../../agent/types.js';
import { KnowledgeError } from '../../core/errors.js';
import type { TagsApi, TagDefinition } from '../tags/index.js';
import type { KeywordsApi } from '../keywords/index.js';
import { normalize } from '../keywords/extract.js';
import { manifest, required, strings, number } from '../shared.js';
import { lexicalProvider, type RelationScore, type ScoringProvider } from './lexical.js';
import { agentProviderIdentity, createAgentScorer } from './agent-scorer.js';
import { digest, readRelationRecord, scopeKey, type CoverageEntry, type RelationProviderIdentity, type RelationRecord, type RelationScope } from './cache.js';

// 默认离线，评分逻辑版本须显式提升；加载、配置查询不发出请求。
export const DEFAULT_RELATION_CONFIG: RelationConfig = { schemaVersion: 1, mode: 'offline', scoringLogicVersion: '1', maxBatchSize: 32 };
const TAG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export interface RelationConfig { schemaVersion: 1; mode: 'offline' | 'agent'; agentProfile?: string; scoringLogicVersion: string; maxBatchSize: number }
export interface ScoredRelations {
  tagId: string; tagRevision: number; provider: RelationProviderIdentity; scoringLogicVersion: string;
  scores: RelationScore[]; coverage: CoverageEntry[]; at: string; warnings: string[];
  stats?: { requested: number; missing: number; reused: number; requests: number };
}
export interface RelationPlan { missing: string[]; covered: string[]; estimatedCalls: number; scope: string }
export interface RelationsApi {
  score(tagId: string, keywords: string[], signal?: AbortSignal, options?: { maxRequests?: number }): Promise<ScoredRelations>;
  get(tagId: string): Promise<ScoredRelations | undefined>; setProvider(provider: ScoringProvider): void;
  provider(): RelationProviderIdentity & { scoringLogicVersion: string; cacheIdentity: string };
  getConfig(): RelationConfig; configure(patch: Partial<Omit<RelationConfig, 'schemaVersion'>>): Promise<RelationConfig>;
  plan(tagId: string, keywords: string[]): Promise<RelationPlan>;
}
function words(input: string[]): string[] {
  if (!Array.isArray(input) || input.some(word => typeof word !== 'string' || !normalize(word))) throw new KnowledgeError('INVALID_INPUT', 'keywords必须为非空字符串数组');
  return [...new Set(input.map(normalize))];
}
function validateConfig(input: unknown): asserts input is RelationConfig {
  if (!input || typeof input !== 'object') throw new KnowledgeError('INVALID_RELATION_CONFIG', '评分配置必须为对象');
  const value = input as RelationConfig;
  if (value.schemaVersion !== 1) throw new KnowledgeError('UNSUPPORTED_RELATION_SCHEMA', '不支持此评分配置版本，禁止覆盖');
  if (!['offline', 'agent'].includes(value.mode) || typeof value.scoringLogicVersion !== 'string' || !value.scoringLogicVersion.trim() || value.scoringLogicVersion.length > 128 || !Number.isSafeInteger(value.maxBatchSize) || value.maxBatchSize < 1 || value.maxBatchSize > 100 || value.agentProfile !== undefined && (typeof value.agentProfile !== 'string' || !value.agentProfile.trim())) throw new KnowledgeError('INVALID_RELATION_CONFIG', '评分配置mode/version/profile/batch非法');
}

export const relationsPlugin: PluginDefinition = {
  manifest: { ...manifest('relations', ['tags', 'keywords', 'agent']), dataVersion: 2 },
  async load(context) {
    const tags = context.getDependency<TagsApi>('tags');
    const keywords = context.getDependency<KeywordsApi>('keywords');
    const agent = context.getDependency<AgentApi>('agent');
    let config = await context.store.read<RelationConfig>('config', { ...DEFAULT_RELATION_CONFIG }); validateConfig(config);
    let override: ScoringProvider | undefined;
    // 同标签所有scope串行，避免并发词对重复计费或覆盖同一正式文件。
    const pending = new Map<string, Promise<void>>();
    const descriptor = (): RelationProviderIdentity => override ? { id: override.id, version: override.version, kind: override.kind } : config.mode === 'agent' ? agentProviderIdentity(agent.describeProfile(config.agentProfile)) : { id: lexicalProvider.id, version: lexicalProvider.version, kind: lexicalProvider.kind };
    const loadRecord = async (tagId: string) => readRelationRecord(await context.store.read<unknown>(tagId, null), tagId);
    async function serial<T>(tagId: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      const previous = pending.get(tagId) ?? Promise.resolve();
      const result = previous.catch(() => {}).then(async () => { signal?.throwIfAborted(); return action(); });
      const tail = result.then(() => {}, () => {}); pending.set(tagId, tail);
      void tail.then(() => { if (pending.get(tagId) === tail) pending.delete(tagId); });
      if (!signal) return result;
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('ABORTED'));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }
    function report(tagId: string, tagRevision: number, inputHash: string, scope: RelationScope, requested?: string[]): ScoredRelations {
      const coverage = requested ? scope.coverage.filter(item => requested.includes(item.keyword)) : scope.coverage;
      const changed = coverage.some(item => item.tagInputHash ? item.tagInputHash !== inputHash : item.tagRevision !== tagRevision);
      return { tagId, tagRevision, provider: structuredClone(scope.provider), scoringLogicVersion: scope.scoringLogicVersion, scores: structuredClone(scope.scores.filter(item => !requested || requested.includes(item.keyword))), coverage: structuredClone(coverage), at: scope.at, warnings: changed ? ['标签定义已变化，已有词对按原评分版本复用；如需重新评分请显式升级scoringLogicVersion。'] : [] };
    }
    const api: RelationsApi = {
      getConfig() { return structuredClone(config); },
      async configure(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['mode', 'agentProfile', 'scoringLogicVersion', 'maxBatchSize'].includes(key))) throw new KnowledgeError('INVALID_RELATION_CONFIG', '只允许修改评分模式/profile/逻辑版本/批量大小');
        const next = { ...config, ...patch }; validateConfig(next);
        if (next.mode === 'agent') agent.describeProfile(next.agentProfile);
        await context.store.write('config', next); config = next;
        if (patch.mode !== undefined || patch.agentProfile !== undefined) override = undefined;
        return api.getConfig();
      },
      provider() { const value = descriptor(); return { ...value, scoringLogicVersion: config.scoringLogicVersion, cacheIdentity: scopeKey('', config.scoringLogicVersion, value) }; },
      setProvider(value) {
        if (!value || typeof value.id !== 'string' || !value.id.trim() || typeof value.version !== 'string' || !value.version.trim() || !['heuristic', 'model'].includes(value.kind) || typeof value.score !== 'function') throw new KnowledgeError('INVALID_PROVIDER', '实现需要id/version/kind/score');
        override = value;
      },
      async get(tagId) {
        const tag = await tags.get(tagId); const { record } = await loadRecord(tag.id);
        const key = scopeKey(tag.id, config.scoringLogicVersion, descriptor()); const scope = record.scopes.find(value => value.key === key);
        return scope ? report(tag.id, tag.revision, digest({ name: tag.name, ...tag.data }), scope) : undefined;
      },
      async plan(tagId, input) {
        const requested = words(input); const tag = await tags.get(tagId); const { record } = await loadRecord(tag.id); const identity = descriptor();
        const key = scopeKey(tag.id, config.scoringLogicVersion, identity); const covered = new Set(record.scopes.find(scope => scope.key === key)?.coverage.map(item => item.keyword) ?? []);
        const missing = requested.filter(word => !covered.has(word));
        return { missing, covered: requested.filter(word => covered.has(word)), estimatedCalls: identity.kind === 'model' ? Math.ceil(missing.length / config.maxBatchSize) : 0, scope: key };
      },
      async score(tagId, input, signal, options = {}) {
        if (options.maxRequests !== undefined && (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 0)) throw new KnowledgeError('INVALID_INPUT', 'maxRequests必须为非负整数');
        const requested = words(input); const initialTag = await tags.get(tagId); const identity = descriptor(); const logicVersion = config.scoringLogicVersion;
        const key = scopeKey(initialTag.id, logicVersion, identity); const selectedOverride = override; const batchSize = config.maxBatchSize;
        const scorer = override ?? (config.mode === 'agent' ? createAgentScorer(agent, config.agentProfile, agent.describeProfile(config.agentProfile)) : lexicalProvider);
        const checkCurrent = () => {
          signal?.throwIfAborted();
          if (scopeKey(initialTag.id, config.scoringLogicVersion, descriptor()) !== key || selectedOverride !== override) throw new KnowledgeError('STALE_PROVIDER', 'STALE_PROVIDER: 评分逻辑或实现已变化，丢弃旧结果');
        };
        return serial(initialTag.id, signal, async () => {
          checkCurrent();
          const tag = await tags.get(initialTag.id); const tagInputHash = digest({ name: tag.name, ...tag.data });
          const { record, migrated } = await loadRecord(tag.id);
          const current = record.scopes.find(scope => scope.key === key);
          const scope: RelationScope = current ? structuredClone(current) : { key, scoringLogicVersion: logicVersion, provider: identity, scores: [], coverage: [], at: new Date().toISOString() };
          const covered = new Set(scope.coverage.map(item => item.keyword)); const missing = requested.filter(word => !covered.has(word));
          const additions: RelationScore[] = []; let calls = 0;
          const label = tag.data as unknown as TagDefinition;
          for (let offset = 0; offset < missing.length; offset += batchSize) {
            checkCurrent();
            if (identity.kind === 'model' && options.maxRequests !== undefined && calls >= options.maxRequests) throw new KnowledgeError('RELATION_MODEL_BUDGET', '本次评分调用预算已耗尽，未提交本批覆盖状态');
            const batch = missing.slice(offset, offset + batchSize); calls++;
            const scores = await scorer.score({ name: tag.name, aliases: label.aliases, description: label.description }, batch, signal);
            checkCurrent();
            if (!Array.isArray(scores) || scores.length !== batch.length || scores.some(score => !score || typeof score.keyword !== 'string' || !batch.includes(score.keyword) || !Number.isFinite(score.score) || score.score < 0 || score.score > 1 || typeof score.reason !== 'string' || !score.reason.trim()) || new Set(scores.map(score => score.keyword)).size !== batch.length) throw new KnowledgeError('INVALID_SCORE', '评分必须完整且唯一覆盖当前批次，分数为0..1有限值并带理由');
            additions.push(...scores);
          }
          checkCurrent();
          if (missing.length && (await tags.get(tag.id)).revision !== tag.revision) throw new KnowledgeError('STALE_INPUT', '标签定义在请求期间变化，未保存本批覆盖状态');
          const at = new Date().toISOString();
          for (const item of additions) {
            scope.coverage.push({ keyword: item.keyword, tagRevision: tag.revision, tagInputHash, at, ...(identity.profileId ? { profileId: identity.profileId, profileRevision: identity.profileRevision } : {}) });
            if (item.score > 0) scope.scores.push({ keyword: item.keyword, score: item.score, reason: item.reason });
          }
          if (missing.length || migrated) {
            scope.at = at;
            const next: RelationRecord = { ...record, scopes: [...record.scopes.filter(value => value.key !== key), scope] };
            checkCurrent(); await context.store.write(tag.id, next);
          }
          return { ...report(tag.id, tag.revision, tagInputHash, scope, requested), stats: { requested: requested.length, missing: missing.length, reused: requested.length - missing.length, requests: calls } };
        });
      },
    };
    context.registerCommand('relation get', async ({ input }) => api.get(required(input, 'id')));
    context.registerCommand('relation providers', async () => api.provider());
    context.registerCommand('relation get-config', async () => api.getConfig());
    context.registerCommand('relation configure', async ({ input }) => {
      if (Object.keys(input).some(key => !['mode', 'agentProfile', 'scoringLogicVersion', 'maxBatchSize', 'json', 'input', 'dataDir'].includes(key))) throw new KnowledgeError('INVALID_RELATION_CONFIG', '评分配置包含未知字段');
      const patch: Partial<Omit<RelationConfig, 'schemaVersion'>> = {};
      if (input.mode !== undefined) patch.mode = input.mode as RelationConfig['mode'];
      if (input.agentProfile !== undefined) patch.agentProfile = input.agentProfile === null ? undefined : input.agentProfile as string;
      if (input.scoringLogicVersion !== undefined) patch.scoringLogicVersion = input.scoringLogicVersion as string;
      if (input.maxBatchSize !== undefined) patch.maxBatchSize = number(input.maxBatchSize, 32);
      return api.configure(patch);
    });
    context.registerCommand('relation score', async ({ input }) => api.score(required(input, 'id'), input.keywords === undefined ? await keywords.vocabulary() : strings(input.keywords), undefined, input.maxCalls === undefined ? {} : { maxRequests: number(input.maxCalls, 0) }));
    return { api, async migrate() {
      // 全量验证后再迁移，未来版本绝不被旧代码降级覆盖。
      const records: { key: string; record: RelationRecord }[] = [];
      for (const key of await context.store.list()) if (TAG_ID.test(key)) { const value = await loadRecord(key); if (value.migrated) records.push({ key, record: value.record }); }
      for (const value of records) await context.store.write(value.key, value.record);
    } };
  },
};
export default relationsPlugin;
