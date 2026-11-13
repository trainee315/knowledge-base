import { createHash } from 'node:crypto';
import { CoreManager } from '../core/manager.js';
import { assert } from '../core/errors.js';
import { normalize } from '../plugins/keywords/extract.js';
import type { ResourceMeta } from '../contracts/index.js';
import type { SemanticFragment } from './types.js';
import { SemanticStore } from './store.js';
import { resourceSignature } from './source.js';
import { KEYWORD_VERSION } from './types.js';

const PAGE_SIZE=30; // 文档和片元都在数据库分页后才读取 payload。
const MAX_PAGE=200; // 限制单次读取和批量词条参数数量。
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i; // 文档标识不接受路径。
export const keywordId=(value:string)=>'k-'+createHash('sha256').update(normalize(value)).digest('hex');
export type KeywordStatus={state:'ready'|'partial'|'pending'|'rebuilding'|'failed';pending:number;failed:number};
export interface KeywordPage {items:any[];total:number;offset:number;limit:number;generation:string;status:KeywordStatus;keyword?:{id:string;name:string};missing?:boolean}

/** 在调用者的 SQLite 发布事务内写入完整关键词关系，元数据摘要不参与截断。 */
export function publishKeywords(store:SemanticStore,r:ResourceMeta,signature:string,fragments:SemanticFragment[],text?:string) {
  store.removeKeywordResource(r.id);
  const summary=Array.from(text??'').slice(0,160).join('');
  const resource={id:r.id,originalName:r.originalName,extension:r.extension,mediaType:r.mediaType,size:r.size,contentVersion:r.contentVersion,updatedAt:r.updatedAt};
  const payload={resource,title:r.originalName.replace(/\.[^.]+$/,''),summary,parseStatus:text===undefined?'unsupported':'parsed',tags:[],paths:[]};
  store.run('INSERT INTO keyword_documents VALUES(?,?,?,?,?)',r.id,signature,r.contentVersion,JSON.stringify(payload),normalize(payload.title+' '+summary));
  for(const f of fragments)for(const k of f.keywords) {
    const key=normalize(k.value);if(!key)continue;
    const id=keywordId(key);
    store.run('INSERT OR IGNORE INTO keyword_terms VALUES(?,?,?)',id,key,k.value);
    store.run('INSERT OR REPLACE INTO keyword_links VALUES(?,?,?,?,?,?,?,?)',id,r.id,f.id,k.value,k.start,k.end,k.count,k.score);
  }
  store.bumpKeywordRevision();
}

/** 后台核对负责失效和补漏，查询只比较正式变更标记，不遍历文档。 */
export function reconcileKeywords(store:SemanticStore,current:{resources:ResourceMeta[];generation:string},model:string) {
  const valid=new Map(current.resources.map(r=>[r.id,resourceSignature(r,model)]));
  for(const row of store.all<{resource:string;signature:string}>('SELECT resource,signature FROM keyword_documents')) {
    if(valid.get(row.resource)!==row.signature)store.removeKeywordResource(row.resource);
  }
  for(const r of current.resources) {
    if(!store.get('SELECT resource FROM keyword_documents WHERE resource=?',r.id)) {
      store.run("UPDATE jobs SET state='queued',published='',retryAt=0 WHERE kind='resource' AND id=? AND state='ready'",r.id);
    }
  }
  store.setSetting('keyword-source-generation',current.generation);
}

/** 读取快照覆盖 generation 检查和 SQL 查询，防止读到跨文件发布的中间状态。 */
export async function readKeywordIndex<T>(dataDir:string,read:(store:SemanticStore,status:KeywordStatus,generation:string)=>T):Promise<T> {
  const manager=await CoreManager.open(dataDir,{readOnly:true});
  try {return await manager.storage.snapshot(async()=>{
    const state=await manager.pluginStore('core-host').read<{disabled?:string[];blockedPlugins?:string[];dataVersions?:Record<string,number>}>('state',{});
    assert(state.dataVersions?.keywords===undefined||state.dataVersions.keywords===1,'UNSUPPORTED_PLUGIN_SCHEMA','不支持未来关键词插件数据版本');
    assert(![...(state.disabled??[]),...(state.blockedPlugins??[])].includes('keywords'),'PLUGIN_UNAVAILABLE','关键词插件不可用');
    const sourceGeneration=await manager.storage.readJson<string>('state/keyword-generation.json','legacy');
    const store=await SemanticStore.open(dataDir,true);
    try {
      store.db.exec('BEGIN'); // 同一个 SQLite 读快照覆盖状态、计数及当前页。
      const schema=Number(store.get<{user_version:number}>('PRAGMA user_version')?.user_version);
      const compatible=(schema===2||schema===3)&&store.setting('keyword-algorithm')===KEYWORD_VERSION;
      if(schema===0)return read(store,{state:'pending',pending:0,failed:0},'0');
      const counts=store.get<{pending:number;failed:number}>("SELECT count(*) AS pending,coalesce(sum(state='failed'),0) AS failed FROM jobs WHERE kind='resource' AND state!='ready'")!;
      const status:KeywordStatus={state:!compatible||!store.setting('keyword-source-generation')?'pending':store.setting('keyword-rebuild')==='running'?'rebuilding':store.setting('keyword-source-generation')!==sourceGeneration?'pending':counts.failed?'failed':counts.pending?'partial':'ready',pending:counts.pending,failed:counts.failed};
      const generation=store.setting('keyword-revision')??'0';
      return read(store,status,generation);
    }finally{store.close();}
  });}finally{await manager.close();}
}

