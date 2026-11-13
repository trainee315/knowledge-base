import { normalize } from '../plugins/keywords/extract.js';
import { MATCH_THRESHOLD, MATCH_VERSION, type MatchResult, type SemanticFragment } from './types.js';
import type { Organization } from '../contracts/index.js';

const CANDIDATE_THRESHOLD = 0.42; // 低置信度结果可复查，但不计入正式归属。
const CONTEXT_SIMILARITY = 0.45; // 长说明与正文的语义支持可解除词面消歧限制。
const MIN_CONTEXT_ANCHORS = 3; // 简短说明不因分词稀疏而误判为冲突。
const MAX_TERM_OCCURRENCES = 64; // 防止重复标识符片元无限放大检查成本。
const CONTEXT_WINDOW = 240; // 句内枚举可能较长，仅检查有限上下文。
const IDENTIFIER_BOUNDARY='[a-z0-9_./\\\\-]'; // 正文不能把路径、扩展名或复合进程名的一部分当成独立术语。
const BOILERPLATE_HEADING = /^(?:来源(?:与追溯)?|追溯|参考资料|来源记录|提交与合回状态|提交记录|验收与提交|发布记录)$/u;
const METADATA_LINE = /^(?:标签|关键词|整理范围|整理日期|原拆分编号|状态|Session|来源)\s*[:：]/iu;
const TEMPLATE_LINE = /^(?:本文是会话事务的整理|后续采用时应核对实际版本|新增的通用执行建议|状态以所列证据时点为准)/u;

export function tagTerms(tag: Pick<Organization,'name'|'data'>): string[] {
  const aliases = Array.isArray(tag.data.aliases) ? tag.data.aliases.filter((x): x is string => typeof x === 'string') : [];
  return [...new Map([tag.name,...aliases].map(x => [normalize(x),x.trim()])).values()].filter(Boolean);
}

/** 查询名称和别名分别编码，说明补充各自的语义，不将多个名字拼成一句话。 */
export function tagQueries(tag: Pick<Organization,'name'|'data'>): string[] {
  return tagTerms(tag).map(term => [term,String(tag.data.description??'').trim()].filter(Boolean).join('\n'));
}

