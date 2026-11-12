import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CoreManager, openApplication } from '../../dist/index.js';
import { preloadEnvironment, serviceCli } from '../../tests/service-cli.mjs';

const root = await mkdtemp(join(tmpdir(), 'kb-plugin-details-'));
const canonicalRoot = await realpath(root);
const dataDir = join(root, 'data');
const evidence = process.env.KB_PLUGIN_BROWSER_EVIDENCE
  ? resolve(process.env.KB_PLUGIN_BROWSER_EVIDENCE) : await mkdtemp(join(tmpdir(), 'kb-plugin-detail-evidence-'));
const counter = join(root, 'blocked-requests.txt');
const env = preloadEnvironment(new URL('../../tests/agent/offline-fetch.mjs', import.meta.url), { ...process.env, KB_OFFLINE_COUNTER_FILE: counter });
const cli = (words, input) => serviceCli(dataDir, words, { env, input });
const failures = [];
let service;
let browser;

try {
  await mkdir(evidence, { recursive: true });
  await writeFile(counter, '');
  const fixture = await openApplication(dataDir);
  try {
    for (let ordinal = 1; ordinal <= 21; ordinal++) {
      const name = '样例资源 ' + String(ordinal).padStart(2, '0') + '.md';
      const path = join(root, name);
      await writeFile(path, '# 样例正文 ' + ordinal);
      await fixture.manager.importResource(path);
    }
    await fixture.plugins.refresh();
  } finally { await fixture.close(); }
  service = cli(['service', 'start']);
  browser = await chromium.launch({ executablePath: process.env.KB_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => failures.push(error.message));
  const byTab = name => page.getByRole('link', { name, exact: true });
  const path = (id, view, query = {}) => service.url + '/#plugins?' + new URLSearchParams({ id, view, ...query });
  const open = async (id, view = 'overview', query) => {
    await page.goto(path(id, view, query));
    await page.locator('.plugin-title h2').waitFor();
  };

  await page.goto(service.url + '/#plugins');
  await page.getByRole('link', { name: '查看 cron 详情' }).waitFor();
  const pluginIds = await page.locator('.plugin-card h2').allTextContents();
  assert.ok(pluginIds.length >= 12);
  for (const id of pluginIds) {
    await page.getByRole('link', { name: '查看 ' + id + ' 详情' }).click();
    await page.locator('.plugin-title h2').waitFor();
    assert.match(await page.locator('.plugin-surface').innerText(), /维护中的数据/);
    await page.getByRole('link', { name: /返回插件列表/ }).click();
    await page.getByRole('link', { name: '查看 ' + id + ' 详情' }).waitFor();
  }

  await open('project-tracking', 'config');
  await page.getByText('请先创建Session转录实例，再配置压缩模式。', { exact: true }).waitFor();
  const alpha = cli(['transcript', 'create'], { alias: '压缩模式甲', startDate: '2026-01-01', sourceRoot: root });
  const beta = cli(['transcript', 'create'], { alias: '压缩模式乙', startDate: '2026-01-01', sourceRoot: root });
  await open('project-tracking', 'config', { configKey: alpha.id });
  const compression = page.getByLabel('Session压缩模式', { exact: true });
  const instance = page.getByLabel('Session实例');
  assert.equal(await compression.inputValue(), 'conservative');
  assert.equal(await page.locator('.plugin-mode-help li').count(), 3);
  await page.getByText(/各模式均以原始路径替换二进制和编码载荷/).waitFor();
  await compression.selectOption('off');
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('配置已保存', { exact: true }).waitFor();
  assert.equal(cli(['transcript', 'get'], { id: alpha.id }).data.config.preprocessing, 'off');
  await compression.selectOption('conservative');
  await page.getByRole('button', { name: '取消修改' }).click();
  assert.equal(await compression.inputValue(), 'off');
  await compression.selectOption('aggressive');
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('配置已保存', { exact: true }).waitFor();
  await page.reload();
  await compression.waitFor();
  assert.equal(await compression.inputValue(), 'aggressive');
  assert.equal(cli(['transcript', 'get'], { id: alpha.id }).data.config.preprocessing, 'aggressive');
  await compression.selectOption('off');
  page.once('dialog', dialog => dialog.dismiss());
  await instance.selectOption(beta.id);
  assert.equal(await instance.inputValue(), alpha.id);
  assert.equal(await compression.inputValue(), 'off');
  await page.getByRole('button', { name: '取消修改' }).click();
  await instance.selectOption(beta.id);
  await page.waitForURL(new RegExp('configKey=' + beta.id));
  await page.waitForFunction(() => document.querySelector('[aria-label="Session压缩模式"]')?.value === 'conservative');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[aria-label="Session压缩模式"]')?.value === 'aggressive');
  await page.goForward();
  await page.waitForFunction(() => document.querySelector('[aria-label="Session压缩模式"]')?.value === 'conservative');
  await page.setViewportSize({ width: 390, height: 844 });
  await compression.selectOption('aggressive');
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('配置已保存', { exact: true }).waitFor();
  assert.equal(cli(['transcript', 'get'], { id: beta.id }).data.config.preprocessing, 'aggressive');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(evidence, 'session-compression-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open('project-tracking', 'config', { configKey: alpha.id });
  await compression.waitFor();
  await page.screenshot({ path: join(evidence, 'session-compression.png'), fullPage: true });

  await open('content');
  await byTab('配置').click();
  await page.getByText('此插件没有独立配置项。', { exact: true }).waitFor();
  await byTab('维护中的数据').click();
  await page.getByRole('link', { name: '下一页' }).waitFor();
  assert.equal(await page.locator('.plugin-rows li').count(), 20);
  await page.getByRole('link', { name: '下一页' }).click();
  await page.waitForURL(/offset=20/);
  await page.getByText('21–21 / 21', { exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-rows li').count(), 1);
  await page.reload();
  await page.getByText('21–21 / 21', { exact: true }).waitFor();
  await page.locator('.plugin-rows li a').click();
  await page.waitForURL(/#resource\//);
  await page.locator('.detail-name').waitFor();
  await page.goBack();
  await page.getByText('21–21 / 21', { exact: true }).waitFor();
  assert.match(page.url(), /offset=20/);
  await page.goBack();
  await page.getByRole('link', { name: '下一页' }).waitFor();
  await page.goForward();
  await page.getByRole('link', { name: '上一页' }).waitFor();

  await open('relations', 'data');
  await page.getByText('当前集合没有可显示的记录。', { exact: true }).waitFor();
  await byTab('配置').click();
  const version = page.getByLabel('评分逻辑版本');
  const batch = page.getByLabel('最大批量');
  await version.fill('browser-candidate');
  page.once('dialog', dialog => dialog.dismiss());
  await byTab('简介').click();
  await page.waitForURL(/view=config/);
  assert.equal(await version.inputValue(), 'browser-candidate');
  cli(['relation', 'configure'], { maxBatchSize: 7 });
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByRole('alert').getByText(/当前草稿已保留/).waitFor();
  assert.equal(await version.inputValue(), 'browser-candidate');
  await page.getByRole('button', { name: '查看最新配置' }).click();
  await page.getByRole('button', { name: '以最新版本为基准保留草稿' }).click();
  assert.equal(await batch.inputValue(), '7');
  assert.equal(await version.inputValue(), 'browser-candidate');
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('配置已保存', { exact: true }).waitFor();
  const relation = cli(['relation', 'get-config']);
  assert.equal(relation.scoringLogicVersion, 'browser-candidate');
  assert.equal(relation.maxBatchSize, 7);

  await open('agent', 'config');
  const configNames = await page.locator('.plugin-fields label').allTextContents();
  assert.equal(configNames.some(name => /凭证/.test(name)), false);
  await open('scheduler', 'config');
  await byTab('打开配置页面 →').click();
  await page.getByRole('heading', { name: '调度计划' }).waitFor();
  await page.getByRole('button', { name: '新建计划' }).click();
  await page.getByLabel('间隔（分钟）').fill('9');
  await page.getByLabel('最多模型调用数').fill('0');
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.getByText('计划已保存', { exact: true }).waitFor();
  const [job] = cli(['cron', 'list']).items;
  assert.equal(job.enabled, false);
  assert.equal(job.schedule.minutes, 9);
  await page.getByRole('button', { name: '编辑计划' }).click();
  await page.getByLabel('周期类型').selectOption('cron');
  await page.getByRole('textbox', { name: 'Cron 表达式', exact: true }).fill('0 3 * * *');
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.getByText(/0 3 \* \* \*/).waitFor();
  assert.equal(cli(['cron', 'get', '--id', job.id]).schedule.kind, 'cron');
  await page.getByRole('button', { name: '启用计划' }).click();
  await page.getByRole('button', { name: '停用计划' }).click();
  await page.getByText('计划已停用', { exact: true }).waitFor();
  assert.equal(cli(['cron', 'get', '--id', job.id]).enabled, false);
  await page.screenshot({ path: join(evidence, 'cron-plans.png'), fullPage: true });
  cli(['cron', 'run', '--id', job.id]);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除计划' }).click();
  await page.getByText('计划已删除', { exact: true }).waitFor();
  await byTab('查看运行历史').click();
  await page.locator('.plugin-rows li').first().waitFor();
  assert.equal(cli(['cron', 'list']).total, 0);
  assert.ok(cli(['cron', 'runs']).total >= 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await open('relations', 'config');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(evidence, 'mobile-config.png'), fullPage: true });
  cli(['plugin', 'disable', '--id', 'cron']);
  await open('cron', 'config');
  await page.locator('.plugin-title .status').filter({ hasText: '已停用' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新建计划' }).count(), 0);
  await byTab('维护中的数据').click();
  await page.getByLabel('数据集合').selectOption('runs');
  await page.locator('.plugin-rows li').first().waitFor();

  const manager = await CoreManager.open(dataDir);
  try {
    const store = manager.pluginStore('core-host');
    const state = await store.read('state', {});
    await store.write('state', { ...state, failure: { pluginId: 'relations', phase: 'refresh', message: 'SYNTHETIC_PRIVATE_FAILURE', at: new Date().toISOString() } });
  } finally { await manager.close(); }
  await open('relations', 'config');
  await page.locator('.plugin-title .status').filter({ hasText: '加载失败' }).waitFor();
  await page.getByRole('alert').getByText(/插件刷新失败/).waitFor();
  assert.equal(await page.getByText('SYNTHETIC_PRIVATE_FAILURE').count(), 0);
  assert.ok(await page.getByLabel('评分逻辑版本').isDisabled());
  assert.deepEqual(failures, []);
  assert.equal(await readFile(counter, 'utf8'), '');
  const checks = ['all plugin overviews', 'no independent config', 'pagination and deep links', 'back and forward', 'empty collection', 'draft guard', 'conflict compare and rebase', 'CLI configuration interoperability', 'session compression three modes and descriptions', 'session selection and saved URL', 'compression cancel and draft guard', 'compression CLI readback and mobile save', 'cron create/edit/enable/disable/delete', 'history after deletion', 'disabled and failed details', 'mobile layout'];
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, plugins: pluginIds.length, checks, externalRequests: 0, failures }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  await browser?.close();
  if (service) cli(['service', 'stop']);
  assert.equal(await realpath(root), canonicalRoot);
  assert.equal(dirname(canonicalRoot), await realpath(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
