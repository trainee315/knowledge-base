import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openApplication } from '../index.js';
import { CoreManager } from '../core/manager.js';
import { changeTag,semanticView,semanticCommand } from './api.js';
import { runSemantic } from './engine.js';
import { SemanticStore } from './store.js';
import { candidates } from './keywords.js';
import type { Encoder } from './types.js';

function encoder():Encoder&{calls:string[][]} {
  const calls:string[][]=[];
  return {identity:'fixture-1',dimensions:3,calls,async encode(texts) {calls.push(texts);return {vectors:texts.map(text=>/纹理|压缩|ASTC|性能/iu.test(text)?[1,0,0]:/烹饪|厨房|食物/u.test(text)?[0,1,0]:[0,0,1]),truncated:texts.map(()=>false)};}};
}
async function setup(){const root=await mkdtemp(path.join(tmpdir(),'kb-semantic-'));const data=path.join(root,'data');const app=await openApplication(data);await app.close();let serial=0;return {root,data,async add(text:string,name='sample.md'){const file=path.join(root,`input-${serial++}.md`);await writeFile(file,text);const m=await CoreManager.open(data);try{return (await m.importResource(file,{originalName:name,copy:true})).resource;}finally{await m.close();}},async update(id:string,text:string){const file=path.join(root,`update-${serial++}.md`);await writeFile(file,text);const m=await CoreManager.open(data);try{return await m.updateResource(id,file);}finally{await m.close();}}};}
async function drain(data:string,e:Encoder,automatic=false){for(let i=0;i<30;i++){const result=await runSemantic(data,{encoder:e,maxJobs:20,automatic});if(result.complete)return result;}throw new Error('queue did not drain');}

