import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, writeFile, readFile, readdir, access, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';
import { openApplication } from '../../dist/index.js';
import { serviceCli } from '../../tests/service-cli.mjs';

const networkFetch = globalThis.fetch;
const fetch = (url, options = {}) => networkFetch(url, { signal: AbortSignal.timeout(5000), ...options });

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// 仅测试合成库；监听使用系统空闲端口，绝不占用或停止用户的开发服务。
const SOURCE_CONFIG = join(REPO, 'web/vite.config.ts').replaceAll('\\', '/');
async function snapshot(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(directory, path));
    else result[path] = (await readFile(join(directory, path))).toString('base64');
  }
  return result;
}
function rawGet(url, headers) {
  return new Promise((done, fail) => {
    request(url, { headers }, (response) => { response.resume(); response.once('end', () => done(response.statusCode)); }).once('error', fail).end();
  });
}

test('Vite proxies the running service on a strict port and leaves its lifecycle independent', async () => {
  // 故意放在仓库内非.data路径，证明不能借Vite默认workspace文件服务旁路下载。
  const root = await mkdtemp(join(REPO, 'web/.dev-integration-'));
  const dataDir = join(root, '中文 (data){a,b}'), missing = join(root, '尚不存在的库');
  const servers = [];
  const running = new Set();
  const canonicalRoot = await realpath(root);
  function start(directory) {
    serviceCli(directory, ['service', 'start']);
    running.add(directory);
  }
  let ordinal = 0;
  async function make(directory, port = 0) {
    if (!port) {
      const probe = createPortProbe();
      await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done); });
      port = probe.address().port;
      await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
    }
    const configFile = join(root, `vite-${++ordinal}.config.ts`);
    const source = `import base from ${JSON.stringify(SOURCE_CONFIG)};
import {knowledgeApiPlugin} from ${JSON.stringify(join(REPO, 'web/dev-api.ts').replaceAll('\\', '/'))};
export default {...base, plugins:[base.plugins[0], knowledgeApiPlugin({dataDir:${JSON.stringify(directory)}})]};`;
    await writeFile(configFile, source);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile);
    assert.ok(loaded.dependencies.some((path) => path.replaceAll('\\', '/').endsWith('web/dev-api.ts')));
    assert.equal(loaded.dependencies.some((path) => path.replaceAll('\\', '/').includes('/dist/')), false);
    const server = await createServer({ ...loaded.config, configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, server: { ...loaded.config.server, port }, cacheDir: join(root, `vite-cache-${ordinal}`) });
    servers.push(server);
    return server;
  }
  try {
    const original = Buffer.from('<svg onload="alert(1)">中文</svg>');
    const source = join(root, 'unsafe.svg'); await writeFile(source, original);
    const writer = await openApplication(dataDir);
    const resource = (await writer.manager.importResource(source)).resource;
    const contentPath = await writer.manager.resolveContentPath(resource.id);
    await writer.close();
    start(dataDir);
    const before = await snapshot(dataDir);
    const first = await make(dataDir);
    console.log('dev: source config loaded');
    assert.equal(first.config.server.strictPort, true);
    assert.equal(first.config.fsDenyGlob(join(dataDir, 'metadata', resource.id + '.meta').replaceAll('\\', '/')), true);
    await first.listen();
    console.log('dev: listening');
    const port = first.httpServer.address().port, origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(origin + '/@vite/client')).status, 200);
    console.log('dev: page and Vite client');
    const query = await (await fetch(origin + '/api/resources', { headers: { Origin: origin } })).json();
    assert.equal(query.data.total, 1);
    assert.equal((await fetch(origin + '/api/resources', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(origin + '/api/resources', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal(await rawGet(origin + '/api/resources', { Host: 'evil.example' }), 403);
    assert.equal((await fetch(origin + '/_control/status')).status, 404);
    assert.equal((await fetch(origin + '/_control/stop', { method: 'POST', headers: { Authorization: 'Bearer arbitrary' } })).status, 404);
    const download = await fetch(`${origin}/api/resources/${resource.id}/file?inline=1`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    assert.match(download.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    const head = await fetch(`${origin}/api/resources/${resource.id}/file`, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), original.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const path of [join(dataDir, 'metadata', resource.id + '.meta'), contentPath, join(REPO, 'src/core/manager.ts')]) {
      for (const suffix of ['', '?raw', '?import']) {
        const url = `${origin}/@fs/${path.replaceAll('\\', '/')}${suffix}`;
        assert.equal((await fetch(url)).status, 403, url);
      }
    }
    const encoded = encodeURIComponent(join(dataDir, 'metadata', resource.id + '.meta').replaceAll('\\', '/'));
    assert.equal((await fetch(`${origin}/@fs/${encoded}?raw`)).status, 403);
    console.log('dev: API/security/download isolation');
    const conflict = await make(dataDir, port);
    await assert.rejects(() => conflict.listen(), /already in use/);
    console.log('dev: port conflict');
    await conflict.close();
    await first.close();
    assert.equal(serviceCli(dataDir, ['service', 'status']).running, true);
    const restarted = await make(dataDir, port);
    await restarted.listen();
    assert.equal((await fetch(origin + '/api/resources')).status, 200);
    await restarted.close();
    assert.deepEqual(await snapshot(dataDir), before);
    await assert.rejects(make(missing), /service|服务/i);
    await assert.rejects(access(missing), { code: 'ENOENT' });
    start(missing);
    const empty = await make(missing);
    await empty.listen();
    const emptyOrigin = `http://127.0.0.1:${empty.httpServer.address().port}`;
    assert.equal((await (await fetch(emptyOrigin + '/api/resources')).json()).data.total, 0);
    assert.equal((await fetch(emptyOrigin)).status, 200);
    await empty.close();
  } catch (error) { console.error(error); throw error; } finally {
    await Promise.all(servers.map((server) => server.close()));
    for (const directory of running) serviceCli(directory, ['service', 'stop']);
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(REPO) + '\\') || absolute.startsWith(resolve(REPO) + '/'));
    assert.equal(await realpath(absolute), canonicalRoot);
    await rm(absolute, { recursive: true, force: true });
  }
});
