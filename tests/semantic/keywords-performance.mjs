import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openApplication} from '../../dist/index.js';
import {SemanticStore} from '../../dist/semantic/store.js';
import {keywordBrowse,keywordId,publishKeywords} from '../../dist/semantic/keyword-index.js';
import {normalize} from '../../dist/plugins/keywords/extract.js';

const SAMPLES=30; // 相同进程/语料下比较旧计算与新持久索引，另测五万词查询。
const evidence='artifacts/verification/v0.0.13';await mkdir(evidence,{recursive:true});
const root=await mkdtemp(path.join(tmpdir(),'kb-keyword-perf-'));
const report={node:process.version,samples:SAMPLES,method:'串行单进程业务函数，首个请求单列为冷启动；未清理OS页缓存；内存为进程采样而非隔离峰值。合成索引仅验证查询规模，不代表模型质量。',cases:[]};
function dataset(documents,occurrences,unique,shared=false){const rows=Array.from({length:documents},()=>[]);for(let i=0;i<occurrences;i++)rows[i%documents].push('Keyword'+(i%unique));if(shared)for(const row of rows)row.push('SharedKeyword');return rows;}
function legacy(rows){const entries=[...new Set(rows.flatMap(row=>row.map(normalize)))].sort().map(word=>({id:word,name:word,description:'关键词',count:rows.filter(row=>row.map(normalize).includes(word)).length}));return {items:entries.slice(0,30),total:entries.length};}
async function measure(action){const times=[],sizes=[];const cpu=process.cpuUsage();let maxRss=process.memoryUsage().rss;const first=performance.now();await action();const coldMs=performance.now()-first;for(let i=0;i<SAMPLES;i++){const start=performance.now();const result=await action();times.push(performance.now()-start);sizes.push(Buffer.byteLength(JSON.stringify(result)));maxRss=Math.max(maxRss,process.memoryUsage().rss);}const usage=process.cpuUsage(cpu);times.sort((a,b)=>a-b);return {coldMs,p50Ms:times[Math.floor(SAMPLES*.5)],p95Ms:times[Math.ceil(SAMPLES*.95)-1],responseBytes:Math.max(...sizes),cpuMs:(usage.user+usage.system)/1000,maxObservedRssBytes:maxRss};}
try{
  for(const [name,rows] of [['current-scale',dataset(62,4049,3486)],['large-index',dataset(500,50000,50000,true)]]){
    const data=path.join(root,name);const app=await openApplication(data);await app.close();const store=await SemanticStore.open(data);const ids=[];
    try{store.transaction(()=>{for(let i=0;i<rows.length;i++){
      const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;ids.push(id);const text=rows[i].join(' ');let offset=0;
      const keywords=rows[i].map(value=>{const start=offset;offset+=value.length+1;return {value,start,end:start+value.length,count:1,score:.8};});
      const fragment={id:'f-'+i,resourceId:id,contentVersion:1,contentHash:'synthetic',title:`Document ${i}`,text,start:0,end:text.length,startLine:1,endLine:1,keywords,vectorKey:'synthetic',truncated:false};
      store.run('INSERT INTO fragments VALUES(?,?,?,?,?)',fragment.id,id,'synthetic',JSON.stringify(fragment),'synthetic');
      publishKeywords(store,{id,originalName:`Document ${i}.md`,extension:'md',mediaType:'text/markdown',size:text.length,contentVersion:1,updatedAt:'2026-11-12T00:00:00Z'},'synthetic',[fragment],text);
    }store.setSetting('keyword-source-generation','legacy');});
    }finally{store.close();}
    const word=name==='large-index'?'SharedKeyword':'Keyword0';
    const list=()=>keywordBrowse(data,new URL('http://local/api/browse/collections?type=keyword&limit=30'));
    const docs=()=>keywordBrowse(data,new URL(`http://local/api/browse/documents?type=keyword&id=${keywordId(word)}&limit=30`));
    const fragments=()=>keywordBrowse(data,new URL(`http://local/api/browse/fragments?type=keyword&id=${keywordId(word)}&resourceId=${ids[0]}&limit=30`));
    const before=name==='current-scale'?await measure(()=>legacy(rows)):undefined;
    const after={list:await measure(list),documents:await measure(docs),fragments:await measure(fragments)};
    const page=await list();assert(page.items.length<=30);assert((await docs()).items.length<=30);
    assert(after.list.p95Ms<300,JSON.stringify(after));assert(after.documents.p95Ms<500);assert(after.fragments.p95Ms<500);
    const index=await SemanticStore.open(data,true);let queryPlan;try{queryPlan=index.all('EXPLAIN QUERY PLAN SELECT DISTINCT resource FROM keyword_links WHERE keyword=?',keywordId(word));}finally{index.close();}
    const result={name,documents:rows.length,keywords:page.total,before,after,queryPlan};report.cases.push(result);console.log(JSON.stringify(result));
  }
  await writeFile(evidence+'/keywords-performance.json',JSON.stringify(report,null,2));
}finally{await rm(root,{recursive:true,force:true});}
