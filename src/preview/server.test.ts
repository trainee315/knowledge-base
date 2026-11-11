import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApplication } from '../index.js';
import { createPreviewServer } from './server.js';
import { handlePreview } from './index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('real core/plugins preview supports query, content, UUID files, organizations, and denies writes/cross-origin', async () => {
  const root = await mkdtemp(join(tmpdir(), '知识库 预览 HTTP '));
  let preview: Awaited<ReturnType<typeof createPreviewServer>> | undefined;
  try {
    const dataDir = join(root, '数据 目录'), webDir = join(root, 'web');
    await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<!doctype html><title>test</title>');
    const source = join(root, '首期 验证.md'); await writeFile(source, '# 安全渲染\n\n知识库 preview API。');
    const binary = join(root, 'binary.bin'); await writeFile(binary, Buffer.from([0, 255, 1]));
    const svg = join(root, 'active.svg'); await writeFile(svg, '<svg onload="alert(1)"/>');
    const writer = await openApplication(dataDir);
    const imported = await writer.manager.importResource(source);
    const bin = await writer.manager.importResource(binary);
    const active = await writer.manager.importResource(svg);
    const tag = await writer.plugins.execute('tag create', { name: '验收标签' }, []) as { id: string; revision: number };
    await writer.manager.registerOrganizationType({ id: 'review-reading', name: '阅读清单', description: '只读方式预览', config: { sort: 'manual' }, enabled: true });
    await writer.plugins.execute('tag decide', { resourceId: imported.resource.id, tagId: tag.id, contentVersion: 1, tagRevision: tag.revision, accepted: true, source: 'manual', reason: '验证只读页面' }, []);
    await writer.plugins.refresh();
    await writer.close();
    const before = await readFile(join(dataDir, 'metadata', `${imported.resource.id}.meta`), 'utf8');
    const app = await openApplication(dataDir, { readOnly: true });
    preview = await createPreviewServer({ app, dataDir, webDir });
    const get = (path: string, init?: RequestInit) => fetch(preview!.url + path, init);
    assert.equal((await get('/')).status, 200);
    const query = await (await get('/api/resources?tags=' + encodeURIComponent('验收标签'))).json() as any;
    assert.equal(query.data.total, 1);
    assert.ok(query.data.items[0].matchReasons.some((reason: string) => reason.includes('标签')));
    assert.equal(query.data.items[0].parseStatus, 'parsed');
    const detail = await (await get(`/api/resources/${imported.resource.id}`)).json() as any;
    assert.match(detail.data.content.text, /安全渲染/);
    const unparsed = await (await get(`/api/resources?filename=binary`)).json() as any;
    assert.equal(unparsed.data.items[0].parseStatus, 'unsupported');
    const empty = await (await get('/api/resources?filename=does-not-exist')).json() as any;
    assert.equal(empty.data.total, 0); assert.deepEqual(empty.data.items, []);
    const parsedOnly = await (await get('/api/resources?parseStatus=unsupported&limit=1')).json() as any;
    assert.equal(parsedOnly.data.total, 2); assert.equal(parsedOnly.data.items.length, 1);
    const organizations = await (await get('/api/organizations')).json() as any;
    assert.ok(organizations.data.some((org: any) => org.id === tag.id));
    const types = await (await get('/api/organization-types')).json() as any;
    assert.ok(types.data.some((kind: any) => kind.id === 'review-reading' && kind.enabled && kind.config.sort === 'manual'));
    const plugins = await (await get('/api/plugins')).json() as any;
    assert.ok(plugins.data.some((plugin: any) => plugin.id === 'content' && plugin.status === 'ready'));
    const bytes = await get(`/api/resources/${bin.resource.id}/file`);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), Buffer.from([0, 255, 1]));
    const activeDownload = await get(`/api/resources/${active.resource.id}/file?inline=1`);
    assert.match(activeDownload.headers.get('content-disposition')!, /^attachment/);
    assert.equal(activeDownload.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await get('/api/resources', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await get('/api/resources', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await get('/_control/status')).status, 403);
    assert.equal((await get('/api/resources?limit=-1')).status, 400);
    assert.equal((await get('/api/resources/not-a-uuid')).status, 400);
    assert.equal(await readFile(join(dataDir, 'metadata', `${imported.resource.id}.meta`), 'utf8'), before);
    const update = await openApplication(dataDir);
    try { await writeFile(source, '# 更新后的正文'); await update.manager.updateResource(imported.resource.id, source); }
    finally { await update.close(); }
    const stale = await (await get(`/api/resources/${imported.resource.id}`)).json() as any;
    assert.equal(stale.data.content.status, 'pending'); assert.equal(stale.data.content.text, undefined);
  } finally { await preview?.close(); await rm(root, { recursive: true, force: true }); }
});