test('关键词候选都是原文切片，保留英文实体短语及中文术语',()=>{
 const text='Personal Project Center 管理纹理压缩与 ASTC。';const terms=candidates(text);assert(terms.some(t=>t.value==='Personal Project Center'));assert(terms.some(t=>t.value==='纹理压缩'));for(const t of terms)assert.equal(text.slice(t.start,t.end),t.value);
});
test('新增标签只编码标签；同输入不重复编码，结果汇总在分页前去重',async()=>{
 const f=await setup(),e=encoder();await f.add('# 纹理压缩\n\nASTC 优化性能。');await f.add('# 厨房\n\n烹饪食物。');await drain(f.data,e);
 const before=e.calls.flat().length;const tag=await changeTag(f.data,'create',{name:'性能优化'});await drain(f.data,e);assert.equal(e.calls.flat().length-before,1);
 const result=await semanticView(f.data,{id:tag.id}) as any;assert.equal(result.total,1);assert.equal(result.tag.count,1);assert.equal(result.tag.partial,false);
 const wordResult=await semanticView(f.data,{id:tag.id,view:'keywords'}) as any;assert(wordResult.items.length>0);
 const unchanged=await runSemantic(f.data,{encoder:e,automatic:false});assert.equal(unchanged.encodedTexts,0);assert.equal(unchanged.comparisons,0);
});
test('更新原文立即隐藏旧结果；相同片元换位置复用编码并更新出处',async()=>{
 const f=await setup(),e=encoder();const r=await f.add('# 纹理压缩\n\nASTC 优化性能。\n\n# 厨房\n\n烹饪食物。');const tag=await changeTag(f.data,'create',{name:'性能优化'});await drain(f.data,e);const before=e.calls.flat().length;
 await f.update(r.id,'# 新章节\n\n新的介绍。\n\n# 纹理压缩\n\nASTC 优化性能。\n\n# 厨房\n\n烹饪食物。');assert.equal((await semanticView(f.data,{id:tag.id}) as any).total,0);await drain(f.data,e);
 const hits=await semanticView(f.data,{id:tag.id,view:'fragments'}) as any;assert.equal(hits.total,1);assert.equal(hits.items[0].startLine,5);assert.equal(hits.items[0].contentVersion,2);
 assert(e.calls.slice(0).flat().length>before);const newEncoded=e.calls.flat().slice(before);assert(!newEncoded.some(t=>t.includes('ASTC')),'unchanged fragment must not be re-encoded');
 for(const k of hits.items[0].keywords){const m=await CoreManager.open(f.data,{readOnly:true});try{const raw=(await m.readContent(r.id)).toString();assert.equal(raw.slice(k.start,k.end),k.value);}finally{await m.close();}}
});
test('删除标签保留原文和历史人工决定；自动生成抑制，显式新增可恢复',async()=>{
 const f=await setup(),e=encoder();const r=await f.add('纹理压缩 ASTC 性能优化');await f.add('纹理压缩 ASTC 性能优化\n第二篇');const tag=await changeTag(f.data,'create',{name:'纹理压缩'});
 const app=await openApplication(f.data);await app.plugins.execute('tag decide',{resourceId:r.id,tagId:tag.id,accepted:true,source:'manual',reason:'历史判断',contentVersion:1,tagRevision:tag.revision},[]);await app.close();await drain(f.data,e);
 await changeTag(f.data,'delete',{id:tag.id});assert(!(await semanticView(f.data) as any).items.some((t:any)=>t.id===tag.id));await drain(f.data,e,true);
 assert(!(await semanticView(f.data) as any).items.some((t:any)=>t.name==='纹理压缩'));const m=await CoreManager.open(f.data,{readOnly:true});try{assert((await m.getResource(r.id)).plugins.tags);assert((await m.check()).valid);}finally{await m.close();}
 const restored=await changeTag(f.data,'create',{name:'纹理压缩'});assert.equal(restored.id,tag.id);
});
test('失败任务跨实例重试复用成功批次，空结果与失败状态可区分',async()=>{
 const f=await setup(),e=encoder();await f.add('纹理 压缩 ASTC 性能 管理 资源 渲染 加载 模块 数据 缓存 处理 测试 文档 片元 标签 优化 编码 存储');const tag=await changeTag(f.data,'create',{name:'性能优化'});
 const original=e.encode.bind(e);let batches=0;e.encode=async(t,q)=>{if(++batches===3)throw new Error('injected encoding failure');return original(t,q);};await runSemantic(f.data,{encoder:e,maxJobs:20,automatic:false});
 const failed=await semanticView(f.data,{id:tag.id}) as any;assert(failed.status.failed>0);assert(failed.tag.partial);const encoded=e.calls.flat();e.encode=original;await semanticCommand(f.data,'retry-all',{});await drain(f.data,e);
 const final=e.calls.flat();for(const text of encoded)assert.equal(final.filter(t=>t===text).length,1);assert.equal((await semanticView(f.data,{id:tag.id}) as any).status.failed,0);
});
test('编码期间原文变化时拒绝旧任务发布，下一轮处理最新版本',async()=>{
 const f=await setup(),e=encoder();const r=await f.add('纹理压缩 ASTC 性能');const tag=await changeTag(f.data,'create',{name:'性能优化'});let changed=false;const original=e.encode.bind(e);e.encode=async(t,q)=>{if(!q&&!changed){changed=true;await f.update(r.id,'烹饪食物 厨房');}return original(t,q);};
 await runSemantic(f.data,{encoder:e,maxJobs:20,automatic:false});assert.equal((await semanticView(f.data,{id:tag.id}) as any).total,0);await drain(f.data,e);assert.equal((await semanticView(f.data,{id:tag.id}) as any).total,0);
});
test('标签修改、删除资源和模型版本变化更新范围正确',async()=>{
 const f=await setup(),e=encoder();const r=await f.add('纹理压缩 ASTC');await f.add('烹饪食物 厨房');const tag=await changeTag(f.data,'create',{name:'性能优化'});await drain(f.data,e);const before=e.calls.flat().length;
 await changeTag(f.data,'update',{id:tag.id,name:'厨房'});assert.equal((await semanticView(f.data,{id:tag.id}) as any).total,0);await drain(f.data,e);assert.equal(e.calls.flat().length-before,1);assert.equal((await semanticView(f.data,{id:tag.id}) as any).total,1);
 const m=await CoreManager.open(f.data);await m.deleteResource(r.id);await m.close();await drain(f.data,e);const store=await SemanticStore.open(f.data);try{assert(!store.fragments().some(x=>x.resourceId===r.id));}finally{store.close();}
 e.identity='fixture-2';const result=await runSemantic(f.data,{encoder:e,maxJobs:20,automatic:false});assert(result.encodedTexts>0);
});

