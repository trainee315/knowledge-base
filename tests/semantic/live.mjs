import assert from 'node:assert/strict';
import { mkdtemp,cp,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openApplication } from '../../dist/index.js';
import { CoreManager } from '../../dist/core/manager.js';
import { changeTag,semanticView } from '../../dist/semantic/api.js';
import { runSemantic } from '../../dist/semantic/engine.js';
import { localEncoder } from '../../dist/semantic/vectors.js';

assert(process.env.KB_SEMANTIC_MODEL_DIR,'Specify an existing local model cache; this test never downloads models.');
const root=await mkdtemp(path.join(tmpdir(),'kb-semantic-live-'));const data=path.join(root,'data');
const app=await openApplication(data);await app.close();await mkdir(path.join(data,'cache'),{recursive:true});
await cp(process.env.KB_SEMANTIC_MODEL_DIR,path.join(data,'cache/recall-models'),{recursive:true});
const records=[['render.md','# 纹理压缩\n\nASTC 纹理压缩降低显存占用。选择合适的压缩格式能够改善游戏加载性能。'],['kitchen.md','# 厨房烹饪\n\n新鲜番茄与鸡蛋用于制作早餐，烹饪时注意食材卫生。']];
for(const [name,text] of records){const file=path.join(root,name);await writeFile(file,text);const manager=await CoreManager.open(data);try{await manager.importResource(file);}finally{await manager.close();}}
const tag=await changeTag(data,'create',{name:'性能优化',description:'游戏渲染、显存占用与资源加载性能'});
const encoder=await localEncoder(data);const started=performance.now();const first=await runSemantic(data,{encoder,maxJobs:20,automatic:false});const second=await runSemantic(data,{encoder,maxJobs:20,automatic:false});
const documents=await semanticView(data,{id:tag.id});const words=await semanticView(data,{id:tag.id,view:'keywords'});const fragments=await semanticView(data,{id:tag.id,view:'fragments'});
if(!first.complete)console.log(JSON.stringify({first,second,documents},null,2));assert(first.complete);assert.equal(second.encodedTexts,0);assert.equal(second.comparisons,0);assert(documents.items.some(x=>x.title==='render.md'));assert.equal(documents.items[0].title,'render.md');
for(const fragment of fragments.items){const raw=records.find(x=>x[0]===fragment.title)[1];for(const word of fragment.keywords)assert.equal(raw.slice(word.start,word.end),word.value);}
const addStart=performance.now();const extra=await changeTag(data,'create',{name:'纹理压缩'});const added=await runSemantic(data,{encoder,maxJobs:20,automatic:false});assert.equal(added.encodedTexts,1);
const report={model:encoder.identity,durationMs:performance.now()-started,first,unchanged:second,newTag:{...added,durationMs:performance.now()-addStart},documents:documents.items.map(x=>({title:x.title,score:x.score,fragments:x.fragments})),keywords:words.items.map(x=>x.value)};
await writeFile('artifacts/verification/v0.0.11/live.json',JSON.stringify(report,null,2));
await mkdir('.runtime',{recursive:true});
await writeFile('.runtime/v0011-live.json',JSON.stringify({dataDir:data,tagId:tag.id,extraTagId:extra.id}));
console.log(JSON.stringify(report,null,2));
