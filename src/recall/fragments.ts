import MarkdownIt from 'markdown-it';
import type { SourceRecord, Fragment } from './types.js';
import { hash, normalize } from './scope.js';

export const SPLITTER_VERSION = 'markdown-block-1';
export const TOKENIZER_VERSION = 'nfkc-cjk-bigram-1';
const TARGET_CHARS = 900; // 相邻完整块聚合目标；不改变原文偏移。
const MAX_BLOCK_CHARS = 1400; // 超长块显式标为 continued，并提供邻接展开。
const parser = new MarkdownIt({ html: false });

/** 索引文本与原文分离；中文单字/二元词兼容短查询及工程标识。 */
export function terms(text: string): string[] {
  const normalized = normalize(text); const result: string[] = [];
  for (const part of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_./:-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(part)) { const chars = [...part]; result.push(...chars); for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]); }
    else result.push(part);
  }
  return result;
}
export function ftsQuery(text: string): string { return [...new Set(terms(text))].slice(0, 128).map(t => '"' + t.replaceAll('"', '""') + '"').join(' OR '); }

export function split(record: SourceRecord, options?: { targetChars: number; maxBlockChars: number }): Fragment[] {
  const targetChars = options?.targetChars ?? TARGET_CHARS, maxBlockChars = options?.maxBlockChars ?? MAX_BLOCK_CHARS;
  const text = record.text; if (!text.trim()) return [];
  const offsets = [0]; for (const m of text.matchAll(/\n/g)) offsets.push(m.index! + 1);
  const tokens = parser.parse(text, {}); const starts = new Set<number>([0]); const headingsAt = new Map<number, { level: number; text: string }>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.map && t.level === 0 && t.nesting !== -1) starts.add(offsets[t.map[0]] ?? text.length);
    if (t.type === 'heading_open' && t.map) headingsAt.set(offsets[t.map[0]] ?? 0, { level: Number(t.tag.slice(1)), text: tokens[i + 1]?.content ?? '' });
  }
  const points = [...starts].filter(x => x < text.length).sort((a, b) => a - b).concat(text.length);
  const chunks: { start: number; end: number; headings: string[]; continued: boolean }[] = []; let headings: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]; const end = points[i + 1]; const heading = headingsAt.get(start);
    if (heading) { headings = headings.slice(0, heading.level - 1); headings[heading.level - 1] = heading.text; }
    if (end - start > maxBlockChars) {
      for (let at = start; at < end;) { let next = Math.min(end, at + maxBlockChars); if (next < end && /[\uD800-\uDBFF]/.test(text[next - 1])) next--; chunks.push({ start: at, end: next, headings: [...headings], continued: true }); at = next; }
    } else {
      const previous = chunks.at(-1);
      if (!heading && previous && !previous.continued && end - previous.start <= targetChars && JSON.stringify(previous.headings) === JSON.stringify(headings)) previous.end = end;
      else chunks.push({ start, end, headings: [...headings], continued: false });
    }
  }
  const line = (offset: number) => { let low = 0, high = offsets.length; while (low < high) { const middle = (low + high) >>> 1; if (offsets[middle] <= offset) low = middle + 1; else high = middle; } return low; };
  const fragments = chunks.map((chunk, ordinal): Fragment => ({ ...record, ...chunk, ordinal, id: 'f-' + hash(JSON.stringify([record.resourceId, record.contentVersion, record.contentHash, SPLITTER_VERSION, targetChars, maxBlockChars, chunk.start, chunk.end])), startLine: line(chunk.start), endLine: line(Math.max(chunk.start, chunk.end - 1)), text: text.slice(chunk.start, chunk.end) }));
  for (let i = 0; i < fragments.length; i++) { fragments[i].previous = fragments[i - 1]?.id; fragments[i].next = fragments[i + 1]?.id; }
  return fragments;
}
