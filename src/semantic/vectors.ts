import { readFile } from 'node:fs/promises';
import { modelLock, infer, emptyUsage, safeDirectory } from '../recall/models.js';
import { hash } from '../recall/scope.js';
import { KnowledgeError } from '../core/errors.js';
import { ENCODE_BATCH, type Encoder, type Counters } from './types.js';
import type { SemanticStore } from './store.js';

export const cosine = (a: number[], b: number[]) => a.reduce((sum,value,index)=>sum+value*b[index],0);
export const vectorKey = (identity:string,text:string,query=false) => hash(JSON.stringify([identity,query?'query':'document',text]));
export async function localEncoder(dataDir:string): Promise<Encoder> {
  const lock=await modelLock(dataDir);
  if(!lock) throw new KnowledgeError('MODEL_NOT_READY','本地向量模型尚未准备，请执行 recall model prepare 后重试');
  return {identity:lock.fingerprint,dimensions:lock.dimensions,async encode(texts,query) {
    const result=await infer(dataDir,lock,'embed',texts,emptyUsage(),query);
    return {vectors:result.values as number[][],truncated:result.truncatedInputs};
  }};
}
/** 与召回使用相同内容键；成功的编码批次立即缓存，失败重试不重复已完成批次。 */
export async function encode(store:SemanticStore,dataDir:string,encoder:Encoder,texts:string[],query:boolean,counters:Counters,signal?:AbortSignal) {
  const unique=[...new Set(texts)]; const missing:string[]=[];
  for(const text of unique) {
    const key=vectorKey(encoder.identity,text,query);
    if(store.get('SELECT key FROM vectors WHERE key=?',key)){counters.cacheHits++;continue;}
    if(!query) {
      try {
        const cached=JSON.parse(await readFile(await safeDirectory(dataDir,`cache/recall-vectors/${key}.json`),'utf8'));
        if(cached.identity===encoder.identity && cached.key===key && valid(cached.vector,encoder.dimensions) && typeof cached.truncated==='boolean') {
          store.run('INSERT OR IGNORE INTO vectors VALUES(?,?,?,?,?)',key,encoder.identity,0,JSON.stringify(cached.vector),Number(cached.truncated));counters.cacheHits++;continue;
        }
      } catch(error) { if((error as any).code==='UNSAFE_PATH') throw error; }
    }
    missing.push(text);
  }
  for(let at=0;at<missing.length;at+=ENCODE_BATCH) {
    signal?.throwIfAborted(); const batch=missing.slice(at,at+ENCODE_BATCH); const result=await encoder.encode(batch,query); signal?.throwIfAborted();
    if(result.vectors.length!==batch.length || result.truncated.length!==batch.length || result.vectors.some(v=>!valid(v,encoder.dimensions))) throw new KnowledgeError('MODEL_INVALID','模型向量数量、维度或数值无效');
    store.transaction(()=>batch.forEach((text,i)=>store.run('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?)',vectorKey(encoder.identity,text,query),encoder.identity,Number(query),JSON.stringify(result.vectors[i]),Number(result.truncated[i]))));
    counters.encodedTexts+=batch.length;
  }
  return texts.map(text=>vector(store,vectorKey(encoder.identity,text,query)));
}
function valid(value:unknown,dimensions:number):value is number[] { return Array.isArray(value)&&value.length===dimensions&&value.every(x=>typeof x==='number'&&Number.isFinite(x))&&Math.abs(Math.sqrt(value.reduce((sum,x)=>sum+x*x,0))-1)<0.02; }
export function vector(store:SemanticStore,key:string):number[] { const row=store.get<{vector:string}>('SELECT vector FROM vectors WHERE key=?',key); if(!row)throw new Error('VECTOR_MISSING'); return JSON.parse(row.vector); }
