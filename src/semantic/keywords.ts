import { normalize } from '../plugins/keywords/extract.js';
import { CANDIDATES_PER_FRAGMENT, KEYWORDS_PER_FRAGMENT, type KeywordEvidence } from './types.js';
import { cosine } from './vectors.js';
import { isBoilerplate, isStopWord, isUsefulTerm, isConceptAtom, isWeakAtom, isEnglishConcept, isNarrativeTitle, isVersionTerm } from './keyword-quality.js';
export { isBoilerplate, isUsefulTerm } from './keyword-quality.js';

// 无词性模型时只组合有稳定术语词尾的相邻中文词，避免任意 n-gram 残句。
const TERM_END = /(?:中心|周期|作用域|优先级|关键词|上下文|预制体|压缩|索引|缓存|队列|接口|协议|契约|架构|模块|组件|节点|纹理|模型|向量|图谱|检索|召回|匹配|分页|事务|快照|投影|引用|依赖|参数|字段|类型|实例|脚本|日志|会话|标签|资源|属性|映射|坐标|布局|尺寸|透明度|调色板|预乘|哈希|耗时|预算|成本|内存|性能|并发|互斥|重试|租约|权限|令牌|游标|序列化|订阅|监听|派发|分词|词频|停用词|归一化|元数据|中位数|正确率|完整性|一致性|原子性|可控性|注入|编排|压缩率|回退|量化|配方|脱敏|轮转|精简|校验|边界|字节|输入|输出|证据链)$/u;
const MAX_JOINED_CHARS = 10; // 正文组合保持短术语；显式关键词允许更完整的短语。
const DIVERSITY = 0.12; // 减少同义重复，同时保留不同概念。
const MIN_BODY_SCORE = 0.42; // 普通词需要最低语义相关度。
const SOURCE_BONUS = { explicit: 0.28, heading: 0.13, code: 0.09, body: 0 };
const NOUN_LEAD = new Set('输入 输出 调用 写入 读取 执行 存储 记录 版本 文件 文档 项目 任务 资源 固定 未知 原始 内部 单一 重复 动态 当前 默认 自动'.split(' ')); // 可作名词修饰语，不能单独入选。
export interface Candidate { value: string; count: number; start: number; end: number; source?: keyof typeof SOURCE_BONUS; priority?: number }

