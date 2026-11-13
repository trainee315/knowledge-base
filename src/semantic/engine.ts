import { realpath } from 'node:fs/promises';
import { readPluginMeta } from '../plugins/shared.js';
import { CoreManager } from '../core/manager.js';
import { exclusive } from '../recall/models.js';
import { split } from '../recall/fragments.js';
import { normalize } from '../plugins/keywords/extract.js';
import { SemanticStore } from './store.js';
import { source, sourceRecord, resourceSignature, tagSignature, tagText, activeTag, requireSemanticPlugins } from './source.js';
import { encode, localEncoder, vector, vectorKey, cosine } from './vectors.js';
import { candidates, selectKeywords } from './keywords.js';
import { publishKeywords, reconcileKeywords } from './keyword-index.js';
import { KEYWORD_VERSION, MATCH_THRESHOLD, MATCH_BATCH, RETRY_MS, type Encoder, type Counters, type SemanticFragment, type Job } from './types.js';
import type { Organization, ResourceMeta } from '../contracts/index.js';

const AUTO_TAG_LIMIT=4; // 每轮最多晋升四个跨文档代表词，防止标签数量暴涨。
const AUTO_EQUIVALENCE=0.93; // 仅对很相近的自动名称复用已有概念；人工定义不自动合并。
const stats=():Counters=>({encodedTexts:0,cacheHits:0,comparisons:0,publishedResources:0,publishedTags:0,derivedFragments:0});
const encodedText=(f:{title:string;headings:string[];text:string})=>[f.title,f.headings.join(' / '),f.text].join('\n');

