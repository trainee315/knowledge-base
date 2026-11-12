import { semanticEnabled } from './source.js';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { assert } from '../core/errors.js';
import { previewJson } from '../preview/readonly.js';
import { semanticCommand } from './api.js';
import { runSemantic } from './engine.js';
import { RECONCILE_MS } from './types.js';

const BODY_LIMIT=16*1024; // 标签名称/说明请求无需承载整篇文档。
/** 周期兜底与写入唤醒共用一个执行器，关闭/恢复前排空当前批次。 */
export function semanticService(dataDir:string,run:<T>(action:()=>Promise<T>)=>Promise<T>) {
  let running:Promise<unknown>|undefined;let timer:NodeJS.Timeout|undefined;let stopped=true;let controller=new AbortController();let next=0;
  function wake(){next=0;}
  function tick(){
    if(stopped||running||Date.now()<next)return;
    next=Date.now()+RECONCILE_MS;
    running=run(async()=>await semanticEnabled(dataDir)?runSemantic(dataDir,{signal:controller.signal}):{complete:true}).then((result)=>{if(!result.complete&&!('error' in result))next=Date.now()+('retryAfterMs' in result?Number(result.retryAfterMs):1000);},()=>{next=Date.now()+RECONCILE_MS;}).finally(()=>{running=undefined;});
  }
  return {
    wake,
    start(){if(!stopped)return;stopped=false;controller=new AbortController();next=0;timer=setInterval(tick,1000);timer.unref();},
    async stop(){stopped=true;if(timer)clearInterval(timer);controller.abort(new Error('SEMANTIC_STOPPED'));await running;},
    async handle(request:IncomingMessage,response:ServerResponse,url:URL,origin:string) {
      if(!url.pathname.startsWith('/api/semantic/'))return false;
      const match=/^\/api\/semantic\/tags(?:\/([a-f\d-]{36})(?:\/(retry))?)?$/.exec(url.pathname);
      if(url.pathname==='/api/semantic/retry'&&request.method==='POST') {
        assert(request.headers.origin===origin,'LOCAL_ONLY','写入需要同源请求');
        const data=await semanticCommand(dataDir,'retry-all',{});wake();previewJson(response,200,{ok:true,data});return true;
      }
      assert(match,'NOT_FOUND','语义标签接口不存在');
      if(request.method==='GET') {
        const data=await semanticCommand(dataDir,'list',{...Object.fromEntries(url.searchParams),...(match[1]?{id:match[1]}:{})});previewJson(response,200,{ok:true,data});return true;
      }
      assert(request.headers.origin===origin,'LOCAL_ONLY','写入需要同源请求');
      assert(['POST','PATCH','DELETE'].includes(request.method??''),'INVALID_ARGUMENT','请求方法无效');
      let input:Record<string,unknown>={};
      if(request.method!=='DELETE') {
        assert(request.headers['content-type']?.split(';')[0]==='application/json','INVALID_ARGUMENT','请求需要JSON');let size=0;const chunks:Buffer[]=[];
        for await(const chunk of request){size+=chunk.length;assert(size<=BODY_LIMIT,'INVALID_ARGUMENT','请求过大');chunks.push(Buffer.from(chunk));}
        try{input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{assert(false,'INVALID_ARGUMENT','JSON无效');}
        assert(input&&typeof input==='object'&&!Array.isArray(input),'INVALID_ARGUMENT','请求需要对象');
      }
      const action=request.method==='DELETE'?'delete':match[2]?'retry':request.method==='PATCH'?'update':'create';
      assert(action==='create'?!match[1]:!!match[1],'INVALID_ARGUMENT','标签操作路径无效');
      const data=await semanticCommand(dataDir,action,{...input,...(match[1]?{id:match[1]}:{})});wake();previewJson(response,200,{ok:true,data});return true;
    }
  };
}