/** 保留被屏蔽行的宽度，使正文命中位置仍可直接映射到原文。 */
export function matchingBody(fragment: Pick<SemanticFragment,'text'|'headings'>): string {
  if (fragment.headings.some(h => h && BOILERPLATE_HEADING.test(h.trim()))) return ' '.repeat(fragment.text.length);
  let fenced=false;
  return fragment.text.split(/(?<=\n)/u).map(line => {
    const trimmed=line.trim();
    if (/^```/u.test(trimmed)) { fenced=!fenced; return ' '.repeat(line.length); }
    if (!fenced && (/^#{1,6}\s/u.test(trimmed) || METADATA_LINE.test(trimmed) || TEMPLATE_LINE.test(trimmed) || /^[-*]\s*Session\s*[:：]/iu.test(trimmed))) return ' '.repeat(line.length);
    return line;
  }).join('');
}

/** 兼容大小写与全半角，同时维护归一化字符到原文的偏移映射。 */
export function termPosition(text: string, term: string, compoundTitle=false): {start:number;end:number}|undefined {
  let value=''; const starts:number[]=[],ends:number[]=[]; let offset=0;
  for (const point of text) {
    const folded=point.normalize('NFKC').toLowerCase();
    value+=folded; for(let i=0;i<folded.length;i++){starts.push(offset);ends.push(offset+point.length);} offset+=point.length;
  }
  const needle=term.normalize('NFKC').trim().toLowerCase(); if(!needle)return;
  const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/gu,'\\s+');
  const boundary=compoundTitle?'[a-z0-9_]':IDENTIFIER_BOUNDARY;
  const left=/^[a-z0-9_]/iu.test(needle)?`(?<!${boundary})`:'';
  const right=/[a-z0-9_]$/iu.test(needle)?`(?!${boundary})`:'';
  const found=new RegExp(left+escaped+right,'u').exec(value);
  if(found)return {start:starts[found.index],end:ends[found.index+found[0].length-1]};
}

function contextCompatible(tag: Pick<Organization,'name'|'data'>, fragment: SemanticFragment, similarity:number): boolean {
  const description=String(tag.data.description??'').trim();
  if(!description || similarity>=CONTEXT_SIMILARITY)return true;
  const names=tagTerms(tag).map(normalize);
  const anchors=Array.from(new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(description))
    .filter(p=>p.isWordLike&&p.segment.length>=2&&!names.includes(normalize(p.segment)))
    .map(p=>p.segment).filter(p=>!/^(?:相关|用于|关于|方面|概念|内容|以及|包括|使用|表示|通过|进行)$/u.test(p));
  // 简短说明只作补充；明确的长说明才用于低相似度同名词消歧。
  return anchors.length<MIN_CONTEXT_ANCHORS || anchors.some(anchor=>termPosition(fragment.title,anchor,true)||termPosition(matchingBody(fragment),anchor));
}

/** 区分实际主题、明确排除项和对词条本身的讨论；不把标签枚举当作业务知识。 */
function mentionReason(text:string,position:{start:number;end:number},topical:boolean):MatchResult['evidence']['reason']|undefined {
  const left=text.slice(0,position.start),right=text.slice(position.end);
  const boundary=Math.max(left.lastIndexOf('。'),left.lastIndexOf('；'),left.lastIndexOf(';'),left.lastIndexOf('\n'));
  const prefix=left.slice(Math.max(boundary+1,left.length-CONTEXT_WINDOW));
  const suffix=right.split(/[。；;\n]/u,1)[0].slice(0,CONTEXT_WINDOW);
  const clause=prefix+text.slice(position.start,position.end)+suffix;
  // 逗号与顿号可以连接同一排除清单；转折或后续实施会终止该范围。
  const exclusion=/(?:尚未|没有|并未|未|不|无需|禁止)(?:执行|运行|调用|使用|接入|启动|做|涉及|包含|实施|允许)|(?:不在|不属于).{0,12}(?:范围|目标)|(?:只是提及|顺带提及|仅作背景|不讨论|不涉及|无关主题)/gu;
  const negatives=[...prefix.matchAll(exclusion)];
  const last=negatives.at(-1);
  if(last&&!/(?:但是|但随后|随后|之后|改为|实际执行|已经|已完成)/u.test(prefix.slice(last.index!+last[0].length)))return 'excluded-scope';
  if(/^(?:[”」"'`）)]\s*)?(?:不在|不属于).{0,12}(?:范围|目标)/u.test(suffix))return 'excluded-scope';
  if(topical)return;
  const adjacent=prefix.slice(-32)+text.slice(position.start,position.end)+suffix.slice(0,40);
  if(/(?:回执|响应|输出|返回).{0,40}(?:示例|样例|例如)\s*[:：]/u.test(prefix))return 'meta-mention';
  if(/^(?:正文|文章|文档).{0,16}(?:正常)?(?:渲染|显示|展示)/u.test(suffix)&&/(?:验证|页面|浏览器|Chrome|渲染|bodyLength)/iu.test(clause))return 'meta-mention';
  if(/(?:同一|相同|固定)\s*$/u.test(prefix)&&/^(?:与|和|\/).{0,24}(?:已核验|一致|相同)/u.test(suffix))return 'weak-mention';
  if(/别名.{0,24}(?:展示|用于|作为)/u.test(prefix)&&/^.{0,10}(?:定位|标识|识别)/u.test(suffix))return 'weak-mention';
  if(/(?:连接(?:失败|不可用|中断)|工具不可用)/u.test(clause)&&/(?:回退|改用|转为)/u.test(clause))return 'weak-mention';
  if(/(?:标签|关键词|词条)(?:名称|列表|集合)?\s*[（(:：]/u.test(prefix)||/^[”」"'`]?(?:等|这些)?\s*(?:标签|关键词|词条|词组)/u.test(suffix))return 'meta-mention';
  if(/(?:新增|创建|删除|选择|指定|限定|添加).{0,20}(?:标签|关键词)/u.test(clause)&&/[「」“”()（）]/u.test(adjacent))return 'meta-mention';
  if(/^[”」"'`]?\s*\d+\s*篇/u.test(suffix))return 'meta-mention';
  if(/(?:验收|核验|验证|查询|检索).{0,48}(?:\d+\s*篇|可定位)|(?:\d+\s*篇).{0,80}(?:标签|词组|可定位)/u.test(clause))return 'meta-mention';
  if(/(?:词组|关键词|词条).{0,16}(?:查询|检索)|(?:查询|检索).{0,16}(?:均命中|为空|条目|唯一词)/u.test(clause))return 'meta-mention';
  if(/(?:测试夹具|合成资料|合成样本|模型样例|模型样本|测试样例|测试样本)|(?:匹配到|未达阈值).{0,24}(?:文章|片元)|(?:文章|片元).{0,24}(?:分数|阈值)/u.test(clause))return 'meta-mention';
}

/** 同一规则同时用于新增标签和文档更新；标题归属不会扩散到所有片元。 */
export function matchFragment(tag: Pick<Organization,'name'|'data'>, fragment: SemanticFragment, similarity:number): MatchResult|undefined {
  const terms=tagTerms(tag),body=matchingBody(fragment);
  const make=(kind:MatchResult['evidence']['kind'],term:string,scope:'body'|'document',position?:{start:number;end:number},status:'accepted'|'candidate'='accepted'):MatchResult=>({
    status,score:similarity,evidence:{kind,term,scope,...(position?{start:fragment.start+position.start,end:fragment.start+position.end}:{}),similarity,ruleVersion:MATCH_VERSION}
  });
  if(!body.trim() && fragment.ordinal!==0)return;
  const compatible=contextCompatible(tag,fragment,similarity);
  let weak:MatchResult|undefined;
  for(const [index,term] of terms.entries()) {
    const positions:{start:number;end:number}[]=[];let offset=0;
    for(let count=0;count<MAX_TERM_OCCURRENCES;count++) {
      const found=termPosition(body.slice(offset),term);if(!found)break;
      const position={start:offset+found.start,end:offset+found.end};positions.push(position);offset=position.end;
    }
    const topical=!!termPosition(fragment.title+'\n'+fragment.headings.filter(Boolean).join('\n'),term,true);
    for(const position of positions) {
      const reason=mentionReason(body,position,topical)??(!compatible?'description-conflict':/^\p{Script=Han}{1,2}$/u.test(term)&&!topical&&positions.length===1&&similarity<MATCH_THRESHOLD?'weak-mention':undefined);
      const result=make(index?'alias':'body-term',term,'body',position,reason?'candidate':'accepted');
      if(!reason)return result;
      result.evidence.reason=reason;weak??=result;
    }
  }
  if(fragment.ordinal===0) {
    for(const term of terms) {
      if(termPosition(fragment.title,term,true))return make('title',term,'document',undefined,compatible?'accepted':'candidate');
      const metadata=/^(?:标签|关键词)\s*[:：].*$/gmu;
      for(const line of fragment.text.matchAll(metadata)) {
        const position=termPosition(line[0],term);
        if(position)return make('explicit',term,'document',{start:line.index!+position.start,end:line.index!+position.end},compatible?'accepted':'candidate');
      }
    }
  }
  if(weak)return weak;
  if(!body.trim() || !compatible)return;
  if(similarity>=MATCH_THRESHOLD)return make('semantic',tag.name,'body');
  if(similarity>=CANDIDATE_THRESHOLD)return make('semantic',tag.name,'body',undefined,'candidate');
}