/** 周期核对补漏；同实体只保留最新目标，已删除对象立即清除派生关系。 */
export async function reconcile(store:SemanticStore,dataDir:string,identity:string) {
  const current=await source(dataDir);
  store.transaction(()=>{
    for(const r of current.resources)store.enqueue('resource',r.id,resourceSignature(r,identity));
    for(const tag of current.tags)store.enqueue('tag',tag.id,tagSignature(tag,identity));
    for(const job of store.jobs()) {
      if(job.kind==='resource'&&!current.resources.some(r=>r.id===job.id))store.removeResource(job.id);
      if(job.kind==='tag'&&!current.tags.some(t=>t.id===job.id))store.removeTag(job.id);
    }
    reconcileKeywords(store,current,identity);
  });
  return current;
}
/** 模型运行期间不持有核心写锁；发布前在写会话内再次核对正式版本。 */
async function processResource(store:SemanticStore,dataDir:string,r:ResourceMeta,encoder:Encoder,counters:Counters,signal?:AbortSignal) {
  readPluginMeta(r,'keywords');
  const wanted=resourceSignature(r,encoder.identity);
  store.run("UPDATE jobs SET state='processing',error='' WHERE kind='resource' AND id=?",r.id);
  const record=await sourceRecord(dataDir,r);const fragments=record?split(record):[];
  store.run("UPDATE jobs SET total=?,done=0 WHERE kind='resource' AND id=?",fragments.length,r.id);
  const output:SemanticFragment[]=[];
  for(const f of fragments) {
    signal?.throwIfAborted();
    const text=encodedText(f),key=vectorKey(encoder.identity,text);
    const saved=store.get<{payload:string}>('SELECT payload FROM derivations WHERE key=?',KEYWORD_VERSION+':'+key);
    let keywords:SemanticFragment['keywords'];
    if(saved){keywords=JSON.parse(saved.payload);counters.cacheHits++;}
    else {
      const terms=candidates(f.text);
      const embeddings=await encode(store,dataDir,encoder,[text,...terms.map(t=>t.value)],false,counters,signal);
      keywords=selectKeywords(terms,embeddings.slice(1),embeddings[0]);
      counters.derivedFragments++;
      store.run('INSERT OR REPLACE INTO derivations VALUES(?,?)',KEYWORD_VERSION+':'+key,JSON.stringify(keywords));
    }
    const cached=store.get<{truncated:number}>('SELECT truncated FROM vectors WHERE key=?',key)!;
    output.push({...f,keywords:keywords.map(k=>({...k,start:k.start+f.start,end:k.end+f.start})),vectorKey:key,truncated:!!cached.truncated});
    store.run("UPDATE jobs SET done=done+1 WHERE kind='resource' AND id=?",r.id);
  }
  signal?.throwIfAborted();
  const manager=await CoreManager.open(dataDir);
  try {
    await requireSemanticPlugins(manager);
    const latest=await manager.getResource(r.id);
    readPluginMeta(latest,'keywords');
    if(latest.deletedAt||resourceSignature(latest,encoder.identity)!==wanted)return;
    const tags=(await manager.listOrganizations('tag')).filter(activeTag);
    const labels=store.all<{id:string;signature:string;vectorKey:string}>('SELECT * FROM labels').filter(label=>tags.some(t=>t.id===label.id&&tagSignature(t,encoder.identity)===label.signature));
    // 相同编码内容的旧命中可以换用新原文位置，避免重新计算所有相似度。
    const previous=store.all<{tag:string;vectorKey:string;score:number}>('SELECT m.tag,f.vectorKey,m.score FROM matches m JOIN fragments f ON f.id=m.fragment WHERE f.resource=?',r.id);
    const completedLabels=new Set(store.jobs().filter(j=>j.kind==='tag'&&j.published===j.wanted&&j.state==='ready').map(j=>j.id));
    const oldKeys=new Set(store.all<{vectorKey:string}>('SELECT vectorKey FROM fragments WHERE resource=?',r.id).map(x=>x.vectorKey));
    const matches:{tag:string;fragment:string;score:number}[]=[];
    for(const f of output)for(const tag of labels) {
      const reusable=oldKeys.has(f.vectorKey)&&completedLabels.has(tag.id);
      const score=reusable?(previous.find(p=>p.tag===tag.id&&p.vectorKey===f.vectorKey)?.score??0):cosine(vector(store,f.vectorKey),vector(store,tag.vectorKey));
      if(!reusable)counters.comparisons++;
      if(score>=MATCH_THRESHOLD)matches.push({tag:tag.id,fragment:f.id,score});
    }
    const all=new Map<string,{value:string;count:number;weight:number}>();
    for(const f of output)for(const k of f.keywords){const key=normalize(k.value),old=all.get(key);all.set(key,{value:k.value,count:(old?.count??0)+k.count,weight:Math.max(old?.weight??0,k.score)});}
    await manager.updatePluginMeta(r.id,'keywords',{inputVersion:r.contentVersion,processorVersion:KEYWORD_VERSION,items:[...all.values()].sort((a,b)=>b.weight-a.weight).slice(0,100)},{schemaVersion:1,expectedRevision:latest.revision,expectedContentVersion:r.contentVersion});
    store.transaction(()=>{
      store.run('DELETE FROM matches WHERE fragment IN (SELECT id FROM fragments WHERE resource=?)',r.id);
      store.run('DELETE FROM fragments WHERE resource=?',r.id);
      for(const f of output)store.run('INSERT INTO fragments VALUES(?,?,?,?,?)',f.id,r.id,wanted,JSON.stringify(f),f.vectorKey);
      publishKeywords(store,latest,wanted,output,record?.text);
      for(const m of matches)store.run('INSERT INTO matches VALUES(?,?,?)',m.tag,m.fragment,m.score);
      store.run("UPDATE jobs SET published=?,state='ready',error='',retryAt=0 WHERE kind='resource' AND id=? AND wanted=?",wanted,r.id,wanted);
    });
    counters.publishedResources++;
  } finally {await manager.close();}
}
async function processTag(store:SemanticStore,dataDir:string,tag:Organization,encoder:Encoder,counters:Counters,signal?:AbortSignal) {
  const wanted=tagSignature(tag,encoder.identity),key=vectorKey(encoder.identity,tagText(tag),true);
  await encode(store,dataDir,encoder,[tagText(tag)],true,counters,signal);
  const manager=await CoreManager.open(dataDir);
  try {
    await requireSemanticPlugins(manager);
    const latest=await manager.getOrganization(tag.id);
    if(!activeTag(latest)||tagSignature(latest,encoder.identity)!==wanted)return;
    const resources=(await manager.listResources()).map(x=>x.resource);
    const valid=new Map(resources.map(r=>[r.id,resourceSignature(r,encoder.identity)]));
    const job=store.get<Job>("SELECT * FROM jobs WHERE kind='tag' AND id=?",tag.id)!;
    if(job.wanted!==wanted)return;
    const existing=store.get<{signature:string}>('SELECT signature FROM labels WHERE id=?',tag.id);
    store.transaction(()=>{
      if(existing?.signature!==wanted) {
        store.run('DELETE FROM matches WHERE tag=?',tag.id);
        store.run('INSERT OR REPLACE INTO labels VALUES(?,?,?)',tag.id,wanted,key);
        job.cursor='';
      }
      const all=store.all<{id:string;resource:string;signature:string;vectorKey:string}>('SELECT id,resource,signature,vectorKey FROM fragments ORDER BY id').filter(f=>valid.get(f.resource)===f.signature);
      const batch=all.filter(f=>f.id>job.cursor).slice(0,MATCH_BATCH);const labelVector=vector(store,key);
      for(const f of batch){const score=cosine(labelVector,vector(store,f.vectorKey));counters.comparisons++;if(score>=MATCH_THRESHOLD)store.run('INSERT OR REPLACE INTO matches VALUES(?,?,?)',tag.id,f.id,score);else store.run('DELETE FROM matches WHERE tag=? AND fragment=?',tag.id,f.id);}
      const cursor=batch.at(-1)?.id??job.cursor;const done=all.filter(f=>f.id<=cursor).length;const complete=done===all.length;
      store.run('UPDATE jobs SET state=?,cursor=?,done=?,total=?,published=?,error=\'\',retryAt=0 WHERE kind=\'tag\' AND id=?',complete?'ready':'processing',cursor,done,all.length,complete?wanted:job.published,tag.id);
      if(complete)counters.publishedTags++;
    });
  } finally {await manager.close();}
}
/** 自动标签只晋升跨文档的代表关键词，不创造新的上位概念。 */
async function autoTags(store:SemanticStore,dataDir:string,encoder:Encoder) {
  const manager=await CoreManager.open(dataDir);
  try {
  await requireSemanticPlugins(manager);
  const resources=(await manager.listResources()).map(x=>x.resource);const valid=new Map(resources.map(r=>[r.id,resourceSignature(r,encoder.identity)]));
  const terms=new Map<string,{value:string;documents:Set<string>;key:string}>();
  for(const row of store.all<{resource:string;signature:string;payload:string}>('SELECT resource,signature,payload FROM fragments')) {
    if(valid.get(row.resource)!==row.signature)continue;
    const f=JSON.parse(row.payload) as SemanticFragment;
    for(const word of f.keywords.slice(0,2)) {const name=normalize(word.value);const item=terms.get(name)??{value:word.value,documents:new Set<string>(),key:vectorKey(encoder.identity,word.value)};item.documents.add(f.resourceId);terms.set(name,item);}
  }
    const all=await manager.listOrganizations('tag');const names=new Set(all.flatMap(t=>[t.name,...(Array.isArray(t.data.aliases)?t.data.aliases.map(String):[])].map(normalize)));
    const labelVectors=store.all<{vectorKey:string}>('SELECT vectorKey FROM labels').map(t=>vector(store,t.vectorKey));let count=0;
    for(const [name,term] of terms) {
      if(count>=AUTO_TAG_LIMIT)break;
      if(term.documents.size<2||names.has(name))continue;
      const candidate=vector(store,term.key);if(labelVectors.some(v=>cosine(v,candidate)>=AUTO_EQUIVALENCE))continue;
      await manager.createOrganization({type:'tag',pluginId:'tags',name:term.value,data:{aliases:[],description:'',semanticOrigin:'automatic'}});
      names.add(name);labelVectors.push(candidate);count++;
    }
  } finally {await manager.close();}
}
/** 单进程/跨进程互斥，持久任务和编码缓存使服务重启后可以继续。 */
export async function runSemantic(dataDir:string,options:{encoder?:Encoder;maxJobs?:number;signal?:AbortSignal;automatic?:boolean}={}) {
  dataDir=await realpath(dataDir);
  return exclusive('semantic:'+(process.platform==='win32'?dataDir.toLowerCase():dataDir),async()=>{
    const check=await CoreManager.open(dataDir);try{await requireSemanticPlugins(check);const mode=check.pluginStore('organizer');if(!await mode.read('semantic-mode',false))await mode.write('semantic-mode',true);}finally{await check.close();}
    const store=await SemanticStore.open(dataDir);const counters=stats();
    try {
      store.db.exec('CREATE TABLE IF NOT EXISTS derivations(key TEXT PRIMARY KEY,payload TEXT)');
      let encoder:Encoder;
      try {encoder=options.encoder??await localEncoder(dataDir);}
      catch(error) {
        await reconcile(store,dataDir,'pending-model');
        store.run("UPDATE jobs SET state='failed',error=?,retryAt=? WHERE state!='ready'",(error as Error).message,Date.now()+RETRY_MS);
        return {complete:false,error:(error as Error).message,...counters};
      }
      store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value!=excluded.value','model',encoder.identity);
      const current=await reconcile(store,dataDir,encoder.identity);
      const jobs=store.jobs().filter(j=>j.state!=='ready'&&j.retryAt<=Date.now()).sort((a,b)=>a.kind===b.kind?a.id.localeCompare(b.id):a.kind==='tag'?-1:1).slice(0,options.maxJobs??4);
      for(const job of jobs) {
        options.signal?.throwIfAborted();
        try {
          if(job.kind==='resource'){const r=current.resources.find(r=>r.id===job.id);if(r)await processResource(store,dataDir,r,encoder,counters,options.signal);}
          else {const t=current.tags.find(t=>t.id===job.id);if(t)await processTag(store,dataDir,t,encoder,counters,options.signal);}
        } catch(error) {
          if(options.signal?.aborted)throw error;
          const deferred=['RECALL_BUSY','DEVELOPMENT_BUSY','WRITER_LOCKED'].includes((error as any).code);
          store.run('UPDATE jobs SET state=?,error=?,retryAt=? WHERE kind=? AND id=? AND wanted=?',deferred?'queued':'failed',(error as Error).message,Date.now()+(deferred?1000:RETRY_MS),job.kind,job.id,job.wanted);
        }
      }
      if(options.automatic!==false&&store.setting('keyword-rebuild')!=='running')await autoTags(store,dataDir,encoder);
      await reconcile(store,dataDir,encoder.identity);
      const unfinished=store.jobs().filter(j=>j.state!=='ready');const pending=unfinished.length;
      if(!pending&&store.setting('keyword-rebuild')==='running')store.setSetting('keyword-rebuild','complete');
      const retryAfterMs=unfinished.length&&unfinished.every(j=>j.retryAt>Date.now())?Math.max(1000,Math.min(...unfinished.map(j=>j.retryAt))-Date.now()):1000;
      return {complete:pending===0,pending,retryAfterMs,...counters};
    } finally {store.close();}
  });
}

/** 显式重建清除关键词派生缓存并排队，保留向量和标签；中断后 run 从持久任务续跑。 */
export async function rebuildKeywords(dataDir:string) {
  dataDir=await realpath(dataDir);
  return exclusive('semantic:'+(process.platform==='win32'?dataDir.toLowerCase():dataDir),async()=>{
    const manager=await CoreManager.open(dataDir);
    try{await requireSemanticPlugins(manager);await manager.pluginStore('organizer').write('semantic-mode',true);}finally{await manager.close();}
    const store=await SemanticStore.open(dataDir);
    try {
      if(store.setting('keyword-rebuild')==='running')return {queued:true,resumed:true};
      await reconcile(store,dataDir,store.setting('model')??'pending-model');
      store.transaction(()=>{
        store.run('DELETE FROM derivations');
        store.run("UPDATE jobs SET state='queued',retryAt=0,error='' WHERE kind='resource'");
        store.setSetting('keyword-rebuild','running');store.bumpKeywordRevision();
      });
      return {queued:true,resumed:false,resources:store.jobs().filter(j=>j.kind==='resource').length};
    }finally{store.close();}
  });
}
