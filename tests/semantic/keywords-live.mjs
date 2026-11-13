import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openApplication} from '../../dist/index.js';
import {runSemantic,rebuildKeywords} from '../../dist/semantic/engine.js';
import {localEncoder} from '../../dist/semantic/vectors.js';
import {keywordBrowse} from '../../dist/semantic/keyword-index.js';
import {changeTag} from '../../dist/semantic/api.js';

assert(process.env.KB_SEMANTIC_MODEL_DIR,'必须指定已存在的本地模型缓存');
const root=await mkdtemp(path.join(tmpdir(),'kb-keywords-live-')),data=path.join(root,'data');
try {
  const app=await openApplication(data);
  for(const [name,text] of [['render','# 纹理压缩\n\nASTC 纹理压缩可以降低显存占用，提高游戏渲染性能。'],['kitchen','# 厨房烹饪\n\n番茄和鸡蛋用于制作早餐。烹饪需要注意食材卫生。']]){const file=path.join(root,name+'.md');await writeFile(file,text);await app.manager.importResource(file);}
  await app.close();await mkdir(path.join(data,'cache'),{recursive:true});await cp(process.env.KB_SEMANTIC_MODEL_DIR,path.join(data,'cache/recall-models'),{recursive:true});
  await changeTag(data,'create',{name:'性能优化',description:'游戏渲染与显存占用'});
  const encoder=await localEncoder(data),first=await runSemantic(data,{encoder,maxJobs:20,automatic:false});assert(first.complete);
  const before=await keywordBrowse(data,new URL('http://local/api/browse/collections?type=keyword&limit=200'));assert(before.total>0);
  await rebuildKeywords(data);const rebuilt=await runSemantic(data,{encoder,maxJobs:20});assert(rebuilt.complete);assert.equal(rebuilt.encodedTexts,0);assert(rebuilt.derivedFragments>0);
  const after=await keywordBrowse(data,new URL('http://local/api/browse/collections?type=keyword&limit=200'));assert.deepEqual(after.items,before.items);
  const again=await runSemantic(data,{encoder,maxJobs:20,automatic:false});assert.equal(again.publishedResources+again.derivedFragments+again.encodedTexts+again.comparisons,0);
  const report={passed:true,model:encoder.identity,documents:2,keywords:after.total,first,rebuilt,unchanged:again};
  await mkdir('artifacts/verification/v0.0.13',{recursive:true});await writeFile('artifacts/verification/v0.0.13/keywords-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await rm(root,{recursive:true,force:true});}
