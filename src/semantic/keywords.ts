import { normalize } from '../plugins/keywords/extract.js';
import { CANDIDATES_PER_FRAGMENT, KEYWORDS_PER_FRAGMENT, type KeywordEvidence } from './types.js';
import { cosine } from './vectors.js';

const STOP=new Set('的 了 和 是 在 与 及 一个 我们 可以 进行 使用 这个 那个 通过 需要 已经 然后 因为 所以 如果 但是 对于 关于 以及 降低 改善 能够 选择 合适 制作 用于 注意 保持 提高 减少 增加 实现 支持 采用 包括 具有 分别 the and for with from this that are was you your to of is a an'.split(' '));
const MAX_PHRASE_CHARS=30; // 保留实体名与术语短语，限制无标点长句被当作关键词。
const DIVERSITY=0.2; // 去除重复表达，同时保留少量不同主题的代表词。
interface Candidate {value:string;count:number;start:number;end:number}
/** 候选始终是原文连续切片，偏移可直接核对，不生成原文外的词语。 */
export function candidates(text:string):Candidate[] {
  const raw=Array.from(new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(text));
  // ICU 会把部分术语拆成单汉字；先合并连续单字，禁止从词的中间开始拼短语。
  const parts:typeof raw=[];
  for(const part of raw){const last=parts.at(-1);if(last&&/^\p{Script=Han}$/u.test(part.segment)&&!STOP.has(part.segment)&&/^\p{Script=Han}+$/u.test(last.segment)&&last.segment.length<2&&!STOP.has(last.segment)&&last.index+last.segment.length===part.index)last.segment+=part.segment;else parts.push({...part});}
  const found=new Map<string,Candidate>();
  for(let i=0;i<parts.length;i++) {
    if(!parts[i].isWordLike || STOP.has(normalize(parts[i].segment)))continue;
    let words=0;
    for(let j=i;j<parts.length&&j<i+5;j++) {
      const part=parts[j];
      if(!part.isWordLike && !/^[ \t]+$/u.test(part.segment))break;
      if(part.isWordLike) {if(STOP.has(normalize(part.segment)))break;words++;} else continue;
      const start=parts[i].index,end=part.index+part.segment.length,value=text.slice(start,end),key=normalize(value);
      if(words>3||value.length>MAX_PHRASE_CHARS)break;
      if(value.length<2||!/[\p{L}]/u.test(value))continue;
      const old=found.get(key); if(old)old.count++;else found.set(key,{value,count:1,start,end});
    }
  }
  return [...found.values()].sort((a,b)=>b.count-a.count || Number(/\s/u.test(b.value))-Number(/\s/u.test(a.value)) || a.start-b.start || b.value.length-a.value.length).slice(0,CANDIDATES_PER_FRAGMENT);
}
export function selectKeywords(items:Candidate[],vectors:number[][],document:number[]):KeywordEvidence[] {
  const remaining=items.map((item,i)=>({...item,index:i,score:cosine(vectors[i],document)}));const chosen:typeof remaining=[];
  while(remaining.length&&chosen.length<KEYWORDS_PER_FRAGMENT) {
    remaining.sort((a,b)=>(b.score-DIVERSITY*Math.max(0,...chosen.map(c=>cosine(vectors[b.index],vectors[c.index]))))-(a.score-DIVERSITY*Math.max(0,...chosen.map(c=>cosine(vectors[a.index],vectors[c.index]))))||a.start-b.start);
    const next=remaining.shift()!;
    if(next.score<Math.max(0.4,Math.max(...items.map((_,i)=>cosine(vectors[i],document)))-0.16))continue;
    if(chosen.some(c=>normalize(c.value).includes(normalize(next.value))))continue;
    chosen.push(next);
  }
  return chosen.map(({index,...item})=>item);
}
