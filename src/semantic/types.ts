import type { Fragment } from '../recall/types.js';

// 版本进入派生身份，算法变化可复用不变的编码输入。
export const KEYWORD_VERSION = 'semantic-keywords-1';
export const MATCH_VERSION = 'semantic-match-1';
export const MATCH_THRESHOLD = 0.55;
export const KEYWORDS_PER_FRAGMENT = 12;
export const CANDIDATES_PER_FRAGMENT = 48;
export const ENCODE_BATCH = 16;
export const MATCH_BATCH = 128;
export const RECONCILE_MS = 30_000;
export const RETRY_MS = 60_000;
export interface KeywordEvidence { value: string; count: number; score: number; start: number; end: number }
export interface SemanticFragment extends Fragment { keywords: KeywordEvidence[]; vectorKey: string; truncated: boolean }
export interface Encoder {
  identity: string;
  dimensions: number;
  encode(texts: string[], query: boolean): Promise<{ vectors: number[][]; truncated: boolean[] }>;
}
export interface Counters { encodedTexts: number; cacheHits: number; comparisons: number; publishedResources: number; publishedTags: number }
export type Job = { kind: 'resource' | 'tag'; id: string; wanted: string; published: string; state: 'queued' | 'processing' | 'ready' | 'failed'; cursor: string; error: string; retryAt: number; done: number; total: number };
