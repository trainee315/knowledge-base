import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openApplication } from '../index.js';
import { SemanticStore } from './store.js';
import { runSemantic } from './engine.js';

test('中断的标签关键词清理阻止后台编码和派生，恢复标记后可继续',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'kb-reset-guard-'));
  try {
    const app=await openApplication(root);await app.close();
    let store=await SemanticStore.open(root);store.setSetting('semantic-reset','running');store.close();
    let calls=0;
    const encoder={identity:'reset-guard',dimensions:1,async encode(texts:string[]){calls++;return {vectors:texts.map(()=>[1]),truncated:texts.map(()=>false)};}};
    const blocked=await runSemantic(root,{encoder});
    assert.equal(blocked.complete,false);assert('error' in blocked);assert.match(blocked.error??'',/SEMANTIC_RESET_INCOMPLETE/u);
    assert.equal(calls,0);assert.equal(blocked.publishedResources,0);assert.equal(blocked.publishedTags,0);
    store=await SemanticStore.open(root);assert.equal(store.jobs().length,0);store.setSetting('semantic-reset','complete');store.close();
    assert.equal((await runSemantic(root,{encoder})).complete,true);
  }finally{
    assert(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(root,{recursive:true,force:true});
  }
});