/** 候选保持原文连续切片，结构来源仅影响排序，不改写名称和偏移。 */
export function candidates(text: string): Candidate[] {
  const found = new Map<string, Candidate & { positions: Set<number> }>();
  const add = (start: number, end: number, source: keyof typeof SOURCE_BONUS) => {
    while (start < end && /[\s`*_]/u.test(text[start])) start++;
    while (end > start && /[\s`*。；;，,]/u.test(text[end - 1])) end--;
    const value = text.slice(start, end), key = normalize(value);
    if (!isUsefulTerm(value, source === 'explicit')) return;
    if (source !== 'explicit' && (isWeakAtom(value) || !isEnglishConcept(value))) return;
    const priority = SOURCE_BONUS[source]; const old = found.get(key);
    if (old) {
      old.positions.add(start); old.count = old.positions.size;
      if ((old.priority ?? 0) < priority) Object.assign(old, { start, end, value, source, priority });
    } else found.set(key, { value, count: 1, start, end, source, priority, positions: new Set([start]) });
  };
  let offset = 0, skipSection = false;
  for (const line of text.split(/(?<=\n)/u)) {
    const heading = /^\s*#{1,6}\s+(.+)/u.exec(line);
    if (heading) skipSection = isBoilerplate(line);
    if (skipSection || isBoilerplate(line) || /^\s*(?:[-*]\s*)?(?:Session|整理范围|整理日期|原拆分编号|状态)[：:]/iu.test(line)) { offset += line.length; continue; }
    const explicit = /^\s*(?:[-*]\s*)?(?:关键词|关键字|keywords)\s*[：:]\s*(.*)/iu.exec(line);
    if (explicit) {
      const start = line.indexOf(explicit[1], explicit.index);
      for (const term of explicit[1].matchAll(/[^、,，;；。\n]+/gu)) add(offset + start + term.index, offset + start + term.index + term[0].length, 'explicit');
    }
    const source = heading ? 'heading' : 'body';
    const body = explicit ? '' : line;
    // 标题可声明正文词表未见的新领域概念；仅接受无叙述词的短连接分句。
    if (heading) {
      const titleAt = line.indexOf(heading[1]);
      for (const phrase of heading[1].matchAll(/[^、，,：:与和及/&（）()！？?。\n]+/gu)) {
        const value = phrase[0].trim();
        const words = Array.from(new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(value)).filter(x => x.isWordLike);
        const boundaryPrefix = /^(?:前端|后端|前缀|后缀|前序|后序)/u.test(value);
        if (value.length > 14 || isNarrativeTitle(value) || words.some((x, index) => isStopWord(x.segment) && !(index === 0 && /^(?:无|非|未)$/u.test(x.segment)) && !(boundaryPrefix && x.index < 2))) continue;
        add(offset + titleAt + phrase.index, offset + titleAt + phrase.index + phrase[0].length, 'heading');
      }
    }
    for (const code of body.matchAll(/`([^`\n]+)`/gu)) add(offset + code.index + 1, offset + code.index + 1 + code[1].length, 'code');
    // 英文专名保留连续大写词首短语，命令/API 标识符保留自身边界。
    for (const phrase of body.matchAll(/\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3}\b/gu)) add(offset + phrase.index, offset + phrase.index + phrase[0].length, source);
    for (const token of body.matchAll(/[A-Za-z][A-Za-z\d]*(?:[_.-][A-Za-z\d]+)*|(?<![\w.])\d+(?:\.\d+){2,}(?:-[a-z][\w.-]*)?/gu)) {
      const before = body[token.index - 1] ?? '', after = body[token.index + token[0].length] ?? '';
      if(after==='.'&&/\d/u.test(body[token.index+token[0].length+1]??''))continue;
      if (/[/\\]/u.test(before + after) || /^[a-f\d]{4,}$/i.test(token[0])) continue;
      if (isVersionTerm(token[0]) && (/^[ \t]*[%％]/u.test(body.slice(token.index + token[0].length)) || /[\w.]/u.test(before) || /^\.\w/u.test(body.slice(token.index + token[0].length)))) continue;
      if (/\d$/u.test(token[0]) && /[位秒帧层次行个篇天轮期码项]/u.test(after)) continue;
      add(offset + token.index, offset + token.index + token[0].length, source);
    }
    const raw = Array.from(new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(body));
    const parts: typeof raw = [];
    // ICU 的连续单字术语（如纹理、预制体）先合并，避免只剩末尾残词。
    for (let i = 0; i < raw.length; i++) {
      const part = { ...raw[i] };
      if (/^\p{Script=Han}$/u.test(part.segment) && !isStopWord(part.segment)) {
        while (i + 1 < raw.length && /^\p{Script=Han}$/u.test(raw[i + 1].segment) && !isStopWord(raw[i + 1].segment) && raw[i + 1].index === part.index + part.segment.length && part.segment.length < 4) part.segment += raw[++i].segment;
      }
      parts.push(part);
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.isWordLike || !/^\p{Script=Han}{2,}$/u.test(part.segment) || !isConceptAtom(part.segment) || isStopWord(part.segment) && !NOUN_LEAD.has(part.segment)) continue;
      add(offset + part.index, offset + part.index + part.segment.length, source);
      let end = part.index + part.segment.length;
      for (let j = i + 1; j < Math.min(parts.length, i + 2); j++) {
        const next = parts[j];
        if (next.index !== end || !next.isWordLike || !/^\p{Script=Han}+$/u.test(next.segment) || !isConceptAtom(next.segment)) break;
        end += next.segment.length;
        const combined = body.slice(part.index, end);
        if (combined.length > MAX_JOINED_CHARS) break;
        // 后接未结束的中文词组时不截取前半段（固定输入截止点、固定压缩率）。
        const following = parts[j + 1];
        if (following && following.index === end && /^\p{Script=Han}+$/u.test(following.segment) && !isStopWord(following.segment)) continue;
        if (TERM_END.test(combined)) add(offset + part.index, offset + end, source);
      }
    }
    offset += line.length;
  }
  return [...found.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.count - a.count || b.value.length - a.value.length || a.start - b.start)
    .slice(0, CANDIDATES_PER_FRAGMENT).map(({ positions, ...item }) => item);
}

/** 结构证据保留重要术语，语义排序只在通过词形检查的候选中进行。 */
export function selectKeywords(items: Candidate[], vectors: number[][], document: number[]): KeywordEvidence[] {
  const remaining = items.map((item, index) => ({ ...item, index, score: cosine(vectors[index], document) })).filter(item => isUsefulTerm(item.value, item.source === 'explicit'));
  const chosen: typeof remaining = [];
  const rank = (item: typeof remaining[number]) => item.score + (item.priority ?? 0) + Math.min(0.06, Math.log2(item.count) * 0.02)
    - DIVERSITY * Math.max(0, ...chosen.map(other => cosine(vectors[item.index], vectors[other.index])));
  while (remaining.length && chosen.length < KEYWORDS_PER_FRAGMENT) {
    remaining.sort((a, b) => rank(b) - rank(a) || b.value.length - a.value.length || a.start - b.start);
    const next = remaining.shift()!;
    if (next.source !== 'explicit' && next.score < MIN_BODY_SCORE - (next.priority ?? 0) * 0.5) continue;
    const key = normalize(next.value);
    if (chosen.some(c => normalize(c.value).includes(key) || key.includes(normalize(c.value)))) continue;
    chosen.push(next);
  }
  return chosen.map(({ index, priority, ...item }) => item);
}
