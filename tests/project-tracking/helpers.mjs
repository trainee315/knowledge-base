import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { CoreManager, PluginHost } from '../../dist/index.js';
import { builtinPlugins } from '../../dist/plugins/index.js';

// 独立验证进程只做本地文件操作；任何意外fetch在本机拒绝，不读取真实密钥。
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Project-tracking verification forbids external requests'); };
export const getNetworkAttempts = () => networkAttempts;
export const digest = (value) => createHash('sha256').update(value).digest('hex');

/** 全部正式业务写入走公开manager/插件接口；仅名称误导与future schema场景离线修改夹具。 */
export async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'kb-project-tracking-independent-'));
  const canonical = await realpath(root);
  const dataDir = join(root, 'data');
  let manager, host, captured;
  const harness = {
    root, dataDir,
    get manager() { return manager; }, get host() { return host; }, get apis() { return captured; },
    get project() { return captured.project; },
    async open(readOnly = false) {
      assert.equal(manager, undefined); captured = {};
      manager = await CoreManager.open(dataDir, { readOnly });
      const probe = { manifest: { id: 'project-tracking-verification', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { content: '*', keywords: '*', 'project-tracking': '*' } }, async load(context) { captured.content = context.getDependency('content'); captured.keywords = context.getDependency('keywords'); captured.project = context.getDependency('project-tracking'); return {}; } };
      host = new PluginHost(manager, [...builtinPlugins, probe]);
      try { await host.start(); } catch (error) { await manager.close(); manager = undefined; host = undefined; throw error; }
      return harness;
    },
    async close() { const currentHost = host, currentManager = manager; host = undefined; manager = undefined; try { await currentHost?.stop(); } finally { await currentManager?.close(); } },
    async run(name, input = {}) { return host.execute(`project-track ${name}`, input, []); },
    async source(filename, bytes) { assert.equal(filename, basename(filename)); const directory = join(root, 'sources'); await mkdir(directory, { recursive: true }); const path = join(directory, filename); await writeFile(path, bytes); return path; },
    async import(filename, bytes) { return (await manager.importResource(await harness.source(filename, bytes))).resource; },
    async renameCurrentFixture(resourceId, originalName) {
      await harness.close();
      const file = join(dataDir, 'metadata', `${resourceId}.meta`);
      const value = JSON.parse(await readFile(file, 'utf8')); value.originalName = originalName;
      await writeFile(file, JSON.stringify(value, null, 2) + '\n');
      return harness.open();
    },
    async cleanup() {
      await harness.close();
      const scope = relative(await realpath(tmpdir()), canonical);
      assert.ok(scope && !scope.startsWith('..') && !isAbsolute(scope) && basename(root).startsWith('kb-project-tracking-independent-'));
      assert.equal(await realpath(root), canonical); await rm(root, { recursive: true, force: true });
      assert.equal(networkAttempts, 0, 'No model/network request is allowed in project tests');
    },
  };
  return harness.open();
}

export async function libraryFingerprint(dataDir) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.writer.lock' || entry.name === '.runtime') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push([relative(dataDir, path).replaceAll('\\', '/'), digest(await readFile(path))]);
    }
  };
  await walk(resolve(dataDir)); return files.sort((left, right) => left[0].localeCompare(right[0]));
}