export async function keywordBrowse(dataDir:string,url:URL):Promise<KeywordPage> {
  const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??PAGE_SIZE);
  assert(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=MAX_PAGE,'INVALID_ARGUMENT','分页参数无效');
  const query=normalize(url.searchParams.get('q')??'');
  const kind=url.pathname.split('/').at(-1);
  assert(['collections','documents','fragments'].includes(kind??''),'NOT_FOUND','关键词接口不存在');
  return readKeywordIndex(dataDir,(store,status,generation)=>{
    const empty:KeywordPage={items:[],total:0,offset,limit,status,generation};
    if(['pending','rebuilding'].includes(status.state))return empty;
    const expected=url.searchParams.get('generation');
    assert(!expected||expected===generation,'KEYWORD_GENERATION_CHANGED','关键词索引已更新，请重新加载第一页');
    if(kind==='collections') {
      const args=[query,query];
      const total=store.get<{n:number}>('SELECT count(*) AS n FROM keyword_terms WHERE (?=\'\' OR instr(normalized,?)>0)',...args)!.n;
      const items=store.all('SELECT id,name FROM keyword_terms WHERE (?=\'\' OR instr(normalized,?)>0) ORDER BY normalized,id LIMIT ? OFFSET ?',...args,limit,offset);
      return {...empty,total,items};
    }
    const ids=[...new Set(url.searchParams.getAll('id'))];assert(ids.length>0&&ids.length<=MAX_PAGE,'INVALID_ARGUMENT','请选择关键词');
    const selected=ids.map(id=>store.get<{id:string;name:string}>('SELECT id,name FROM keyword_terms WHERE id=? OR normalized=?',id,normalize(id))).filter((x):x is {id:string;name:string}=>!!x);
    if(!selected.length)return {...empty,missing:true};
    const keys=selected.map(k=>k.id),slots=keys.map(()=>'?').join(',');
    const keyword=selected[0];
    if(kind==='documents') {
      const condition=`d.resource IN (SELECT resource FROM keyword_links WHERE keyword IN (${slots})) AND (?='' OR instr(d.searchText,?)>0)`;
      const args=[...keys,query,query];
      const total=store.get<{n:number}>(`SELECT count(*) AS n FROM keyword_documents d WHERE ${condition}`,...args)!.n;
      const rows=store.all<{payload:string}>(`SELECT d.payload FROM keyword_documents d WHERE ${condition} ORDER BY d.resource LIMIT ? OFFSET ?`,...args,limit,offset);
      return {...empty,keyword,total,items:rows.map(row=>({...JSON.parse(row.payload),matchReasons:['关键词：'+selected.map(k=>k.name).join('、')]}))};
    }
    assert(ids.length===1,'INVALID_ARGUMENT','片元查询只能选择一个关键词');
    const resource=url.searchParams.get('resourceId')??'';assert(UUID.test(resource),'INVALID_ARGUMENT','需要有效的文档 ID');
    const document=store.get<{version:number}>('SELECT version FROM keyword_documents WHERE resource=?',resource);
    const version=url.searchParams.get('version');assert(!version||Number(version)===document?.version,'KEYWORD_GENERATION_CHANGED','文档内容已更新，请重新选择文档');
    const total=store.get<{n:number}>('SELECT count(*) AS n FROM keyword_links WHERE keyword=? AND resource=?',keyword.id,resource)!.n;
    const rows=store.all<{payload:string;value:string;start:number;end:number;count:number;score:number}>(`SELECT f.payload,k.value,k.start,k.end,k.count,k.score FROM keyword_links k JOIN fragments f ON f.id=k.fragment WHERE k.keyword=? AND k.resource=? ORDER BY k.start,k.fragment LIMIT ? OFFSET ?`,keyword.id,resource,limit,offset);
    return {...empty,keyword,total,items:rows.map(row=>({...JSON.parse(row.payload),evidence:{value:row.value,start:row.start,end:row.end,count:row.count,score:row.score}}))};
  });
}

/** 组合查询沿用“任意关键词包含匹配”，按资源去重后交给其余条件取交集。 */
export async function keywordResourceIds(dataDir:string,words:string[]):Promise<Set<string>> {
  return readKeywordIndex(dataDir,(store,status)=>{
    assert(status.state==='ready','KEYWORD_INDEX_PENDING','关键词索引尚未就绪');
    const keys=words.map(normalize);const where=keys.map(()=> 'instr(t.normalized,?)>0').join(' OR ');
    return new Set(store.all<{resource:string}>(`SELECT DISTINCT k.resource FROM keyword_links k JOIN keyword_terms t ON t.id=k.keyword WHERE ${where}`,...keys).map(x=>x.resource));
  });
}
