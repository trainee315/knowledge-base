import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelLock,infer,emptyUsage } from '../../dist/recall/models.js';
import { cosine,vectorKey } from '../../dist/semantic/vectors.js';

const MAX_QUERIES=4; // 显式评估限制模型冷启动次数，不自动遍历全库。
const MAX_PAIRS_PER_QUERY=12; // 每组包含人工标注正反例，最多评估 48 对。
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++) {
  if(args[i]==='--inspect-only'){options.inspect=true;continue;}
  assert(['--data-dir','--input','--output'].includes(args[i]),'未知参数 '+args[i]);
  assert(args[i+1]&&!args[i+1].startsWith('--'),'参数缺少值 '+args[i]);options[args[i].slice(2)]=args[++i];
}
assert(options['data-dir']&&options.input,'用法：node tests/semantic/reranker-evaluate.mjs --data-dir <隔离库> --input <本地样本.json> [--output <本地报告.json>] [--inspect-only]');
const dataDir=await realpath(options['data-dir']);
const samples=JSON.parse(await readFile(options.input,'utf8'));
assert(Array.isArray(samples)&&samples.length>0&&samples.length<=MAX_QUERIES,'样本须为 1–4 个查询组成的数组');
const db=new DatabaseSync(path.join(dataDir,'cache/semantic/index.sqlite'),{readOnly:true});
const groups=samples.map(group=>{
  assert(typeof group.query==='string'&&group.query.trim()&&group.query.length<=500,'query 应为 1–500 字符');
  assert(Array.isArray(group.candidates)&&group.candidates.length>1&&group.candidates.length<=MAX_PAIRS_PER_QUERY,'每个查询须有 2–12 个候选');
  assert(group.candidates.some(x=>x.expected===true)&&group.candidates.some(x=>x.expected===false),'每个查询须同时有人工标注正例和反例');
  const seen=new Set();
  const candidates=group.candidates.map(candidate=>{
    assert(typeof candidate.fragmentId==='string'&&typeof candidate.expected==='boolean','候选必须有 fragmentId 和布尔 expected');
    assert(!seen.has(candidate.fragmentId),'同查询内候选不得重复');seen.add(candidate.fragmentId);
    const row=db.prepare('SELECT payload,vectorKey FROM fragments WHERE id=?').get(candidate.fragmentId);assert(row,'片元不存在：'+candidate.fragmentId);
    const fragment=JSON.parse(row.payload),stored=db.prepare('SELECT vector FROM vectors WHERE key=?').get(row.vectorKey);assert(stored,'片元向量缺失');
    return {fragment,vector:JSON.parse(stored.vector),expected:candidate.expected,reason:String(candidate.reason??'')};
  });
  return {query:group.query,candidates};
});
if(options.inspect) {
  console.log(JSON.stringify({validated:true,queries:groups.length,pairs:groups.reduce((n,g)=>n+g.candidates.length,0),groups:groups.map(g=>({query:g.query,candidates:g.candidates.map(c=>({fragmentId:c.fragment.id,title:c.fragment.title,startLine:c.fragment.startLine,expected:c.expected,reason:c.reason}))}))},null,2));
  db.close();
} else {
  const lock=await modelLock(dataDir);assert(lock,'本地模型未准备；此脚本不会下载模型');
  const usage=emptyUsage(),reports=[];const started=performance.now();
  // 读取已有向量，不写入索引；每组编码与重排串行执行并沿用模型互斥。
  for(const group of groups) {
    const cached=db.prepare('SELECT vector FROM vectors WHERE key=?').get(vectorKey(lock.fingerprint,group.query,true));
    const queryVector=cached?JSON.parse(cached.vector):(await infer(dataDir,lock,'embed',[group.query],usage,true)).values[0];
    const at=performance.now();
    const reranked=await infer(dataDir,lock,'rerank',group.candidates.map(c=>c.fragment.text),usage,group.query);
    const rows=group.candidates.map((c,i)=>({fragmentId:c.fragment.id,resourceId:c.fragment.resourceId,title:c.fragment.title,startLine:c.fragment.startLine,expected:c.expected,reason:c.reason,cosine:cosine(queryVector,c.vector),rerankLogit:reranked.values[i],truncated:reranked.truncatedInputs[i]}));
    const separation=field=>{
      const positives=rows.filter(x=>x.expected),negatives=rows.filter(x=>!x.expected);let wins=0,ties=0;
      for(const p of positives)for(const n of negatives){if(p[field]>n[field])wins++;else if(p[field]===n[field])ties++;}
      return {positiveNegativePairs:positives.length*negatives.length,wins,ties,agreement:(wins+ties*.5)/(positives.length*negatives.length)};
    };
    reports.push({query:group.query,rerankElapsedMs:performance.now()-at,cosineSeparation:separation('cosine'),rerankSeparation:separation('rerankLogit'),rows});
  }
  db.close();
  const report={model:lock.fingerprint,reranker:lock.reranker,queries:groups.length,pairs:groups.reduce((n,g)=>n+g.candidates.length,0),elapsedMs:performance.now()-started,usage,reports,note:'重排 logit 与余弦不可直接相加或视为概率。配对排序比较仅描述这批人工标注样本，不代表全库精确率或召回率。此脚本不修改匹配规则或库中结果。'};
  if(options.output){const output=path.resolve(options.output);await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
}
