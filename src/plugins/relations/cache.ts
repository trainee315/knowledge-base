import { createHash } from 'node:crypto';
import { KnowledgeError } from '../../core/errors.js';
import { normalize } from '../keywords/extract.js';
import type { RelationScore } from './lexical.js';

// 缓存结构独立于插件版本与显式评分逻辑版本；v2只保存正分数和已评分覆盖状态。
export const RELATION_SCHEMA_VERSION = 2;
export interface RelationProviderIdentity {
  id: string; version: string; kind: 'heuristic' | 'model';
  model?: string; configurationHash?: string; profileId?: string; profileRevision?: number;
  promptVersion?: string; outputSchemaVersion?: string;
}
export interface CoverageEntry { keyword: string; tagRevision: number; tagInputHash?: string; at: string; profileId?: string; profileRevision?: number }
export interface RelationScope {
  key: string; scoringLogicVersion: string; provider: RelationProviderIdentity;
  coverage: CoverageEntry[]; scores: RelationScore[]; at: string;
}
export interface RelationRecord { schemaVersion: 2; tagId: string; scopes: RelationScope[]; migrationWarnings?: string[] }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function scopeKey(tagId: string, scoringLogicVersion: string, provider: RelationProviderIdentity): string {
  return digest([tagId, scoringLogicVersion, provider.id, provider.version, provider.kind, provider.model ?? null, provider.configurationHash ?? null, provider.promptVersion ?? null, provider.outputSchemaVersion ?? null]);
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
function identity(value: unknown): value is RelationProviderIdentity {
  return object(value) && typeof value.id === 'string' && Boolean(value.id) && typeof value.version === 'string' && Boolean(value.version) && ['heuristic', 'model'].includes(String(value.kind));
}
function score(value: unknown): value is RelationScore {
  return object(value) && typeof value.keyword === 'string' && Boolean(normalize(value.keyword)) && typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 1 && typeof value.reason === 'string';
}

/** 旧评分的0值转换为coverage；无法证明相同规则的旧provider保留独立legacy scope。 */
export function readRelationRecord(raw: unknown, tagId: string): { record: RelationRecord; migrated: boolean } {
  if (raw === null || raw === undefined) return { record: { schemaVersion: 2, tagId, scopes: [] }, migrated: false };
  if (!object(raw)) throw new KnowledgeError('INVALID_RELATION_DATA', '评分记录必须为对象');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== RELATION_SCHEMA_VERSION) throw new KnowledgeError('UNSUPPORTED_RELATION_SCHEMA', '不支持此关系评分结构版本，禁止覆盖', { actual: raw.schemaVersion });
  if (raw.schemaVersion === 2) {
    if (raw.tagId !== tagId || !Array.isArray(raw.scopes)) throw new KnowledgeError('INVALID_RELATION_DATA', '关系记录身份或scope非法');
    const keys = new Set<string>();
    for (const scope of raw.scopes) {
      if (!object(scope) || typeof scope.scoringLogicVersion !== 'string' || !scope.scoringLogicVersion || !identity(scope.provider) || scope.key !== scopeKey(tagId, scope.scoringLogicVersion, scope.provider) || keys.has(String(scope.key)) || !Array.isArray(scope.coverage) || !Array.isArray(scope.scores) || typeof scope.at !== 'string') throw new KnowledgeError('INVALID_RELATION_DATA', '关系scope结构非法');
      keys.add(String(scope.key));
      const words = new Set<string>();
      for (const item of scope.coverage) {
        if (!object(item) || typeof item.keyword !== 'string' || !item.keyword || normalize(item.keyword) !== item.keyword || words.has(item.keyword) || !positive(item.tagRevision) || typeof item.at !== 'string' || item.tagInputHash !== undefined && typeof item.tagInputHash !== 'string') throw new KnowledgeError('INVALID_RELATION_DATA', '评分覆盖状态非法');
        words.add(item.keyword);
      }
      const scoredWords = new Set<string>();
      for (const item of scope.scores) {
        if (!score(item) || item.score <= 0 || !words.has(item.keyword) || scoredWords.has(item.keyword)) throw new KnowledgeError('INVALID_RELATION_DATA', '稀疏评分必须唯一、已覆盖且大于0');
        scoredWords.add(item.keyword);
      }
    }
    return { record: structuredClone(raw) as unknown as RelationRecord, migrated: false };
  }
  if (raw.tagId !== tagId || !positive(raw.tagRevision) || !identity(raw.provider) || !Array.isArray(raw.scores) || !raw.scores.every(score) || typeof raw.at !== 'string') throw new KnowledgeError('INVALID_RELATION_DATA', 'v0.0.1关系评分记录非法');
  const provider = { id: raw.provider.id, version: raw.provider.version, kind: raw.provider.kind };
  const logicVersion = provider.id === 'offline-lexical' && provider.version === '1' && provider.kind === 'heuristic' ? '1' : 'legacy-v0.0.1';
  const unique = new Map<string, RelationScore>(); const conflicts = new Set<string>();
  for (const item of raw.scores as RelationScore[]) {
    const keyword = normalize(item.keyword); const previous = unique.get(keyword);
    if (previous && previous.score !== item.score) conflicts.add(keyword);
    unique.set(keyword, { keyword, score: item.score, reason: item.reason });
  }
  for (const keyword of conflicts) unique.delete(keyword);
  const coverage = [...unique.keys()].map(keyword => ({ keyword, tagRevision: Number(raw.tagRevision), at: String(raw.at) }));
  const scope: RelationScope = { key: scopeKey(tagId, logicVersion, provider), scoringLogicVersion: logicVersion, provider, coverage, scores: [...unique.values()].filter(item => item.score > 0), at: raw.at };
  return { record: { schemaVersion: 2, tagId, scopes: [scope], ...(conflicts.size ? { migrationWarnings: ['旧评分归一化后存在冲突词对，未将冲突项标为已评分'] } : {}) }, migrated: true };
}
