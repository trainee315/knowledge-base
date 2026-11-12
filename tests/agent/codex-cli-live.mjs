import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApplication } from '../../dist/index.js';
import { transcriptCommand } from '../../dist/records/transcript.js';

// 显式运行才使用服务器订阅；仅发送下面的合成对话，不读取私人 Session。
if (!process.env.KB_CODEX_LIVE_MODEL) throw new Error('Set KB_CODEX_LIVE_MODEL to explicitly enable subscription inference');
const model = process.env.KB_CODEX_LIVE_MODEL;
const root = await mkdtemp(join(tmpdir(), 'kb-codex-live-'));
const dataDir = join(root, 'data'), sourceRoot = join(root, 'source');
const evidence = resolve('artifacts/verification/v0.0.12/live-session.json');
await mkdir(sourceRoot);
const row = (type,payload) => JSON.stringify({timestamp:'2026-01-01T01:00:00Z',type,payload})+'\n';
await writeFile(join(sourceRoot,'fixture.jsonl'),
  row('session_meta',{id:'codex-live-fixture',cwd:root,source:'cli'})+
  row('event_msg',{type:'task_started'})+
  row('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'新增健康检查接口 /health，监听端口 4317，不增加数据库依赖。'}]})+
  row('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'已实现 /health 并验证 HTTP 200；端口 4317。没有新增数据库依赖。尚未部署。'}]})+
  row('event_msg',{type:'task_complete'}));
try {
  let app = await openApplication(dataDir);
  let readiness, connection;
  try {
    await app.plugins.execute('agent profile set',{id:'codex-live',providerId:'codex-cli',model,timeoutMs:120000,maxTokens:4096,reasoningEffort:'low'});
    readiness=await app.plugins.execute('agent check',{profile:'codex-live'});
    assert.equal(readiness.state,'ready');
    connection=await app.plugins.execute('agent test',{profile:'codex-live'});
    assert.deepEqual(connection.value,{ok:true});
  } finally { await app.close(); }
  const instance=await transcriptCommand(dataDir,'create',{alias:'合成验收',sourceRoot,projectDir:root,startDate:'2026-01-01',profile:'codex-live',maxCalls:1,maxDurationMs:120000});
  // 先生成待执行任务，再改变共享 profile。重试必须仍使用已冻结的有效模型。
  await transcriptCommand(dataDir,'run',{id:instance.id,maxCalls:0});
  app=await openApplication(dataDir);
  try { await app.plugins.execute('agent profile set',{id:'codex-live',model:'not-a-real-model-for-freeze-verification'}); }
  finally { await app.close(); }
  const run = await transcriptCommand(dataDir,'retry',{id:instance.id,maxCalls:1});
  assert.equal(run.saved,1);assert.equal(run.remaining,0);
  const again=await transcriptCommand(dataDir,'run',{id:instance.id,maxCalls:1});
  assert.equal(again.calls,0);assert.equal(again.saved,0);
  app=await openApplication(dataDir,{readOnly:true});
  try {
    const organization=await app.manager.getOrganization(instance.id);
    const entry=organization.data.entries[0];
    const resource=await app.manager.getResource(entry.resourceId);
    const content=(await app.manager.readContent(resource.id)).toString('utf8');
    assert(content.includes('/health') && content.includes('4317') && content.includes('200'));
    assert(/未部署|尚未部署/.test(content));
    const meta=resource.plugins.transcripts.data;
    assert.equal(meta.model.providerId,'codex-cli');assert.equal(meta.model.model,model);
    assert(meta.usage.totalTokens > 0);assert(meta.elapsedMs > 0);
    await writeFile(evidence,JSON.stringify({passed:true,source:'synthetic-only',readiness,connection,run,idempotent:again,requestedModel:model,actualModelReported:Boolean(meta.model.actualModel),frozenModelVerified:true,summary:content,usage:meta.usage,elapsedMs:meta.elapsedMs},null,2));
    console.log(JSON.stringify({passed:true,model,summary:content,usage:meta.usage,elapsedMs:meta.elapsedMs}));
  } finally {await app.close();}
} finally {await rm(root,{recursive:true,force:true});}