test('自动标签来自跨文档关键词且重复运行不产生重复名称',async()=>{
 const f=await setup(),e=encoder();await f.add('# 纹理压缩\n\nASTC 性能优化。','a.md');await f.add('# 纹理压缩\n\nASTC 性能优化。','b.md');await drain(f.data,e,true);
 const first=await semanticView(f.data) as any;assert(first.items.length>0);assert(first.items.every((t:any)=>t.origin==='automatic'));const names=first.items.map((t:any)=>t.name);await drain(f.data,e,true);assert.deepEqual((await semanticView(f.data) as any).items.map((t:any)=>t.name),names);
});
test('标签分批匹配重启续跑，分页总数及低分结果正确',async()=>{
 const f=await setup(),e=encoder();const text=Array.from({length:135},(_,i)=>`# 章节 ${i}\n\n纹理压缩 ASTC 性能。\n\n`).join('');await f.add(text);await drain(f.data,e);const tag=await changeTag(f.data,'create',{name:'性能优化'});
 const first=await runSemantic(f.data,{encoder:e,maxJobs:1,automatic:false});assert.equal(first.complete,false);let page=await semanticView(f.data,{id:tag.id,view:'fragments',limit:10}) as any;assert.equal(page.tag.state,'processing');assert.equal(page.total,128);
 await drain(f.data,e);page=await semanticView(f.data,{id:tag.id,view:'fragments',offset:130,limit:10}) as any;assert.equal(page.total,135);assert.equal(page.items.length,5);assert.equal((await semanticView(f.data,{id:tag.id}) as any).total,1);
});
test('编码期间删除标签不会复活；插件停用后后台拒绝继续发布',async()=>{
 const f=await setup(),e=encoder();await f.add('纹理压缩 ASTC');const tag=await changeTag(f.data,'create',{name:'性能优化'});const original=e.encode.bind(e);let deleted=false;e.encode=async(t,q)=>{if(q&&!deleted){deleted=true;await changeTag(f.data,'delete',{id:tag.id});}return original(t,q);};await drain(f.data,e);assert.equal((await semanticView(f.data) as any).total,0);
 const app=await openApplication(f.data);await app.plugins.setEnabled('tags',false,true);await app.close();await assert.rejects(()=>runSemantic(f.data,{encoder:e}),/启用/);await assert.rejects(()=>changeTag(f.data,'create',{name:'new'}),/启用/);
});
test('没有派生库时浏览接口不会创建磁盘缓存',async()=>{
 const f=await setup();await semanticView(f.data);const {stat}=await import('node:fs/promises');await assert.rejects(()=>stat(path.join(f.data,'cache/semantic/index.sqlite')),{code:'ENOENT'});
});

test('组合查询按语义标签取交集后分页，旧人工拒绝不会覆盖新语义浏览',async()=>{
 const f=await setup(),e=encoder();const a=await f.add('纹理压缩 ASTC 性能','a.md');await f.add('纹理压缩 ASTC 性能','b.md');await f.add('厨房食物','c.md');const tag=await changeTag(f.data,'create',{name:'性能优化'});
 const legacy=await openApplication(f.data);await legacy.plugins.execute('tag decide',{resourceId:a.id,tagId:tag.id,accepted:false,source:'manual',reason:'旧流程拒绝',contentVersion:1,tagRevision:tag.revision},[]);await legacy.close();await drain(f.data,e);
 const {semanticResourceQuery}=await import('./query.js');const app=await openApplication(f.data,{readOnly:true});
 try{const result=await semanticResourceQuery(f.data,{tags:[tag.id],limit:1,offset:1},input=>app.plugins.execute('organize query',input,[]));assert.equal(result.total,2);assert.equal(result.items.length,1);const none=await semanticResourceQuery(f.data,{tags:[tag.id,'不存在'],tagMatch:'all'},input=>app.plugins.execute('organize query',input,[]));assert.equal(none.total,0);}finally{await app.close();}
});

test('未来关键词meta结构不得被后台降级覆盖',async()=>{
 const f=await setup(),e=encoder();const r=await f.add('纹理压缩 ASTC');const manager=await CoreManager.open(f.data);await manager.updatePluginMeta(r.id,'keywords',{future:true},{schemaVersion:99});await manager.close();const result=await runSemantic(f.data,{encoder:e,automatic:false});assert.equal(result.complete,false);const reader=await CoreManager.open(f.data,{readOnly:true});try{assert.equal((await reader.getResource(r.id)).plugins.keywords.schemaVersion,99);}finally{await reader.close();}assert.equal(e.calls.length,0);
});