test('background preview lifecycle is explicit, idempotent and works with Chinese/space data paths', async () => {
  const root = await mkdtemp(join(tmpdir(), '知识库 preview 生命周期 '));
  try {
    const writer = await openApplication(root); await writer.close();
    const attempts = await Promise.allSettled([handlePreview(['start'], root), handlePreview(['start'], root)]);
    const successful = attempts.filter((item) => item.status === 'fulfilled').map((item) => item.value) as any[];
    assert.ok(successful.length >= 1);
    assert.equal(new Set(successful.map((item) => item.url)).size, 1);
    const started = successful[0];
    assert.equal(started.running, true); assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(started.token, undefined);
    assert.equal((await fetch(started.url)).status, 200);
    assert.deepEqual(await handlePreview(['start'], root), started);
    assert.deepEqual(await handlePreview(['status'], root), started);
    assert.equal((await handlePreview(['stop'], root) as any).running, false);
    assert.equal((await handlePreview(['status'], root) as any).running, false);
    await assert.rejects(() => handlePreview(['start', '--port', '65536'], root));
  } finally { await handlePreview(['stop'], root); await rm(root, { recursive: true, force: true }); }
});

test('eight CLI processes, case/junction aliases and stale PID records share one canonical preview instance', async () => {
  const root = await mkdtemp(join(tmpdir(), '知识库 preview 并发 '));
  const dataDir = join(root, 'data'), alias = join(root, 'junction alias');
  let started: any;
  const command = async (operation: string, directory = dataDir) => {
    const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('../cli/main.js', import.meta.url)), 'preview', operation, '--data-dir', directory, '--json'], { windowsHide: true });
    const result = JSON.parse(stdout); assert.equal(result.ok, true, stdout); return result.data;
  };
  try {
    const writer = await openApplication(dataDir); await writer.close();
    await mkdir(join(dataDir, '.runtime'));
    await writeFile(join(dataDir, '.runtime', 'preview-start.json'), JSON.stringify({ pid: 2147483647 }));
    await writeFile(join(dataDir, '.runtime', 'preview.json'), JSON.stringify({ running: true, dataDir: await realpath(dataDir), url: 'http://127.0.0.1:1', port: 1, pid: 2147483647, token: 'stale' }));
    await symlink(dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const states = await Promise.all(Array.from({ length: 8 }, (_, index) => command('start', index % 2 ? alias : dataDir)));
    assert.equal(new Set(states.map((state) => state.pid)).size, 1);
    assert.equal(new Set(states.map((state) => state.url)).size, 1);
    started = states[0];
    assert.notEqual(started.pid, 2147483647);
    assert.equal((await command('status', alias)).pid, started.pid);
    if (process.platform === 'win32') assert.equal((await command('start', dataDir.toUpperCase())).pid, started.pid);
    assert.equal((await command('stop', alias)).running, false);
    await assert.rejects(fetch(started.url, { signal: AbortSignal.timeout(1000) }));
    const restarted = await command('start');
    assert.notEqual(restarted.pid, started.pid);
    process.kill(restarted.pid, 'SIGKILL');
    const recovered = await command('start', alias);
    assert.notEqual(recovered.pid, restarted.pid);
    assert.equal((await command('status')).pid, recovered.pid);
    assert.equal((await command('stop')).running, false);
  } finally {
    await handlePreview(['stop'], dataDir);
    // unlink 只删除测试创建的目录别名，绝不递归穿过 junction。
    try { await unlink(alias); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
  }
});
