import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openApplication } from '../index.js';
import { previewError } from '../preview/readonly.js';
import { WriterQueue } from '../core/writer-queue.js';
import { semanticService } from './service.js';

test('标签HTTP新增、重复校验、自动触发、失败重试、删除及同源检查',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'kb-semantic-api-'));const app=await openApplication(root);await app.close();const queue=new WriterQueue();const service=semanticService(root,fn=>queue.run(fn));let origin='';
 const server=createServer((req,res)=>{void queue.run(()=>service.handle(req,res,new URL(req.url!,origin),origin)).catch(e=>previewError(res,e));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as any).port;
 const request=async(path:string,method='GET',body?:unknown,withOrigin=true)=>{const response=await fetch(origin+'/api/semantic/'+path,{method,headers:{...(withOrigin?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()};};
 try {
  assert.equal((await request('tags','POST',{name:'性能优化'},false)).status,403);const created=await request('tags','POST',{name:'性能优化',description:'渲染与资源加载'});assert(created.ok);const id=created.data.id;
  assert.equal((await request('tags','POST',{name:'性能优化'})).status,409);service.start();
  let result:any;for(let i=0;i<40;i++){result=await request('tags/'+id);if(result.data.tag.state==='failed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.data.tag.state,'failed');assert.match(result.data.tag.error,/模型/);assert.equal(result.data.total,0);assert(result.data.tag.partial);
  assert((await request('tags/'+id+'/retry','POST',{})).ok);assert((await request('tags/'+id,'DELETE')).ok);assert.equal((await request('tags')).data.total,0);assert.equal((await request('tags/'+id)).status,404);
 } finally {await service.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
