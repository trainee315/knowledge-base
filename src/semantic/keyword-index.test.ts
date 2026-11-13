import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openApplication } from '../index.js';
import { CoreManager } from '../core/manager.js';
import { runSemantic, rebuildKeywords } from './engine.js';
import { keywordBrowse, keywordId, keywordResourceIds } from './keyword-index.js';
import { SemanticStore } from './store.js';
import { semanticResourceQuery } from './query.js';
import { browse } from '../preview/browse.js';
import { semanticCommand } from './api.js';
import type { Encoder } from './types.js';

const encoder: Encoder = {identity:'keyword-fixture',dimensions:3,async encode(texts){return {vectors:texts.map(()=>[1,0,0]),truncated:texts.map(()=>false)};}};
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'kb-keyword-index-')),data=path.join(root,'data');
  const app=await openApplication(data);await app.close();
  const file=path.join(root,'document.md');
  await writeFile(file,Array.from({length:120},(_,i)=>`# Term${i}Unique\n\nTerm${i}Unique evidence.\n`).join('\n'));
  const m=await CoreManager.open(data);let resource;try{resource=(await m.importResource(file)).resource;}finally{await m.close();}
  await runSemantic(data,{encoder,maxJobs:10,automatic:false});
  return {root,data,file,resource};
}

test('关键词列表只读持久词表，不调用全库资源扫描，也不返回文档计数',async()=>{
  const f=await fixture();const app=await openApplication(f.data,{readOnly:true});
  try {
    app.manager.listResources=async()=>{throw new Error('keyword list scanned resources');};
    const result=await browse(app,new URL('http://local/api/browse/collections?type=keyword&limit=30')) as any;
    assert.equal(result.items.length,30);assert(result.total>100);
    assert(result.items.every((x:any)=>!('count' in x)&&!('description' in x)));
  }finally{await app.close();await rm(f.root,{recursive:true,force:true});}
});

