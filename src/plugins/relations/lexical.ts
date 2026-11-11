import { normalize, tokenize } from '../keywords/extract.js';

export interface ScoreLabel { name: string; aliases: string[]; description: string }
export interface RelationScore { keyword: string; score: number; reason: string }
export interface ScoringProvider {
  id: string;
  version: string;
  kind: 'heuristic' | 'model';
  score(label: ScoreLabel, keywords: string[], signal?: AbortSignal): Promise<RelationScore[]>;
}

/** 字符片段补充中文词界与英文词形差异；分数仅用于候选发现。 */
function fragments(value: string): Set<string> {
  const chars = Array.from(normalize(value).replace(/\s+/gu, ''));
  return new Set(chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char));
}

function similarity(keyword: string, label: ScoreLabel): RelationScore {
  const normalized = normalize(keyword);
  const names = [label.name, ...label.aliases].map(normalize);
  if (names.includes(normalized)) return { keyword, score: 1, reason: '名称或别名精确匹配' };
  const allText = normalize([...names, label.description].join(' '));
  if (allText.includes(normalized)) return { keyword, score: 0.85, reason: '名称、别名或说明包含关键词' };
  const words = new Set(tokenize(allText));
  if (tokenize(normalized).some(word => words.has(word))) return { keyword, score: 0.7, reason: '文本分词重合' };
  const left = fragments(normalized);
  const right = fragments(allText);
  const overlap = [...left].filter(value => right.has(value)).length;
  const score = left.size + right.size > 0 ? 2 * overlap / (left.size + right.size) : 0;
  return { keyword, score: Math.min(0.65, score), reason: overlap ? '字符二元片段相似度' : '无词或字符片段重合' };
}

export const lexicalProvider: ScoringProvider = {
  id: 'offline-lexical', version: '1', kind: 'heuristic',
  async score(label, keywords, signal) {
    signal?.throwIfAborted();
    return keywords.map(keyword => similarity(keyword, label));
  },
};
