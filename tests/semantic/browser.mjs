import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { handleService } from '../../dist/service/client.js';
const {dataDir,tagId}=JSON.parse(await readFile('.runtime/v0011-live.json','utf8'));
let browser;const errors=[];const evidence='artifacts/verification/v0.0.11';
try {
 const service=await handleService(['start','--port','0'],dataDir);
 browser=await chromium.launch({executablePath:process.env.KB_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(service.url+'/#browse?type=tag&id='+tagId);
 await page.getByRole('heading',{name:'性能优化',exact:true}).waitFor();
 await page.locator('.semantic-hit').filter({hasText:'render.md'}).click();await page.locator('.semantic-original').waitFor();assert((await page.locator('.semantic-original').innerText()).includes('第 1'));
 await page.getByRole('button',{name:'关键词',exact:true}).click();await page.locator('.semantic-words button').first().waitFor();await page.locator('.semantic-words button').first().click();await page.locator('.semantic-hit').first().waitFor();
 await page.getByRole('button',{name:'新增标签',exact:true}).click();await page.getByLabel('标签名称',{exact:true}).fill('资源加载');await page.getByLabel('含义说明（可选）',{exact:true}).fill('游戏纹理资源加载与性能优化');await page.getByRole('button',{name:'保存并开始匹配'}).click();await page.getByRole('heading',{name:'资源加载',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.semantic-results .semantic-toolbar small')?.textContent?.includes('已更新'),null,{timeout:30000});
 await page.getByRole('button',{name:'重新匹配',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.semantic-results .semantic-toolbar small')?.textContent?.includes('已更新')&&!document.querySelector('.semantic-results .semantic-toolbar button')?.disabled);
 await page.screenshot({path:evidence+'/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除标签 资源加载',exact:true}).click();await page.getByRole('button',{name:'删除标签 资源加载',exact:true}).waitFor({state:'detached'});
 await page.reload();await page.getByRole('heading',{name:'标签',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'删除标签 资源加载',exact:true}).count(),0);assert.deepEqual(errors,[]);
 await writeFile(evidence+'/browser.json',JSON.stringify({desktop:'1440x1000',mobile:'390x844',checks:['browse-documents','original-location','keyword-to-fragment','create-and-auto-match','rematch','delete-and-reload','mobile-no-overflow'],pageErrors:errors},null,2));console.log('semantic browser workflow passed');
}finally{await browser?.close();await handleService(['stop'],dataDir);}