test('只读浏览拒绝将旧算法词表展示为当前结果',async()=>{
  const f=await fixture();
  try {
    const store=await SemanticStore.open(f.data);store.setSetting('keyword-algorithm','obsolete-version');store.close();
    const result=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));
    assert.equal(result.status.state,'pending');assert.equal(result.items.length,0);
    await runSemantic(f.data,{encoder,maxJobs:20,automatic:false});
    assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).status.state,'ready');
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('单词关联按文档分页且片元可定位，包含搜索和稳定代次正确',async()=>{
  const f=await fixture();
  try {
    const page=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword&q=Term119Unique'));
    assert(page.items.length>0);const term=page.items[0];
    const docs=await keywordBrowse(f.data,new URL('http://local/api/browse/documents?type=keyword&id='+term.id));assert.equal(docs.total,1);
    assert(!('plugins' in docs.items[0].resource));assert(!('text' in docs.items[0]));
    const hit=await keywordBrowse(f.data,new URL(`http://local/api/browse/fragments?type=keyword&id=${term.id}&resourceId=${f.resource.id}&version=1&limit=1`));
    assert.equal(hit.items.length,1);const raw=await readFile(f.file,'utf8');assert.equal(raw.slice(hit.items[0].evidence.start,hit.items[0].evidence.end),hit.items[0].evidence.value);
    assert.equal((await keywordBrowse(f.data,new URL(`http://local/api/browse/documents?type=keyword&id=${term.id}&q=not-matching`))).total,0);
    await assert.rejects(()=>keywordBrowse(f.data,new URL(`http://local/api/browse/documents?type=keyword&id=${term.id}&generation=obsolete`)),{code:'KEYWORD_GENERATION_CHANGED'});
    assert.equal(keywordId(' ＡＳＴＣ  Texture '),keywordId('astc texture'));
    const plan=await SemanticStore.open(f.data,true);try{assert.match(JSON.stringify(plan.all('EXPLAIN QUERY PLAN SELECT DISTINCT resource FROM keyword_links WHERE keyword=?',term.id)),/SEARCH.*keyword_links/i);}finally{plan.close();}
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('修改立即隐藏旧代次，删除/恢复与共用词回收保持双向一致',async()=>{
  const f=await fixture();
  try {
    const original=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));
    const m=await CoreManager.open(f.data);let other;try{other=(await m.importResource(f.file,{copy:true})).resource;await m.deleteResource(f.resource.id);}finally{await m.close();}
    assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).status.state,'pending');
    await runSemantic(f.data,{encoder,automatic:false,maxJobs:10});
    const next=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));assert.equal(next.total,original.total);
    const ids=await keywordResourceIds(f.data,['Term119Unique']);assert.deepEqual([...ids],[other.id]);
    const writer=await CoreManager.open(f.data);try{await writer.deleteResource(other.id);}finally{await writer.close();}
    await runSemantic(f.data,{encoder,automatic:false,maxJobs:10});assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).total,0);
    const restore=await CoreManager.open(f.data);try{await restore.restoreResource(f.resource.id);}finally{await restore.close();}
    await runSemantic(f.data,{encoder,automatic:false,maxJobs:10});assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).total,original.total);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('显式重建可续跑、重新派生而复用向量，不新增标签且无变更不重复发布',async()=>{
  const f=await fixture();
  try {
    assert.equal((await rebuildKeywords(f.data)).resumed,false);assert.equal((await rebuildKeywords(f.data)).resumed,true);
    const hidden=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));assert.equal(hidden.status.state,'rebuilding');assert.equal(hidden.items.length,0);
    const rebuilt=await runSemantic(f.data,{encoder,maxJobs:1});assert(rebuilt.complete);assert(rebuilt.derivedFragments>100);assert.equal(rebuilt.encodedTexts,0);
    const page=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));assert.equal(page.status.state,'ready');
    const again=await runSemantic(f.data,{encoder,automatic:false});assert.equal(again.derivedFragments,0);assert.equal(again.publishedResources,0);assert.equal(again.comparisons,0);
    assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).generation,page.generation);
    const m=await CoreManager.open(f.data,{readOnly:true});try{assert.equal((await m.listOrganizations('tag')).length,0);}finally{await m.close();}
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('v1缓存只在写路径迁移，保留向量；迁移后重放资源发布；未来版本拒绝',async()=>{
  const f=await fixture();
  try {
    let store=await SemanticStore.open(f.data);const vectors=store.get<{n:number}>('SELECT count(*) AS n FROM vectors')!.n;
    store.db.exec('DROP TABLE keyword_links; DROP TABLE keyword_terms; DROP TABLE keyword_documents; PRAGMA user_version=1;');store.close();
    assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).status.state,'pending');
    store=await SemanticStore.open(f.data,true);assert.equal(store.get<{user_version:number}>('PRAGMA user_version')!.user_version,1);store.close();
    const rebuilt=await runSemantic(f.data,{encoder,automatic:false,maxJobs:10});assert(rebuilt.complete);assert.equal(rebuilt.encodedTexts,0);
    store=await SemanticStore.open(f.data);assert.equal(store.get<{n:number}>('SELECT count(*) AS n FROM vectors')!.n,vectors);store.db.exec('PRAGMA user_version=99');store.close();
    await assert.rejects(()=>SemanticStore.open(f.data),{code:'SEMANTIC_SCHEMA'});
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('缺失索引只读返回待建；组合筛选使用完整关键词关系',async()=>{
  const f=await fixture();
  try {
    const app=await openApplication(f.data,{readOnly:true});
    try{const result=await semanticResourceQuery(f.data,{keywords:['Term119Unique'],limit:1},input=>app.plugins.execute('organize query',input,[]));assert.equal(result.total,1);}finally{await app.close();}
    const other=path.join(f.root,'empty');const app2=await openApplication(other);await app2.close();
    assert.equal((await keywordBrowse(other,new URL('http://local/api/browse/collections?type=keyword'))).status.state,'pending');
    await assert.rejects(()=>stat(path.join(other,'cache/semantic/index.sqlite')),{code:'ENOENT'});
    const interrupted=await SemanticStore.open(other);interrupted.db.exec('DROP TABLE jobs; DROP TABLE settings; PRAGMA user_version=0;');interrupted.close();
    assert.equal((await keywordBrowse(other,new URL('http://local/api/browse/collections?type=keyword'))).status.state,'pending');
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('完整关键词索引包含摘要前100项以外的片元词汇',async()=>{
  const f=await fixture();const app=await openApplication(f.data,{readOnly:true});
  try {
    const meta=await app.manager.getResource(f.resource.id);assert.equal((meta.plugins.keywords.data.items as any[]).length,100);
    const all=[];for(let offset=0;;offset+=30){const page=await browse(app,new URL(`http://local/api/browse/collections?type=keyword&limit=30&offset=${offset}`)) as any;all.push(...page.items);if(offset+30>=page.total)break;}
    assert(all.length>100);const summary=new Set((meta.plugins.keywords.data.items as any[]).map(x=>x.value.toLowerCase()));
    const extra=all.find(x=>!summary.has(x.name.toLowerCase()));assert(extra);
    const docs=await browse(app,new URL('http://local/api/browse/documents?type=keyword&id='+encodeURIComponent(extra.id))) as any;
    assert.equal(docs.total,1);assert.equal(docs.items[0].resource.id,f.resource.id);
  }finally{await app.close();await rm(f.root,{recursive:true,force:true});}
});

test('发布失败回滚完整关系，重建保持不可见，显式重试恢复同一资源',async()=>{
  const f=await fixture();const original=SemanticStore.prototype.run;
  try {
    const before=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));
    await rebuildKeywords(f.data);let injected=false;
    SemanticStore.prototype.run=function(sql,...args){if(!injected&&sql.startsWith('INSERT OR REPLACE INTO keyword_links')){injected=true;throw new Error('injected keyword publish failure');}return original.call(this,sql,...args);};
    const failed=await runSemantic(f.data,{encoder,maxJobs:1,automatic:false});assert(!failed.complete);assert(injected);
    SemanticStore.prototype.run=original;
    const hidden=await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'));assert.equal(hidden.status.state,'rebuilding');assert.equal(hidden.status.failed,1);assert.equal(hidden.items.length,0);
    const store=await SemanticStore.open(f.data,true);try{assert.equal(store.get<{n:number}>('SELECT count(*) AS n FROM keyword_terms')!.n,before.total);assert.equal(store.get<{n:number}>('SELECT count(*) AS n FROM keyword_links k LEFT JOIN fragments f ON f.id=k.fragment WHERE f.id IS NULL')!.n,0);}finally{store.close();}
    await semanticCommand(f.data,'retry-all',{});assert((await runSemantic(f.data,{encoder,maxJobs:1,automatic:false})).complete);
    assert.equal((await keywordBrowse(f.data,new URL('http://local/api/browse/collections?type=keyword'))).total,before.total);
  }finally{SemanticStore.prototype.run=original;await rm(f.root,{recursive:true,force:true});}
});

test('模型计算期间正文变更，丢弃旧发布并在下一轮索引新版本',async()=>{
  const f=await fixture();let changed=false;
  try {
    const racing:Encoder={...encoder,identity:'new-keyword-model',async encode(texts){if(!changed){changed=true;await writeFile(f.file,'# ReplacementOnly\n\nReplacementOnly evidence.');const writer=await CoreManager.open(f.data);try{await writer.updateResource(f.resource.id,f.file,1);}finally{await writer.close();}}return encoder.encode(texts,false);}};
    const first=await runSemantic(f.data,{encoder:racing,maxJobs:1,automatic:false});assert(!first.complete);assert.equal(first.publishedResources,0);
    assert((await runSemantic(f.data,{encoder:racing,maxJobs:1,automatic:false})).complete);
    assert.equal((await keywordResourceIds(f.data,['Term119Unique'])).size,0);assert((await keywordResourceIds(f.data,['ReplacementOnly'])).has(f.resource.id));
    const hit=await keywordBrowse(f.data,new URL(`http://local/api/browse/fragments?type=keyword&id=ReplacementOnly&resourceId=${f.resource.id}&version=2`));assert.equal(hit.items[0].contentVersion,2);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
