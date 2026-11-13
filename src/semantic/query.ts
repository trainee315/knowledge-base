import { assert } from '../core/errors.js';
import { normalize } from '../plugins/keywords/extract.js';
import { strings } from '../plugins/shared.js';
import { SemanticStore } from './store.js';
import { source, semanticEnabled, resourceSignature, tagSignature } from './source.js';
import { keywordResourceIds } from './keyword-index.js';

const QUERY_BATCH=1000; // 与既有组合查询上限一致，最终交集完成后才分页。
/** 资源列表和 CLI 组合查询复用同一语义标签关系，旧库保留原查询行为。 */
export async function semanticResourceQuery(dataDir:string,input:Record<string,unknown>,query:(input:Record<string,unknown>)=>Promise<any>) {
  const words=strings(input.keywords);
  if(words.length&&await semanticEnabled(dataDir)) {
    const matching=await keywordResourceIds(dataDir,words),items:any[]=[];
    let base=0;
    for(;;){const page=await semanticResourceQuery(dataDir,{...input,keywords:[],offset:base,limit:QUERY_BATCH},query);
      for(const item of page.items)if(matching.has(item.resource.id))items.push({...item,matchReasons:[...(item.matchReasons??item.reasons??[]),'关键词: '+words.join(', ')]});
      base+=page.items.length;if(base>=page.total||!page.items.length)break;
    }
    const offset=Number(input.offset??0),limit=Number(input.limit??50);
    assert(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>=0&&limit<=QUERY_BATCH,'INVALID_ARGUMENT','分页参数无效');
    return {items:items.slice(offset,offset+limit),total:items.length,offset,limit};
  }
  const names=strings(input.tags);
  if(!names.length||!await semanticEnabled(dataDir))return query(input);
  const offset=Number(input.offset??0),limit=Number(input.limit??50);
  assert(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>=0&&limit<=QUERY_BATCH,'INVALID_ARGUMENT','分页参数无效');
  const current=await source(dataDir);const selected=names.map(name=>current.tags.find(t=>t.id===name||[t.name,...(Array.isArray(t.data.aliases)?t.data.aliases.map(String):[])].some(v=>normalize(v)===normalize(name))));
  const store=await SemanticStore.open(dataDir,true);const matched=new Map<string,Set<string>>();
  try {
    const model=store.get<{value:string}>("SELECT value FROM settings WHERE key='model'")?.value??'pending-model';
    const validResources=new Map(current.resources.map(r=>[r.id,resourceSignature(r,model)]));
    const validTags=new Set(selected.filter(t=>t&&store.get<{signature:string}>('SELECT signature FROM labels WHERE id=?',t.id)?.signature===tagSignature(t,model)).map(t=>t!.id));
    for(const row of store.all<{tag:string;resource:string;signature:string}>('SELECT m.tag,f.resource,f.signature FROM matches m JOIN fragments f ON f.id=m.fragment')) {
      if(!validTags.has(row.tag)||validResources.get(row.resource)!==row.signature)continue;
      const tags=matched.get(row.resource)??new Set<string>();tags.add(row.tag);matched.set(row.resource,tags);
    }
  } finally {store.close();}
  const items:any[]=[];let base=0;
  for(;;){const page=await query({...input,tags:[],offset:base,limit:QUERY_BATCH});
    for(const item of page.items){const ids=matched.get(item.resource.id);if(!ids?.size||input.tagMatch==='all'&&!selected.every(t=>t&&ids.has(t.id)))continue;const reason='标签: '+selected.filter(t=>t&&ids.has(t.id)).map(t=>t!.name).join(', ');items.push({...item,matchReasons:[...(item.matchReasons??item.reasons??[]),reason]});}
    base+=page.items.length;if(base>=page.total||!page.items.length)break;
  }
  return {items:items.slice(offset,offset+limit),total:items.length,offset,limit};
}
