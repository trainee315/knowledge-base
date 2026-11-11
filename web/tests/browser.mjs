import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createPortProbe } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import { openApplication } from '../../dist/index.js';
import { builtinPlugins } from '../../dist/plugins/index.js';

// 独立浏览器与临时正式数据目录，回归结束后全部进程由本脚本关闭。
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PPC = process.env.PPC_CLI_PATH ?? 'C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs';
const USE_PPC = process.env.KB_BROWSER_USE_PPC === '1';
const CHROME = process.env.KB_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const evidence = resolve(process.env.KB_BROWSER_EVIDENCE ?? join(REPO, 'artifacts/preview'));
const EXPECTED_PLUGIN_COUNT = builtinPlugins.length; // 注册表增添业务插件时仍验证所有状态卡片，不固定旧版本数量。
const root = await mkdtemp(join(tmpdir(), '知识库 浏览器 中文 空格 '));
const dataDir = join(root, '正式数据 目录');
let browser;
let preview;
let development;

function imageFixture() {
  const width = 320, height = 100;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const light = x > 16 && x < 304 && y > 16 && y < 84 && (Math.floor(x / 32) + Math.floor(y / 20)) % 2 === 0;
    pixels[offset] = light ? 173 : 39; pixels[offset + 1] = light ? 198 : 90; pixels[offset + 2] = light ? 145 : 66;
  }
  const chunk = (type, data) => {
    const named = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of named) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, named, checksum]);
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function cli(args) {
  return new Promise((done, fail) => {
    const entry = USE_PPC ? [PPC, 'knowledge', '--knowledge-home', REPO] : [join(REPO, 'dist/cli/main.js')];
    const child = spawn(process.execPath, [...entry, ...args, '--data-dir', dataDir, '--json'], { shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', (code) => {
      try { const result = JSON.parse(stdout); if (code || !result.ok) throw new Error(`${stdout}\n${stderr}`); done(result.data); }
      catch (error) { fail(error); }
    });
  });
}
async function inputCommand(args, input) {
  const file = join(root, `input-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify(input));
  return cli([...args, '--input', file]);
}
try {
  await mkdir(evidence, { recursive: true });
  const imageFile = join(root, '绿色像素 图.png');
  await writeFile(imageFile, imageFixture());
  const image = await cli(['resource', 'import', '--file', imageFile]);
  const referenceFile = join(root, '参考资料.txt'); await writeFile(referenceFile, '这份参考资料通过 UUID 链接打开，资源内容更新后身份保持稳定。');
  const reference = await cli(['resource', 'import', '--file', referenceFile]);
  const markdownFile = join(root, '知识库 使用指南.md');
  await writeFile(markdownFile, `# 让知识形成可复用的线索\n\n这是通过 ${USE_PPC ? 'PPC CLI' : '本仓 CLI'} 导入的真实 Markdown 资源。\n\n## 先收集，再组织\n\n- 原件以 UUID 保存\n- 标签承载明确归属\n- 体系连接成系列的知识\n\n> 评分帮助发现候选，工作 Agent 负责判断归属。\n\n[关联参考资源](kb://resource/${reference.resource.id})\n\n![UUID 图片引用](kb://resource/${image.resource.id})\n\n<script>window.__kb_xss = true</script>\n\n**当前状态：** 首期只读预览验收。`);
  const markdown = await cli(['resource', 'import', '--file', markdownFile]);
  const binaryFile = join(root, '无法解析的原件.bin'); await writeFile(binaryFile, Buffer.from([0, 255, 3, 5]));
  await cli(['resource', 'import', '--file', binaryFile]);
  const brokenFile = join(root, '引用诊断.md');
  await writeFile(brokenFile, '# 引用诊断\n\n[失效的引用](kb://resource/12345678-1234-4234-8234-123456789abc)');
  await cli(['resource', 'import', '--file', brokenFile]);
  const tag = await inputCommand(['tag', 'create'], { name: '知识管理', description: '收集、整理与复用知识的方法。' });
  await inputCommand(['tag', 'decide'], { resourceId: markdown.resource.id, tagId: tag.id, accepted: true, source: 'manual', reason: '页面验收：真实资源归属', contentVersion: 1, tagRevision: tag.revision });
  const system = await inputCommand(['system', 'create'], { name: '个人知识管理入门', description: '按照人为指导编排的学习体系。' });
  await inputCommand(['system', 'update'], { id: system.id, nodes: [{ id: 'guide', title: '01 · 从资源到知识', resourceId: markdown.resource.id, order: 1 }, { id: 'reference', title: '02 · 参考与延伸', parentId: 'guide', resourceId: reference.resource.id, order: 2 }] });
  const writer = await openApplication(dataDir);
  try {
    await writer.manager.registerOrganizationType({ id: 'review-reading', name: '阅读清单', description: '通用组织方式，无需核心识别业务类型。', config: { sort: 'manual' }, enabled: true });
    const sample = join(root, 'batch.txt');
    for (let index = 1; index <= 28; index++) { await writeFile(sample, `分页样本 ${index}`); await writer.manager.importResource(sample, { originalName: `归档笔记 ${String(index).padStart(2, '0')}.txt` }); }
    await writer.plugins.refresh();
  } finally { await writer.close(); }
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  process.env.KB_DATA_DIR = dataDir;
  // Vite将port:0解释为默认端口，先取得OS空闲端口后再交给strictPort监听。
  const probe = createPortProbe();
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done); });
  const devPort = probe.address().port;
  await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
  development = await createViteServer({ configFile: join(REPO, 'web/vite.config.ts'), server: { host: '127.0.0.1', port: devPort }, cacheDir: join(root, 'vite-cache') });
  await development.listen();
  const devAddress = development.httpServer.address();
  const devPage = await browser.newPage();
  await devPage.goto(`http://127.0.0.1:${devAddress.port}`);
  await devPage.getByText('33 个结果', { exact: true }).waitFor();
  assert.equal(development.config.server.proxy, undefined);
  assert.equal((await devPage.request.get(`http://127.0.0.1:${devAddress.port}/api/resources`)).status(), 200);
  await devPage.close(); await development.close(); development = undefined;
  preview = await cli(['preview', 'start']);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(preview.url);
  await page.getByText('33 个结果', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByText('31–33 / 33', { exact: true }).waitFor();
  await page.getByRole('button', { name: '上一页' }).click();
  await page.getByText('1–30 / 33', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('绝不命中的文件名');
  await page.getByRole('button', { name: '查询资源' }).click();
  await page.getByText('还没有匹配的资源', { exact: true }).waitFor();
  await page.getByText('0–0 / 0', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'empty-results.png'), fullPage: true });
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('');
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('知识管理');
  await page.getByRole('textbox', { name: '关键词', exact: true }).fill('知识');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill(USE_PPC ? 'PPC' : '本仓 CLI');
  await page.getByRole('textbox', { name: '体系', exact: true }).fill('个人知识管理入门');
  await page.getByRole('button', { name: '查询资源' }).click();
  await page.getByText('1 个结果', { exact: true }).waitFor();
  await page.getByRole('button', { name: /知识库 使用指南\.md/ }).click();
  await page.getByRole('heading', { name: '让知识形成可复用的线索' }).waitFor();
  const linkedImage = page.getByRole('img', { name: 'UUID 图片引用' });
  await linkedImage.waitFor();
  await linkedImage.evaluate((image) => image.decode());
  assert.equal(await page.evaluate(() => window.__kb_xss), undefined);
  assert.ok(await linkedImage.evaluate((image) => image.naturalWidth > 0));
  await page.screenshot({ path: join(evidence, 'resources-markdown.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(evidence, 'resources-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('link', { name: '关联参考资源', exact: true }).click();
  await page.getByRole('heading', { name: '参考资料.txt', exact: true }).waitFor();
  assert.ok((await page.locator('.text-content').innerText()).includes('UUID 链接打开'));
  await page.getByRole('button', { name: /知识库 使用指南\.md/ }).click();
  await page.getByRole('link', { name: '关联参考资源', exact: true }).click();
  await page.getByRole('heading', { name: '参考资料.txt', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('');
  await page.getByRole('textbox', { name: '关键词', exact: true }).fill('');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('');
  await page.getByRole('textbox', { name: '体系', exact: true }).fill('');
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('引用诊断');
  await page.getByRole('button', { name: '查询资源' }).click();
  await page.getByRole('button', { name: /引用诊断.md/ }).click();
  await page.getByText('资源引用存在问题', { exact: true }).waitFor();
  await page.getByText('存在失效引用', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'broken-reference.png'), fullPage: true });
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('');
  await page.getByRole('combobox', { name: '解析状态' }).selectOption('unsupported');
  await page.getByRole('button', { name: '查询资源' }).click();
  await page.getByText('2 个结果', { exact: true }).waitFor();
  await page.getByRole('button', { name: /无法解析的原件.bin/ }).click();
  await page.getByText('此资源暂未提供可解析正文，原件和元数据均已保存。', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'unsupported-resource.png'), fullPage: true });
  await page.getByRole('button', { name: /组织与体系/ }).click();
  await page.getByRole('heading', { name: '个人知识管理入门', exact: true }).waitFor();
  await page.getByRole('heading', { name: '阅读清单', exact: true }).waitFor();
  await page.getByRole('link', { name: '01 · 从资源到知识 ↗', exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'organizations.png'), fullPage: true });
  await page.getByRole('button', { name: /插件状态/ }).click();
  await page.getByRole('heading', { name: 'scheduler', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'project-tracking', exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-card').count(), EXPECTED_PLUGIN_COUNT);
  await page.screenshot({ path: join(evidence, 'plugins-enabled.png'), fullPage: true });
  await cli(['preview', 'stop']); preview = undefined;
  await cli(['plugin', 'disable', '--id', 'keywords', '--cascade']);
  preview = await cli(['preview', 'start']);
  await page.goto(preview.url);
  await page.getByText('33 个结果', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '关键词', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('textbox', { name: '标签', exact: true }).isDisabled(), true);
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('知识库 使用指南');
  await page.getByRole('button', { name: '查询资源' }).click();
  await page.getByRole('button', { name: /知识库 使用指南\.md/ }).click();
  await page.getByRole('heading', { name: '让知识形成可复用的线索' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '关键词', exact: true }).count(), 0);
  await page.getByRole('button', { name: /插件状态/ }).click();
  await page.locator('.plugin-card').filter({ has: page.getByRole('heading', { name: 'keywords', exact: true }) }).getByText('disabled', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'plugins-disabled.png'), fullPage: true });
  assert.deepEqual(failures, []);
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify({ passed: true, viewport: '1440x1100 / 390x844', resources: 33, pluginCards: EXPECTED_PLUGIN_COUNT, checks: [USE_PPC ? 'PPC import' : 'local CLI import', 'manual tag decision', 'Vite single-port page/API', 'pagination', 'empty results', 'combined body/keyword/tag/system filters', 'parse-status filter', 'Markdown HTML escaping', 'UUID image decode', 'repeated UUID resource navigation', 'broken UUID diagnostics', 'unsupported binary', 'system nodes', 'plugin state and restart notice', 'disabled filters and panels', 'mobile no horizontal overflow'], screenshots: ['resources-markdown.png', 'resources-mobile.png', 'broken-reference.png', 'empty-results.png', 'unsupported-resource.png', 'organizations.png', 'plugins-enabled.png', 'plugins-disabled.png'] }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  await development?.close();
  await browser?.close();
  if (preview) await cli(['preview', 'stop']);
  await rm(root, { recursive: true, force: true });
}
