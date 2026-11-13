import { normalize } from '../plugins/keywords/extract.js';
import { isUsefulTerm } from './keywords.js';
import { matchingBody, termPosition } from './matching.js';
import type { SemanticFragment } from './types.js';

const MAX_AUTOMATIC_CONCEPTS=40; // 全库排序后取稳定概念集合，避免每轮晋升造成无限增长。
const MIN_SHARED_DOCUMENTS=2; // 普通关键词须有跨文档支持，明确标题主题可单篇成立。
const MAX_CONCEPT_CHARS=24; // 标签保留紧凑概念，长句不晋升。
const GENERIC_CONCEPT=/^(?:md|json|readme|artifacts|main|用户|项目|文件|文档|内容|数据|记录|状态|版本|代码|执行|实现|验证|测试|结果|流程|问题|方案|建议|提交|工具|接口|资源|模块|配置|操作|支持|当前|实际|管理|使用|更新|检查|说明|关键词|标签|方法|函数|调用|处理|读取|新增|删除|优化|原文|历史|目录|片元|行为|时间|数量|边界|任务|命令|来源|原子|拆分|修改|独立|能力|完整|自动|性能|需求|回归|阶段|范围|模型|计划|工作|完成|同步|后台|保存|启动|输出|输入|默认|权限|进程|服务|结构|控制|错误|比较|分类|选择|切换|页面|字段|返回|组件|节点|成本|语义|匹配|浏览|整理|清理|local|text|true|false|null|undefined|void)$/iu;

interface Concept {
  name:string;
  documents:Set<string>;
  titles:Set<string>;
  explicit:Set<string>;
  authored:Set<string>;
}
export interface AutomaticConcept {name:string;documents:number;titleDocuments:number;explicitDocuments:number}

/** 关键词与正文显式主题共同投票；不通过高向量相似度把不同概念强行合并。 */
export function automaticConcepts(fragments:SemanticFragment[]):AutomaticConcept[] {
  const terms=new Map<string,Concept>();
  const add=(name:string,f:SemanticFragment,source:'keyword'|'authored'|'explicit')=>{
    name=name.replace(/^[`*\s]+|[`*\s。；;]+$/gu,'');
    const key=normalize(name);
    if(!isUsefulTerm(name)||GENERIC_CONCEPT.test(key)||/^\d/u.test(key)||/^v\d+(?:\.\d+){1,}/iu.test(key)||name.length>MAX_CONCEPT_CHARS)return;
    const item=terms.get(key)??{name,documents:new Set<string>(),titles:new Set<string>(),explicit:new Set<string>(),authored:new Set<string>()};
    item.documents.add(f.resourceId);
    const title=f.title+'\n'+(f.headings[0]??''),position=termPosition(title,name,true);
    if(position){item.titles.add(f.resourceId);if(/^[a-z][a-z ]+$/u.test(item.name))item.name=title.slice(position.start,position.end);}
    if(source==='explicit')item.explicit.add(f.resourceId);
    if(source==='authored')item.authored.add(f.resourceId);
    terms.set(key,item);
  };
  for(const f of fragments) {
    if(!matchingBody(f).trim()&&f.ordinal!==0)continue;
    for(const word of f.keywords)add(word.value,f,word.source==='explicit'?'explicit':'keyword');
    for(const line of f.text.matchAll(/^(标签|关键词)\s*[:：]\s*(.+)$/gmu)) {
      for(const name of line[2].split(/[、,，;；]/u))add(name,f,line[1]==='标签'?'authored':'explicit');
    }
  }
  const eligible=[...terms.values()].filter(t=> {
    // 两字普通片段不能靠出现次数成为主题；显式作者标注仍可证明短术语的价值。
    if(/^\p{Script=Han}{1,2}$/u.test(t.name)&&t.authored.size<MIN_SHARED_DOCUMENTS&&!(t.explicit.size>=MIN_SHARED_DOCUMENTS&&t.titles.size>=MIN_SHARED_DOCUMENTS))return false;
    // 不晋升英文叙述词和复合标识符碎片，保留有显式证据的术语及完整技术名称。
    if(/^[a-z]+$/u.test(t.name)&&!t.authored.size&&!t.explicit.size)return false;
    return t.authored.size>=MIN_SHARED_DOCUMENTS ||
      (t.documents.size>=MIN_SHARED_DOCUMENTS&&t.titles.size>0) ||
      (t.explicit.size>0&&t.titles.size>0&&t.name.length>=3);
  });
  // 明确的完整主题优先于高频单词，使单篇专门文档不会被通用词挤出。
  const tier=(t:Concept)=>t.authored.size>=MIN_SHARED_DOCUMENTS?3:t.explicit.size>0&&t.titles.size>0?2:1;
  eligible.sort((a,b)=>tier(b)-tier(a)||(b.authored.size*5+b.titles.size*4+b.explicit.size*2+Math.min(b.documents.size,8))-(a.authored.size*5+a.titles.size*4+a.explicit.size*2+Math.min(a.documents.size,8))||a.name.localeCompare(b.name));
  const chosen:Concept[]=[];
  for(const term of eligible) {
    // 支持文档完全相同且一词只是另一词的截短时，保留更完整表达。
    if(eligible.some(other=>other!==term&&normalize(other.name).includes(normalize(term.name))&&other.name.length>term.name.length&&other.documents.size===term.documents.size&&[...term.documents].every(id=>other.documents.has(id))))continue;
    chosen.push(term);if(chosen.length>=MAX_AUTOMATIC_CONCEPTS)break;
  }
  return chosen.map(t=>({name:t.name,documents:t.documents.size,titleDocuments:t.titles.size,explicitDocuments:t.explicit.size+t.authored.size}));
}
