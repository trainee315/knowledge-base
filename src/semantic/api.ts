import { randomUUID } from 'node:crypto';
import { CoreManager } from '../core/manager.js';
import { assert } from '../core/errors.js';
import { normalize } from '../plugins/keywords/extract.js';
import { SemanticStore } from './store.js';
import { activeTag, source, tagSignature, resourceSignature, requireSemanticPlugins } from './source.js';
import type { Job, SemanticFragment } from './types.js';
import { runSemantic, rebuildKeywords } from './engine.js';

const PAGE_LIMIT=100; // 所有筛选先于分页，避免只搜索当前页。
const NAME_LIMIT=100;
const DESCRIPTION_LIMIT=1000;
const ALIAS_LIMIT=20; // 限制单标签别名数量，避免无界扩张匹配范围。
function text(value:unknown,max:number,required=false):string {assert(typeof value==='string'&&value.length<=max&&(!required||!!value.trim()),'INVALID_ARGUMENT','名称或说明无效');return value.trim();}
function aliases(value:unknown,name:string):string[] {
  assert(Array.isArray(value)&&value.length<=ALIAS_LIMIT,'INVALID_ARGUMENT','别名必须为最多 20 项的数组');
  const result=value.map(item=>text(item,NAME_LIMIT,true)),keys=[name,...result].map(normalize);
  assert(new Set(keys).size===keys.length,'ALIAS_CONFLICT','名称或别名重复');return result;
}
/** 删除采用正式组织墓碑，保留历史引用，也阻止自动标签以同名重建。 */
export async function changeTag(dataDir:string,action:string,input:Record<string,unknown>) {
  const manager=await CoreManager.open(dataDir);
  try {
    await requireSemanticPlugins(manager);
    if(action==='create') {
      const name=text(input.name,NAME_LIMIT,true),description=text(input.description??'',DESCRIPTION_LIMIT),names=aliases(input.aliases??[],name);
      const all=await manager.listOrganizations('tag');const normalized=normalize(name);
      const same=all.find(t=>[t.name,...(Array.isArray(t.data.aliases)?t.data.aliases.map(String):[])].some(n=>normalize(n)===normalized));
      assert(!same||!!same.data.semanticDeletedAt,'ALIAS_CONFLICT','该标签名称或别名已经存在');
      const keys=[name,...names].map(normalize);
      assert(!all.some(t=>t.id!==same?.id&&[t.name,...(Array.isArray(t.data.aliases)?t.data.aliases.map(String):[])].some(n=>keys.includes(normalize(n)))),'ALIAS_CONFLICT','标签名称或别名重复');
      if(same){const {semanticDeletedAt,...data}=same.data;return await manager.updateOrganization(same.id,{name,data:{...data,aliases:names,description,semanticOrigin:'manual',semanticRematch:randomUUID()}},same.revision);}
      return await manager.createOrganization({type:'tag',pluginId:'tags',name,data:{aliases:names,description,semanticOrigin:'manual'}});
    }
    assert(typeof input.id==='string','INVALID_ARGUMENT','需要标签 ID');
    const tag=await manager.getOrganization(input.id);assert(activeTag(tag),'NOT_FOUND','标签不存在');
    if(action==='delete'){
      const deleted=await manager.updateOrganization(tag.id,{data:{...tag.data,semanticDeletedAt:new Date().toISOString()}},tag.revision);
      const store=await SemanticStore.open(dataDir);try{store.transaction(()=>store.removeTag(tag.id));}finally{store.close();}
      return deleted;
    }
    if(action==='update') {
      const name=text(input.name??tag.name,NAME_LIMIT,true),description=text(input.description??tag.data.description??'',DESCRIPTION_LIMIT),names=aliases(input.aliases??tag.data.aliases??[],name),keys=[name,...names].map(normalize);
      const all=await manager.listOrganizations('tag');assert(!all.some(t=>t.id!==tag.id&&[t.name,...(Array.isArray(t.data.aliases)?t.data.aliases.map(String):[])].some(n=>keys.includes(normalize(n)))),'ALIAS_CONFLICT','标签名称或别名重复');
      return await manager.updateOrganization(tag.id,{name,data:{...tag.data,aliases:names,description,semanticOrigin:'manual'}},tag.revision);
    }
    assert(action==='retry','INVALID_ARGUMENT','未知标签操作');
    return await manager.updateOrganization(tag.id,{data:{...tag.data,semanticRematch:randomUUID()}},tag.revision);
  }finally{await manager.close();}
}
/** 浏览只暴露当前资源和标签版本，不将旧位置或已删除内容作为当前结果。 */
export async function semanticView(dataDir:string,input:{id?:string;view?:string;query?:string;keyword?:string;offset?:number;limit?:number}={}) {
  const offset=input.offset??0,limit=input.limit??30;
  assert(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=PAGE_LIMIT,'INVALID_ARGUMENT','分页参数无效');
  assert(!input.view||['documents','fragments','keywords','candidates'].includes(input.view),'INVALID_ARGUMENT','未知浏览类型');
  const current=await source(dataDir),store=await SemanticStore.open(dataDir,true);
  try {
    const identity=store.get<{value:string}>("SELECT value FROM settings WHERE key='model'")?.value??'pending-model';
    const jobs=store.jobs();const valid=new Map(current.resources.map(r=>[r.id,resourceSignature(r,identity)]));
    const fragments=store.all<{signature:string;payload:string}>('SELECT signature,payload FROM fragments').map(row=>({signature:row.signature,fragment:JSON.parse(row.payload) as SemanticFragment})).filter(row=>valid.get(row.fragment.resourceId)===row.signature).map(row=>row.fragment);
    const byId=new Map(fragments.map(f=>[f.id,f]));
    const hasEvidence=Number(store.get<{user_version:number}>('PRAGMA user_version')?.user_version)>=3;
    const evidenceRows=hasEvidence?store.all<{tag:string;fragment:string;status:string;score:number;payload:string}>('SELECT * FROM match_evidence').filter(m=>byId.has(m.fragment)):[];
    const evidence=new Map(evidenceRows.map(m=>[m.tag+':'+m.fragment,JSON.parse(m.payload)]));
    const matches=store.all<{tag:string;fragment:string;score:number}>('SELECT tag,fragment,score FROM matches').filter(m=>byId.has(m.fragment));
    const remaining=current.resources.filter(r=>!jobs.some(j=>j.kind==='resource'&&j.id===r.id&&j.state==='ready'&&j.published===valid.get(r.id))).length;
    const labels=current.tags.map(t=>{
      const signature=tagSignature(t,identity),job=jobs.find(j=>j.kind==='tag'&&j.id===t.id);
      const validLabel=store.get<{signature:string}>('SELECT signature FROM labels WHERE id=?',t.id)?.signature===signature;
      const hits=validLabel?matches.filter(m=>m.tag===t.id):[];
      const state=job?.wanted===signature?job.state:'queued';
      const candidates=validLabel?evidenceRows.filter(m=>m.tag===t.id&&m.status==='candidate'):[];
      return {id:t.id,name:t.name,aliases:Array.isArray(t.data.aliases)?t.data.aliases:[],description:String(t.data.description??''),origin:t.data.semanticOrigin??'manual',state,error:job?.wanted===signature?job.error:'',done:state==='ready'?fragments.length:job?.done??0,total:state==='ready'?fragments.length:job?.total??0,count:new Set(hits.map(m=>byId.get(m.fragment)!.resourceId)).size,fragments:hits.filter(m=>evidence.get(m.tag+':'+m.fragment)?.scope!=='document').length,candidates:candidates.length,partial:remaining>0||state!=='ready'};
    });
    const failed=jobs.filter(j=>j.state==='failed');
    const status={pendingResources:remaining,failed:failed.length,error:store.setting('semantic-reset')==='running'?'整理数据清理未完成，请按运行说明恢复清理。':failed[0]?.error??'',jobs:jobs.map(({kind,id,state,done,total,error})=>({kind,id,state,done,total,error}))};
    if(!input.id)return {items:labels.filter(t=>!input.query||normalize(t.name+' '+t.description).includes(normalize(input.query))).slice(offset,offset+limit),total:labels.filter(t=>!input.query||normalize(t.name+' '+t.description).includes(normalize(input.query))).length,offset,limit,status};
    const tag=labels.find(t=>t.id===input.id);assert(tag,'NOT_FOUND','标签不存在');
    const currentTag=current.tags.find(t=>t.id===tag.id)!;
    const validLabel=store.get<{signature:string}>('SELECT signature FROM labels WHERE id=?',tag.id)?.signature===tagSignature(currentTag,identity);
    const selectedMatches=input.view==='candidates'?evidenceRows.filter(m=>m.status==='candidate'):matches;
    let found=(validLabel?selectedMatches.filter(m=>m.tag===tag.id):[]).map(m=>({...byId.get(m.fragment)!,score:m.score,evidence:evidence.get(m.tag+':'+m.fragment)}));
    if(input.view==='fragments'||input.view==='keywords')found=found.filter(f=>f.evidence?.scope!=='document');
    if(input.query)found=found.filter(f=>normalize(f.title+' '+f.text).includes(normalize(input.query!)));
    if(input.keyword)found=found.filter(f=>f.keywords.some(k=>normalize(k.value)===normalize(input.keyword!)));
    found.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    let items:unknown[];
    if(input.view==='keywords') {
      const terms=new Map<string,{value:string;score:number;documents:Set<string>;fragments:Set<string>}>();
      const visible=new Map(found.map(f=>[f.id,f]));
      const indexed=Number(store.get<{user_version:number}>('PRAGMA user_version')?.user_version)>=2;
      const links=indexed?store.all<{fragment:string;value:string;score:number}>('SELECT k.fragment,k.value,k.score FROM keyword_links k JOIN matches m ON m.fragment=k.fragment WHERE m.tag=?',tag.id):found.flatMap(f=>f.keywords.map(k=>({fragment:f.id,value:k.value,score:k.score})));
      for(const k of links){const f=visible.get(k.fragment);if(!f)continue;const key=normalize(k.value),term=terms.get(key)??{value:k.value,score:0,documents:new Set<string>(),fragments:new Set<string>()};term.score=Math.max(term.score,f.score*k.score);term.documents.add(f.resourceId);term.fragments.add(f.id);terms.set(key,term);}
      items=[...terms.values()].map(t=>({...t,documents:t.documents.size,fragments:t.fragments.size})).sort((a,b)=>b.score-a.score||a.value.localeCompare(b.value));
    } else if(input.view==='fragments'||input.view==='candidates')items=found;
    else {
      const docs=new Map<string,{resourceId:string;title:string;contentVersion:number;score:number;fragments:number;preview:typeof found[number]}>();
      for(const f of found){const item=docs.get(f.resourceId),body=f.evidence?.scope!=='document';if(item){if(body)item.fragments++;if(body&&item.preview.evidence?.scope==='document')item.preview=f;}else docs.set(f.resourceId,{resourceId:f.resourceId,title:f.title,contentVersion:f.contentVersion,score:f.score,fragments:body?1:0,preview:f});}
      items=[...docs.values()];
    }
    return {tag,items:items.slice(offset,offset+limit),total:items.length,offset,limit,status};
  }finally{store.close();}
}
export async function semanticCommand(dataDir:string,action:string,input:Record<string,unknown>) {
  if(action==='rebuild')return rebuildKeywords(dataDir);
  if(action==='run')return runSemantic(dataDir,{maxJobs:4});
  if(action==='retry-all'){const store=await SemanticStore.open(dataDir);try{store.run("UPDATE jobs SET state='queued',retryAt=0,error='' WHERE state='failed'");return {queued:true};}finally{store.close();}}
  if(action==='list'||action==='get')return semanticView(dataDir,{id:typeof input.id==='string'?input.id:undefined,view:input.view as string,query:input.query as string,keyword:input.keyword as string,offset:input.offset===undefined?undefined:Number(input.offset),limit:input.limit===undefined?undefined:Number(input.limit)});
  return changeTag(dataDir,action,input);
}
