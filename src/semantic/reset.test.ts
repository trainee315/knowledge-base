import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openApplication} from '../index.js';
import {CoreManager} from '../core/manager.js';
import {changeTag,semanticView} from './api.js';
import {runSemantic} from './engine.js';
import {resetSemantic} from './reset.js';
import {SemanticStore} from './store.js';

test('丢弃全部标签与关键词保留原文、历史和其他组织，重复重置可恢复',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'kb-reset-')),data=path.join(root,'data'),file=path.join(root,'original.md');
  await writeFile(file,'# Original\nfirst version');const app=await openApplication(data);
  const resource=(await app.manager.importResource(file)).resource;
  await writeFile(file,'# Original\nsecond version');await app.manager.updateResource(resource.id,file);
  const other=await app.manager.createOrganization({type:'reading-list',name:'Keep',data:{items:[resource.id]}});await app.close();
  const tag=await changeTag(data,'create',{name:'Old',aliases:['Legacy']});
  const before=await CoreManager.open(data,{readOnly:true});const meta=await before.getResource(resource.id);const original=await before.readContent(resource.id),history=await before.readContent(resource.id,1);await before.close();
  const store=await SemanticStore.open(data);store.run('INSERT INTO keyword_terms VALUES(?,?,?)','old','old','Old');store.close();
  await assert.rejects(()=>resetSemantic(data,false),/discardExisting/);
  assert.equal((await resetSemantic(data,true)).tags,1);await resetSemantic(data,true);
  const after=await CoreManager.open(data,{readOnly:true});
  try{const current=await after.getResource(resource.id);assert.equal(current.contentVersion,meta.contentVersion);assert.equal(current.hash,meta.hash);assert.deepEqual(current.history,meta.history);assert.deepEqual(await after.readContent(resource.id),original);assert.deepEqual(await after.readContent(resource.id,1),history);assert.deepEqual(await after.getOrganization(other.id),other);assert.deepEqual(await after.listOrganizations('tag'),[]);assert.deepEqual(current.plugins.keywords.data.items,[]);assert.deepEqual(current.plugins.tags.data.decisions,[]);assert((await after.check()).valid);}finally{await after.close();}
  const reset=await SemanticStore.open(data,true);try{assert.equal(reset.all('SELECT * FROM keyword_terms').length,0);assert.equal(reset.get('SELECT * FROM labels WHERE id=?',tag.id),undefined);}finally{reset.close();}
});

test('别名可编辑且共享唯一命名空间',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'kb-alias-'));const app=await openApplication(root);await app.close();
  const tag=await changeTag(root,'create',{name:'预制体',aliases:['Prefab']});
  await assert.rejects(()=>changeTag(root,'create',{name:'Other',aliases:['prefab']}),/重复/);
  await assert.rejects(()=>changeTag(root,'create',{name:'Other',aliases:['same','SAME']}),/重复/);
  const updated=await changeTag(root,'update',{id:tag.id,aliases:['PrefabAsset'],description:'节点资产'});assert.deepEqual(updated.data.aliases,['PrefabAsset']);
  await assert.rejects(()=>changeTag(root,'update',{id:tag.id,aliases:'bad'}),/数组/);
});

test('文档主题、正文片元和弱语义候选分开展示及计数',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'kb-evidence-')),data=path.join(root,'data'),file=path.join(root,'input.md');
  const app=await openApplication(data);await writeFile(file,'# 操作说明\n\n这里描述操作步骤。');await app.manager.importResource(file,{originalName:'Prefab.md'});
  await writeFile(file,'# 其他主题\n\n这里描述另外一种材料。');await app.manager.importResource(file,{originalName:'other.md'});await app.close();
  const tag=await changeTag(data,'create',{name:'预制体',aliases:['Prefab']});
  const encoder={identity:'evidence-fixture',dimensions:3,async encode(texts:string[],query:boolean){return {vectors:texts.map(()=>query?[1,0,0]:[0.5,Math.sqrt(0.75),0]),truncated:texts.map(()=>false)};}};
  for(let i=0;i<4;i++)if((await runSemantic(data,{encoder,maxJobs:20,automatic:false})).complete)break;
  const documents=await semanticView(data,{id:tag.id,view:'documents'}) as any;
  assert.equal(documents.total,1);assert.equal(documents.items[0].fragments,0);assert.equal(documents.items[0].preview.evidence.scope,'document');
  assert.equal((await semanticView(data,{id:tag.id,view:'fragments'}) as any).total,0);
  assert.equal((await semanticView(data,{id:tag.id,view:'keywords'}) as any).total,0);
  const candidates=await semanticView(data,{id:tag.id,view:'candidates'}) as any;
  assert.equal(candidates.total,1);assert.equal(candidates.tag.count,1);assert.equal(candidates.items[0].title,'other.md');
});
