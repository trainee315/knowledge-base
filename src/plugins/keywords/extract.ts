// 限制高频常用词对候选召回的干扰，并约束单个资源的正式关键词规模。
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'you', 'your', '的', '了', '和', '是', '在', '与', '及', '一个', '我们', '可以', '进行', '使用']);
const MAX_KEYWORDS = 100;

export interface Keyword { value: string; count: number; weight: number }

export function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

/** 中文按词切分，英文保留单词；确定性排序便于同一输入去重。 */
export function tokenize(value: string): string[] {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  return Array.from(segmenter.segment(normalize(value)))
    .filter(segment => segment.isWordLike)
    .map(segment => segment.segment)
    .filter(word => !STOP_WORDS.has(word) && /[\p{L}\p{N}]/u.test(word));
}

export function extractKeywords(text: string, filename: string): Keyword[] {
  const counts = new Map<string, number>();
  for (const word of tokenize(`${filename.replace(/\.[^.]+$/u, '')} ${text}`)) counts.set(word, (counts.get(word) ?? 0) + 1);
  const highest = Math.max(1, ...counts.values());
  return Array.from(counts, ([value, count]) => ({ value, count, weight: count / highest }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'en'))
    .slice(0, MAX_KEYWORDS);
}
