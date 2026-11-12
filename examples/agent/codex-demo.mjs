import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serviceCli } from '../../tests/service-cli.mjs';

// 每次创建独立合成库；只检测登录，不自动消耗模型额度。
const model = process.env.KB_CODEX_DEMO_MODEL;
if (!model) throw new Error('请设置 KB_CODEX_DEMO_MODEL 为服务器账号可用的模型 ID');
const base = resolve('.data'); await mkdir(base,{recursive:true});
const root = await mkdtemp(join(base,'v0.0.12-acceptance-'));
const dataDir = join(root,'library'), sourceRoot=join(root,'sessions');
await mkdir(sourceRoot);
const row=(type,payload)=>JSON.stringify({timestamp:'2026-01-01T01:00:00Z',type,payload})+'\n';
await writeFile(join(sourceRoot,'fixture.jsonl'),row('session_meta',{id:'acceptance-synthetic',cwd:root,source:'cli'})+row('event_msg',{type:'task_started'})+row('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'新增 /health 接口，端口 4317，不增加数据库依赖。'}]})+row('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'已实现并验证 HTTP 200，尚未部署。'}]})+row('event_msg',{type:'task_complete'}));
const cli=(words,input)=>serviceCli(dataDir,words,{input});
let started;
try {
  started=cli(['service','start']);
  cli(['agent','profile','set'],{id:'codex-session',providerId:'codex-cli',model,reasoningEffort:'low',timeoutMs:120000,maxTokens:4096});
  const instance=cli(['transcript','create'],{alias:'v0.0.12 合成验收实例',sourceRoot,projectDir:root,startDate:'2026-01-01',profile:'codex-session',maxCalls:1,maxDurationMs:120000});
  const readiness=cli(['agent','check'],{profile:'codex-session'});
  const result={dataDir,instanceId:instance.id,model,readiness,url:started.url,agentUrl:started.url+'#plugins?id=agent&view=config&configKey=codex-session',sessionUrl:started.url+'#plugins?id=project-tracking&view=config&configKey='+instance.id,modelCalls:0};
  await writeFile(join(base,'v0.0.12-acceptance.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  if(started) cli(['service','stop']);
  throw error;
}
