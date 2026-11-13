import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {openApplication} from '../../dist/index.js';
import {CoreManager} from '../../dist/core/manager.js';
import {runSemantic} from '../../dist/semantic/engine.js';
import {createPreviewServer} from '../../dist/preview/server.js';

const root=await mkdtemp(path.join(tmpdir(),'kb-keywords-browser-')),data=path.join(root,'data');
const evidence='artifacts/verification/v0.0.13';await mkdir(evidence,{recursive:true});
let browser,server;const errors=[],requests=[];
try {
  const app=await openApplication(data);
  for(const name of ['AlphaOnly','BetaOnly']){const file=path.join(root,name+'.md');await writeFile(file,`# ${name}\n\n${name} source evidence.\n`);await app.manager.importResource(file);}
  const large=path.join(root,'long.md');await writeFile(large,Array.from({length:110},(_,i)=>`# Term${i}Unique\n\nTerm${i}Unique evidence.\n`).join('\n'));await app.manager.importResource(large);
  await app.plugins.refresh();await app.close();
  const encoder={identity:'browser-fixture',dimensions:3,async encode(texts){return {vectors:texts.map(()=>[1,0,0]),truncated:texts.map(()=>false)};}};
  await runSemantic(data,{encoder,maxJobs:10,automatic:false});
  server=await createPreviewServer({app:await openApplication(data,{readOnly:true}),dataDir:data,webDir:path.resolve('dist/web')});
  browser=await chromium.launch({executablePath:process.env.KB_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/browse/')&&r.url().includes('type=keyword'))requests.push(r.url());});
  await page.goto(server.url);await page.getByRole('button',{name:/组织与体系/}).click();await page.getByLabel('组织方式',{exact:true}).selectOption('keyword');
  await page.locator('.keyword-row').first().waitFor();assert.equal(requests.filter(u=>u.includes('/documents')||u.includes('/fragments')).length,0);
  assert.equal(await page.locator('.keyword-row small,.keyword-row span').count(),0);
  await page.getByLabel('搜索关键词',{exact:true}).fill('AlphaOnly');await page.locator('.keyword-list form').getByRole('button',{name:'搜索',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.keyword-row')?.textContent?.includes('AlphaOnly')&&!document.querySelector('.keyword-list')?.getAttribute('aria-busy')?.includes('true'));
  await page.locator('.keyword-row').first().click();await page.locator('.keyword-document').first().waitFor();
  assert.equal(requests.filter(u=>u.includes('/fragments')).length,0);
  await page.locator('.keyword-document').first().click();await page.locator('.keyword-fragment').first().waitFor();assert.match(await page.locator('.keyword-fragment').first().innerText(),/AlphaOnly/);
  await page.reload();await page.locator('.keyword-fragment').first().waitFor();assert.match(await page.locator('.keyword-fragment').first().innerText(),/AlphaOnly/);
  await page.getByRole('button',{name:'阅读文档全文',exact:true}).click();await page.locator('.keyword-fulltext').waitFor();assert.match(await page.locator('.keyword-fulltext').innerText(),/AlphaOnly/);
  await page.screenshot({path:evidence+'/keywords-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/keywords-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.setViewportSize({width:1440,height:1000});
  // 正式数据先变更而索引代次尚未发布时，也必须立即收起旧关联和原文。
  await page.route('**/api/browse/collections?**',async route=>{const response=await route.fetch();const body=await response.json();body.data={...body.data,items:[],total:0,status:{state:'pending',pending:1,failed:0}};await route.fulfill({response,json:body});},{times:1});
  await page.getByRole('button',{name:'刷新关键词',exact:true}).click();await page.getByText('关键词索引待更新，请稍后刷新。',{exact:true}).waitFor();assert.equal(await page.locator('.keyword-fragment,.keyword-document,.keyword-fulltext').count(),0);
  await page.getByRole('button',{name:'刷新关键词',exact:true}).click();await page.locator('.keyword-row').first().waitFor();
  // 延迟请求必须显示加载态，失败不能显示成成功空结果。
  let release;const delayed=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/browse/collections?**',async route=>{await delayed;await route.continue().catch(()=>{});},{times:1});
  await page.getByRole('button',{name:'刷新关键词',exact:true}).click();await page.getByText('正在加载关键词…',{exact:true}).waitFor();assert.equal(await page.getByText('暂无匹配关键词',{exact:true}).count(),0);release();await page.locator('.keyword-row').first().waitFor();
  await page.route('**/api/browse/collections?**',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:{message:'injected keyword failure'}})}),{times:1});
  await page.getByRole('button',{name:'刷新关键词',exact:true}).click();await page.getByText('injected keyword failure',{exact:true}).waitFor();
  await page.getByRole('button',{name:'刷新关键词',exact:true}).click();await page.locator('.keyword-row').first().waitFor();
  // 快速切换取消旧文档请求，迟到响应不得覆盖 BetaOnly。
  await page.getByLabel('搜索关键词',{exact:true}).fill('');await page.locator('.keyword-list form').getByRole('button',{name:'搜索',exact:true}).click();
  await page.locator('.keyword-row').filter({hasText:'BetaOnly'}).first().waitFor();
  let releaseDocuments;const held=new Promise(resolve=>{releaseDocuments=resolve;});
  await page.route('**/api/browse/documents?**',async route=>{await held;await route.continue().catch(()=>{});},{times:1});
  await page.locator('.keyword-row').filter({hasText:'AlphaOnly'}).first().click();await page.getByText('正在加载关联文档…',{exact:true}).waitFor();
  await page.locator('.keyword-row').filter({hasText:'BetaOnly'}).first().click();await page.locator('.keyword-document').filter({hasText:'BetaOnly'}).first().waitFor();releaseDocuments();
  await page.locator('.keyword-document').first().click();await page.locator('.keyword-fragment').first().waitFor();assert.match(await page.locator('.keyword-fragment').first().innerText(),/BetaOnly/);
  await page.goBack();await page.locator('.keyword-document').first().waitFor();
  // 实际资源变更使旧分页失效，页面不保留旧片元。
  const m=await CoreManager.open(data);try{const resources=await m.listResources();await m.deleteResource(resources.find(x=>x.resource.originalName==='BetaOnly.md').resource.id);}finally{await m.close();}
  await runSemantic(data,{encoder,maxJobs:10,automatic:false});
  await page.getByRole('button',{name:'刷新关键词',exact:true}).click();await page.locator('.keyword-list[aria-busy="false"]').waitFor();assert.equal(await page.locator('.keyword-fragment').count(),0);
  assert.deepEqual(errors,[]);
  await writeFile(evidence+'/keywords-browser.json',JSON.stringify({passed:true,checks:['real-organization-selector','list-only-words','lazy-documents','lazy-fragments','lazy-fulltext','hash-restore','desktop-mobile','pending-hides-old-content','loading-not-empty','failure-retry','cancel-stale-response','back-navigation','generation-invalidation'],keywordRequests:requests.length,pageErrors:errors},null,2));
  console.log('keyword browser workflow passed');
}finally{await browser?.close();await server?.close();await rm(root,{recursive:true,force:true});}
