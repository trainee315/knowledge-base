import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { handlePreview } from '../dist/preview/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'kb-preview-first-use-'));
const dataDir = join(root, '尚不存在的中文 数据根');
let browser;
let started;
const execute = promisify(execFile);
async function command(operation) {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('../dist/cli/main.js', import.meta.url)), 'preview', operation, '--data-dir', dataDir, '--json'], { windowsHide: true });
  const result = JSON.parse(stdout); assert.equal(result.ok, true, stdout); return result.data;
}
try {
  const before = await command('status');
  assert.equal(before.running, false);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  started = await command('start');
  assert.equal(started.running, true);
  assert.deepEqual(await readdir(dataDir), ['.runtime']);
  assert.equal((await command('status')).pid, started.pid);
  const resources = await (await fetch(started.url + '/api/resources')).json();
  assert.equal(resources.ok, true); assert.equal(resources.data.total, 0);
  const kinds = await (await fetch(started.url + '/api/organization-types')).json();
  assert.deepEqual(kinds.data, []);
  browser = await chromium.launch({ executablePath: process.env.KB_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(started.url);
  await page.getByText('还没有匹配的资源', { exact: true }).waitFor();
  await page.getByText('0–0 / 0', { exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('./preview/empty-library.png', import.meta.url)), fullPage: true });
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  assert.equal((await command('stop')).running, false);
  assert.equal((await command('status')).running, false);
  assert.deepEqual(await readdir(dataDir), ['.runtime']);
  const result = { passed: true, nonexistentBefore: true, emptyApi: true, emptyBrowser: true, formalDataCreated: false, stopped: true };
  await writeFile(new URL('./preview/first-use-result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (started) await handlePreview(['stop'], dataDir);
  await rm(root, { recursive: true, force: true });
}
