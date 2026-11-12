import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { openApplication } from '../../dist/index.js';
import { createPreviewServer } from '../../dist/preview/server.js';

// 显式指定资料库，所有入口均只读；截图与核验结果写到独立证据目录。
const dataDir=process.env.KB_BROWSER_DATA_DIR;
if(!dataDir)throw new Error('请显式设置KB_BROWSER_DATA_DIR，只读验收现有资料库');
const evidence=resolve(process.env.KB_BROWSER_EVIDENCE ?? 'artifacts/verification/v0.0.4/real-library');
await mkdir(evidence,{recursive:true});
async function fingerprint(){const result=[];for(const folder of ['resources','metadata','organizations']){async function scan(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())await scan(file);else result.push(file+':'+createHash('sha256').update(await readFile(file)).digest('hex'));}}await scan(join(dataDir,folder));}return result.sort().join('\n');}
const before=await fingerprint();
let server, browser, projectServer;
const failures=[];
try {
  server=await createPreviewServer({app:await openApplication(dataDir,{readOnly:true}),dataDir,webDir:resolve('dist/web')});
  browser=await chromium.launch({executablePath:process.env.KB_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>failures.push(e.message));
  const tags=(await (await fetch(server.url+'/api/browse/collections?type=tag')).json()).data.items;
  const byName=name=>{const item=tags.find(t=>t.name===name);assert.ok(item,name);return item.id;};
  async function navigate(params){await page.goto(server.url+'/#browse?'+new URLSearchParams(params));await page.locator('.organization-browser').waitFor();}
  await navigate({type:'tag',id:byName('png压缩')});await page.locator('.browse-document').nth(3).waitFor();assert.equal(await page.locator('.browse-document').count(),4);
  await page.screenshot({path:join(evidence,'png-documents.png'),fullPage:true});
  await page.locator('.browse-document').first().click();await page.locator('.browse-detail article').waitFor();const hash=await page.evaluate(()=>location.hash);await page.reload();await page.locator('.browse-detail article').waitFor();assert.equal(await page.evaluate(()=>location.hash),hash);
  await navigate({type:'tag',id:byName('游戏架构')});await page.locator('.browse-document').nth(4).waitFor();assert.equal(await page.locator('.browse-document').count(),5);
  await page.getByLabel('组织方式',{exact:true}).selectOption('keyword');await page.getByLabel('搜索组织条目').fill('字段投影');await page.getByLabel('搜索组织条目').press('Enter');await page.locator('.collection-row').filter({hasText:'字段投影'}).click();await page.locator('.browse-document').waitFor();assert.equal(await page.locator('.browse-document').count(),1);
  await page.locator('.browse-document').click();await page.locator('.browse-detail article').waitFor();await page.screenshot({path:join(evidence,'keyword-reading.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(evidence,'mobile-reading.png'),fullPage:true});await page.getByRole('button',{name:'返回上一级'}).click();await page.locator('.browse-documents').waitFor({state:'visible'});
  await page.setViewportSize({width:1600,height:1000});
  const multi=new URLSearchParams({type:'tag',tagMatch:'all'});multi.append('id',byName('游戏架构'));multi.append('id',byName('面向agent游戏架构'));await page.goto(server.url+'/#browse?'+multi);await page.locator('.browse-document').nth(4).waitFor();assert.equal(await page.locator('.browse-document').count(),5);
  await page.goBack();await page.locator('.browse-detail article').waitFor();
  const projectManifest=process.env.KB_BROWSER_PROJECT_MANIFEST;
  let historical=false;
  if(projectManifest){
    const m=JSON.parse(await readFile(projectManifest,'utf8'));
    projectServer=await createPreviewServer({app:await openApplication(m.dataDir,{readOnly:true}),dataDir:m.dataDir,webDir:resolve('dist/web')});
    await page.goto(projectServer.url+'/#browse?'+new URLSearchParams({type:'project-development-tracking',id:m.projectId,entry:m.entries.pinnedHistory}));
    await page.waitForFunction(()=>location.hash==='#browse?type=session-transcript');
    assert.equal(await page.getByLabel('组织方式',{exact:true}).locator('option[value="project-development-tracking"]').count(),0);
    const result=await (await fetch(projectServer.url+`/api/project-tracking/${m.projectId}/entries/${m.entries.pinnedHistory}`)).json();
    assert.equal(result.ok,true);
    assert.equal(result.data.entry.contentVersion,1);
    historical=true;
  }
  assert.deepEqual(failures,[]);assert.equal(await fingerprint(),before);
  await writeFile(join(evidence,'result.json'),JSON.stringify({passed:true,checks:{pngDocuments:4,architectureDocuments:5,keywordPhrase:true,multiTagAll:5,reload:true,back:true,mobile:true,historical,formalFilesUnchanged:true,pageErrors:failures}},null,2));
  console.log(JSON.stringify({passed:true,evidence}));
}finally{await browser?.close();await server?.close();await projectServer?.close();}
