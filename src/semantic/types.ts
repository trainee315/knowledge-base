import type { Fragment } from '../recall/types.js';

// 版本进入派生身份，算法变化可复用不变的编码输入。
export const KEYWORD_VERSION = 'semantic-keywords-4';
export const MATCH_VERSION = 'semantic-match-5';
export const MATCH_THRESHOLD = 0.68; // 仅语义证据的正式匹配门槛；明确词面证据独立判断。
export const KEYWORDS_PER_FRAGMENT = 12;
export const CANDIDATES_PER_FRAGMENT = 48;
export const ENCODE_BATCH = 16;
export const MATCH_BATCH = 128;
export const RECONCILE_MS = 30_000;
export const RETRY_MS = 60_000;
export interface KeywordEvidence { value: string; count: number; score: number; start: number; end: number; source?: 'explicit'|'heading'|'code'|'body' }
/** 区分正文命中与文档主题依据，偏移始终指向原件而非归一化文本。 */
export interface MatchEvidence { kind: 'body-term'|'alias'|'title'|'explicit'|'semantic'; term: string; scope: 'body'|'document'; start?: number; end?: number; similarity: number; ruleVersion: string; reason?: 'excluded-scope'|'meta-mention'|'weak-mention'|'description-conflict' }
export interface MatchResult { status: 'accepted'|'candidate'; score: number; evidence: MatchEvidence }
export interface SemanticFragment extends Fragment { keywords: KeywordEvidence[]; vectorKey: string; truncated: boolean }
export interface Encoder {
  identity: string;
  dimensions: number;
  encode(texts: string[], query: boolean): Promise<{ vectors: number[][]; truncated: boolean[] }>;
}
export interface Counters { encodedTexts: number; cacheHits: number; comparisons: number; publishedResources: number; publishedTags: number; derivedFragments: number }
export type Job = { kind: 'resource' | 'tag'; id: string; wanted: string; published: string; state: 'queued' | 'processing' | 'ready' | 'failed'; cursor: string; error: string; retryAt: number; done: number; total: number };
