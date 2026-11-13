import assert from 'node:assert/strict';
import {mkdir,cp,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {openApplication} from '../../dist/index.js';
import {changeTag} from '../../dist/semantic/api.js';
import {runSemantic} from '../../dist/semantic/engine.js';
import {handleService} from '../../dist/service/client.js';

assert(process.env.KB_SEMANTIC_MODEL_DIR,'指定本地模型目录 KB_SEMANTIC_MODEL_DIR');
const root=await mkdtemp(path.join(tmpdir(),'kb-quality-browser-')),data=path.join(root,'data');
const evidence='artifacts/verification/v0.0.15';await mkdir(evidence,{recursive:true});let browser;const errors=[];
try {
  const app=await openApplication(data);const file=path.join(root,'Prefab.md');
  await writeFile(file,'# Prefab 节点与组件\n\nPrefab 保存可复用的游戏节点和组件。修改 Prefab 后应检查脚本引用与组件参数。\n');await app.manager.importResource(file);await app.close();
  await cp(process.env.KB_SEMANTIC_MODEL_DIR,path.join(data,'cache/recall-models'),{recursive:true});
  const tag=await changeTag(data,'create',{name:'预制体',aliases:['Prefab'],description:'游戏节点与组件资产'});
  for(let i=0;i<8;i++)if((await runSemantic(data,{maxJobs:20,automatic:false})).complete)break;
  const service=await handleService(['start','--port','0'],data);
  browser=await chromium.launch({executablePath:process.env.KB_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(service.url+'/#browse?type=tag&id='+tag.id);await page.locator('.semantic-hit').first().waitFor();
  assert.match(await page.locator('.semantic-hit').first().innerText(),/别名命中：Prefab/);
  await page.locator('.semantic-hit').first().click();await page.locator('.semantic-original').waitFor();
  await page.getByRole('button',{name:'编辑标签',exact:true}).click();await page.getByLabel('别名（可选）',{exact:true}).fill('Prefab\nPrefabAsset');
  await page.getByLabel('含义说明（可选）',{exact:true}).fill('游戏节点与组件预制资产');await page.getByRole('button',{name:'保存并开始匹配'}).click();
  await page.getByText('别名：Prefab、PrefabAsset',{exact:true}).waitFor();await page.locator('.semantic-hit').first().waitFor();
  await page.getByRole('button',{name:'待核对候选',exact:true}).click();await page.getByText('这些内容可能相关，尚未计入正式匹配或标签筛选。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'片元',exact:true}).click();await page.locator('.semantic-hit').first().waitFor();
  await page.getByRole('button',{name:'关键词',exact:true}).click();await page.locator('.semantic-words button').first().waitFor();await page.locator('.semantic-words button').first().click();await page.locator('.semantic-hit').first().waitFor();
  await page.screenshot({path:evidence+'/tags-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/tags-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.reload();await page.getByRole('heading',{name:'预制体',exact:true}).waitFor();
  assert.deepEqual(errors,[]);await writeFile(evidence+'/browser.json',JSON.stringify({passed:true,checks:['alias-real-match','body-evidence','edit-alias-description','candidate-separation','body-fragments','keyword-drilldown','route-reload','desktop-mobile'],pageErrors:errors},null,2));console.log('v15 semantic browser checks passed');
}finally {
  await browser?.close();await handleService(['stop'],data);
  // 仅清理本次创建、位于系统临时目录中的测试目录。
  assert(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(root).startsWith('kb-quality-browser-'));
  await rm(root,{recursive:true,force:true});
}
