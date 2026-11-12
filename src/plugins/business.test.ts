import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { handleService } from '../service/client.js';
import { fileURLToPath } from 'node:url';
import { openApplication } from '../index.js';
import { CoreManager } from '../core/manager.js';
import { PluginHost } from '../core/plugins.js';
import { builtinPlugins } from './index.js';
import { tasksPlugin, type Task, type TasksApi } from './tasks/index.js';
import type { PluginDefinition } from '../contracts/index.js';
import type { Candidate } from './organizer/index.js';
import type { ContentData } from './content/index.js';
import type { KeywordData } from './keywords/index.js';
import type { TagData } from './tags/index.js';
import { extractContent } from './content/extract.js';
import { extractKeywords, normalize } from './keywords/extract.js';
import { lexicalProvider } from './relations/lexical.js';
import type { RelationsApi } from './relations/index.js';

test('UTF8解析、未知格式降级、中英文关键词和离线评分', async () => {
  assert.equal(extractContent('说明.md', Buffer.from('中文 TypeScript')).status, 'parsed');
  assert.equal(extractContent('坏.json', Buffer.from('{')).status, 'failed');
  assert.equal(extractContent('坏.txt', Buffer.from([0xff])).status, 'failed');
  assert.equal(extractContent('图像.png', Buffer.from([0xff])).status, 'unsupported');
  assert.equal(normalize(' ＴＹＰＥＳＣＲＩＰＴ  '), 'typescript');
  const words = extractKeywords('图像压缩 图像压缩 TYPESCRIPT', '纹理笔记.md').map(word => word.value);
  assert.ok(words.includes('typescript')); assert.ok(words.some(word => /图像|压缩/u.test(word)));
  const scored = await lexicalProvider.score({ name: '图像压缩', aliases: ['compression'], description: 'PNG图片纹理' }, ['compression', '图像', '不相关']);
  assert.equal(lexicalProvider.kind, 'heuristic'); assert.equal(scored[0].score, 1); assert.ok(scored[1].score > 0); assert.equal(scored[2].score, 0);
});

test('真实导入到候选、标签新增回填、查询组合、人工拒绝保护和过期结果阻断', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-business-'));
  const app = await openApplication(path.join(root, 'data'));
  const exec = (name: string, input: Record<string, unknown> = {}) => app.plugins.execute(name, input);
  try {
    const source = path.join(root, '纹理compression.md');
    await fs.writeFile(source, '# 图像压缩\nPNG compression textures TypeScript');
    const { resource } = await app.manager.importResource(source);
    await app.plugins.refresh();
    assert.equal((await exec('content get', { id: resource.id }) as ContentData).status, 'parsed');
    assert.ok((await exec('keyword get', { id: resource.id }) as KeywordData).items.length);
    const tag = await exec('tag create', { name: 'compression', aliases: ['图像压缩'], description: 'PNG textures' }) as { id: string; revision: number };
    await app.plugins.refresh();
    const jobs = await exec('task list') as Task[];
    assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.status === 'completed'), JSON.stringify(jobs));
    await app.plugins.refresh();
    assert.equal((await exec('task list') as Task[]).length, jobs.length);
    const [candidate] = await exec('organize candidates') as Candidate[];
    assert.equal(candidate.resourceId, resource.id); assert.equal(candidate.provider.kind, 'heuristic');
    await exec('organize submit', { candidateId: candidate.id, accepted: false, source: 'manual', reason: '人工拒绝：本文不属于此标签' });
    await app.plugins.refresh();
    assert.equal((await exec('organize candidates') as Candidate[]).length, 0);
    await exec('tag update', { id: tag.id, description: 'PNG compression TypeScript 图像' });
    await app.plugins.refresh();
    const [review] = await exec('organize candidates') as Candidate[];
    assert.equal(review.review, true);
    const protectedResult = await exec('organize submit', { candidateId: review.id, accepted: true, source: 'codex', reason: '自动建议归入' }) as { applied: boolean };
    assert.equal(protectedResult.applied, false);
    const manual = (await app.manager.getResource(resource.id)).plugins.tags?.data as unknown as TagData;
    assert.equal(manual.decisions[0].accepted, false); assert.equal(manual.decisions[0].source, 'manual');
    await fs.writeFile(source, '# 图像压缩新版本\nPNG compression TypeScript changed');
    await app.manager.updateResource(resource.id, source, 1);
    await app.plugins.refresh();
    await assert.rejects(exec('organize submit', { candidateId: candidate.id, accepted: true, reason: '旧结果' }), /STALE_INPUT/u);
    const latestTag = await exec('tag get', { id: tag.id }) as { revision: number };
    await exec('tag decide', { resourceId: resource.id, tagId: tag.id, accepted: true, source: 'manual', reason: '人工确认归属', contentVersion: 2, tagRevision: latestTag.revision });
    const system = await exec('system create', { name: '图像教程', description: '按指导组织' }) as { id: string };
    await exec('system add-node', { id: system.id, node: { title: '第二章', resourceId: resource.id, order: 2 } });
    await exec('system add-node', { id: system.id, node: { title: '第一章', order: 1 } });
    const organized = await exec('system get', { id: system.id }) as { name: string; data: { nodes: { order: number }[] } };
    assert.equal(organized.name, '图像教程'); assert.deepEqual(organized.data.nodes.map(node => node.order), [1, 2]);
    const query = await exec('organize query', { filename: ['不匹配', '纹理'], body: ['changed'], keywords: ['typescript'], tags: ['图像压缩'], systems: [system.id] }) as { total: number; items: { reasons: string[]; parseStatus: string }[] };
    assert.equal(query.total, 1); assert.equal(query.items[0].reasons.length, 5); assert.equal(query.items[0].parseStatus, 'parsed');
    assert.equal((await exec('organize query', { filename: ['纹理'], body: ['不存在'] }) as { total: number }).total, 0);
    await assert.rejects(exec('tag create', { name: ' COMPRESSION ' }), /TAG_ALIAS_CONFLICT/u);
    await assert.rejects(exec('tag delete', { id: tag.id }), /REFERENCE_IN_USE/u);
    const binary = path.join(root, '图像资源.bin'); await fs.writeFile(binary, Buffer.from([0xff]));
    const imported = await app.manager.importResource(binary); await app.plugins.refresh();
    assert.equal((await exec('content get', { id: imported.resource.id }) as ContentData).status, 'unsupported');
    assert.equal((await exec('organize query', { filename: ['图像资源'] }) as { items: { parseStatus: string }[] }).items[0].parseStatus, 'unsupported');
    const unparsed = await exec('organize query', { parseStatus: ['unsupported'], limit: 1 }) as { total: number; items: { parseStatus: string; reasons: string[] }[] };
    assert.equal(unparsed.total, 1); assert.equal(unparsed.items[0].parseStatus, 'unsupported'); assert.match(unparsed.items[0].reasons[0], /解析状态/u);
    assert.equal((await app.manager.check()).valid, true);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('独立CLI进程自动导入链路与结构化候选提交', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cli-business-'));
  const cli = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  function run(command: string[], input: Record<string, unknown> = {}) {
    const child = spawnSync(process.execPath, [cli, ...command, '--data-dir', path.join(root, 'data'), '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const output = JSON.parse(child.stdout) as { ok: boolean; data: unknown };
    assert.equal(output.ok, true); return output.data;
  }
  try {
    await handleService(['start'], path.join(root, 'data'));
    const filename = path.join(root, 'compression.md'); await fs.writeFile(filename, '# 图像压缩\nPNG compression');
    const imported = run(['resource', 'import'], { file: filename }) as { resource: { id: string } };
    run(['tag', 'create'], { name: 'compression', aliases: ['图像压缩'] });
    const [candidate] = run(['organize', 'candidates']) as Candidate[];
    assert.equal(candidate.resourceId, imported.resource.id);
    run(['organize', 'submit'], { candidateId: candidate.id, accepted: true, source: 'codex', reason: '已阅读正文，确认讨论compression' });
    const query = run(['organize', 'query'], { tags: ['图像压缩'], keywords: ['compression'] }) as { total: number };
    assert.equal(query.total, 1);
    assert.equal((run(['resource', 'import'], { file: filename }) as { duplicate: boolean }).duplicate, true);
    const jobs = run(['task', 'list']) as Task[];
    assert.equal(jobs.length, 2); assert.ok(jobs.every(task => task.status === 'completed'));
    const invalidJson = path.join(root, 'invalid.json'); await fs.writeFile(invalidJson, '{broken');
    const invalid = run(['resource', 'import'], { file: invalidJson }) as { resource: { id: string } };
    assert.equal((run(['content', 'get'], { id: invalid.resource.id }) as ContentData).status, 'failed');
    const binary = path.join(root, 'filenamefallback.bin'); await fs.writeFile(binary, Buffer.from([0xff]));
    run(['resource', 'import'], { file: binary });
    const fallback = run(['organize', 'query'], { filename: ['filenamefallback'], parseStatus: ['unsupported'] }) as { total: number; items: { parseStatus: string }[] };
    assert.equal(fallback.total, 1); assert.equal(fallback.items[0].parseStatus, 'unsupported');
    const missingTag = spawnSync(process.execPath, [cli, 'tag', 'decide', '--data-dir', path.join(root, 'data'), '--input', '-', '--json'], { input: JSON.stringify({ resourceId: imported.resource.id, tagId: '00000000-0000-4000-8000-000000000000', accepted: true, source: 'codex', reason: '无效引用', contentVersion: 1, tagRevision: 1 }), encoding: 'utf8' });
    assert.equal(missingTag.status, 1); assert.equal(JSON.parse(missingTag.stdout).ok, false); assert.match(JSON.parse(missingTag.stdout).error.message, /NOT_FOUND/u);
  } finally { await handleService(['stop'], path.join(root, 'data')); await fs.rm(root, { recursive: true, force: true }); }
});

test('评分处理器版本变化重新排队，旧处理器候选不能提交', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-provider-version-'));
  const manager = await CoreManager.open(path.join(root, 'data'));
  let relations!: RelationsApi;
  const probe: PluginDefinition = { manifest: { id: 'probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { relations: '*' } }, async load(context) { relations = context.getDependency<RelationsApi>('relations'); return {}; } };
  const host = new PluginHost(manager, [...builtinPlugins, probe]); await host.start();
  try {
    await host.execute('tag create', { name: 'compression' });
    const file = path.join(root, 'compression.md'); await fs.writeFile(file, 'PNG compression'); await manager.importResource(file); await host.refresh();
    const [previous] = await host.execute('organize candidates', {}) as Candidate[];
    relations.setProvider({ ...lexicalProvider, version: '2' }); await host.refresh();
    const jobs = await host.execute('task list', {}) as Task[];
    assert.equal(jobs.length, 2); assert.notEqual(jobs[0].processorVersion, jobs[1].processorVersion); assert.ok(jobs.every(task => task.status === 'completed'));
    const [current] = await host.execute('organize candidates', {}) as Candidate[];
    assert.equal(current.provider.version, '2'); assert.notEqual(current.id, previous.id);
    await assert.rejects(host.execute('organize submit', { candidateId: previous.id, accepted: true, reason: '旧处理器' }), /STALE_INPUT/u);
  } finally { await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Markdown链接及图片登记正式引用，代码示例忽略，移除链接解除保护并诊断坏目标', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-markdown-reference-'));
  const app = await openApplication(path.join(root, 'data'));
  try {
    const targetFile = path.join(root, 'target.txt'); await fs.writeFile(targetFile, 'target version one');
    const target = (await app.manager.importResource(targetFile)).resource;
    const imageFile = path.join(root, 'image.png'); await fs.writeFile(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = (await app.manager.importResource(imageFile)).resource;
    const exampleFile = path.join(root, 'example.txt'); await fs.writeFile(exampleFile, 'only code example');
    const example = (await app.manager.importResource(exampleFile)).resource;
    const sourceFile = path.join(root, 'links.md');
    const code = `\n\`\`\`md\n[示例](kb://resource/${example.id})\n\`\`\`\n\`[行内示例](kb://resource/${example.id})\``;
    await fs.writeFile(sourceFile, `[正文](kb://resource/${target.id})\n![图片](kb://resource/${image.id})${code}`);
    const source = (await app.manager.importResource(sourceFile)).resource;
    await app.plugins.refresh();
    const meta = await app.manager.getResource(source.id);
    assert.deepEqual(meta.references.filter(ref => ref.owner === 'content').map(ref => ref.id).sort(), [target.id, image.id].sort());
    const parsed = await app.plugins.execute('content get', { id: source.id }) as ContentData;
    assert.equal(parsed.referenceStatus, 'valid'); assert.equal(parsed.markdownReferences.length, 2);
    await fs.writeFile(targetFile, 'target version two'); await app.manager.updateResource(target.id, targetFile, 1); await app.plugins.refresh();
    assert.equal((await app.manager.getResource(target.id)).id, target.id); assert.equal((await app.manager.readContent(target.id, 1)).toString(), 'target version one');
    await app.manager.deleteResource(target.id); await app.manager.deleteResource(image.id);
    await assert.rejects(app.manager.purgeResource(target.id), /仍被引用/u); await assert.rejects(app.manager.purgeResource(image.id), /仍被引用/u);
    await app.manager.deleteResource(example.id); await app.manager.purgeResource(example.id);
    const customOrganization = await app.manager.createOrganization({ type: 'custom', name: '独立引用' });
    await app.manager.updatePluginMeta(source.id, 'custom', { preserved: true }, { references: [{ kind: 'organization', id: customOrganization.id }] });
    await fs.writeFile(sourceFile, `# 移除当前正文链接${code}`); await app.manager.updateResource(source.id, sourceFile, 1); await app.plugins.refresh();
    const unlinked = await app.manager.getResource(source.id);
    assert.equal(unlinked.references.filter(ref => ref.owner === 'content').length, 0); assert.ok(unlinked.references.some(ref => ref.owner === 'custom' && ref.id === customOrganization.id));
    await app.manager.purgeResource(target.id); await app.manager.purgeResource(image.id);
    await fs.writeFile(sourceFile, '[不存在](kb://resource/00000000-0000-4000-8000-000000000000)\n[非法](kb://resource/not-a-uuid)');
    await app.manager.updateResource(source.id, sourceFile, 2); await app.plugins.refresh();
    const broken = await app.plugins.execute('content get', { id: source.id }) as ContentData;
    assert.equal(broken.status, 'parsed'); assert.equal(broken.referenceStatus, 'broken'); assert.equal(broken.diagnostics.length, 2); assert.match(broken.diagnostics.join(' '), /BROKEN_RESOURCE_REFERENCE/u);
    assert.match((await app.manager.readContent(source.id)).toString(), /不存在/u); assert.equal((await app.manager.check()).valid, true);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('定时模拟时钟与进程重启后的同日去重', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-schedule-'));
  let app = await openApplication(root);
  try {
    const state = await app.plugins.execute('schedule get', {}) as { config: { time: string; timezone: string } };
    assert.equal(state.config.time, '03:00'); assert.equal(state.config.timezone, 'Asia/Shanghai');
    assert.equal((await app.plugins.execute('schedule tick', { now: '2026-11-10T18:59:00Z' }) as { triggered: boolean }).triggered, false);
    assert.equal((await app.plugins.execute('schedule tick', { now: '2026-11-10T19:00:00Z' }) as { triggered: boolean }).triggered, true);
    await app.close(); app = await openApplication(root);
    assert.equal((await app.plugins.execute('schedule tick', { now: '2026-11-10T21:00:00Z' }) as { triggered: boolean }).triggered, false);
    assert.equal((await app.plugins.execute('schedule tick', { now: '2026-11-11T19:00:00Z' }) as { triggered: boolean }).triggered, true);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('任务持久化去重、失败重试断点、超时、重试上限及模型预算', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-tasks-'));
  let manager = await CoreManager.open(root);
  let api!: TasksApi;
  let shouldFail = true;
  let resumed = false;
  const probe: PluginDefinition = { manifest: { id: 'probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { tasks: '*' } }, async load(context) {
    api = context.getDependency<TasksApi>('tasks');
    api.register('resumable', async (task, execution) => {
      if (task.checkpoint) resumed = true;
      await execution.checkpoint({ page: 1 });
      if (shouldFail) throw new Error('temporary failure');
      return { done: true };
    });
    api.register('slow', async (_, execution) => new Promise((_, reject) => execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })));
    api.register('paid', async () => ({ invoked: true }));
    return {};
  } };
  let host = new PluginHost(manager, [tasksPlugin, probe]); await host.start();
  try {
    const input = { type: 'resumable', entityId: 'r1', inputVersion: '1', processorVersion: '1', payload: {} };
    const first = await api.enqueue(input); assert.equal((await api.enqueue(input)).id, first.id);
    assert.equal((await api.run()).failed, 1);
    await host.stop(); await manager.close();
    manager = await CoreManager.open(root); host = new PluginHost(manager, [tasksPlugin, probe]); await host.start();
    shouldFail = false; assert.equal((await api.run()).completed, 1); assert.equal(resumed, true);
    await api.enqueue({ ...input, inputVersion: '2' }); assert.equal((await api.run()).completed, 1);
    const slow = await api.enqueue({ ...input, type: 'slow', timeoutMs: 10, maxAttempts: 1 });
    assert.equal((await api.run()).failed, 1); assert.equal((await api.run()).processed, 0);
    assert.match((await api.list()).find(task => task.id === slow.id)!.error!, /TASK_TIMEOUT/u);
    await api.enqueue({ ...input, type: 'paid', estimatedCalls: 1, estimatedCost: 0.1 });
    assert.equal((await api.run()).stopped, 'model-budget');
    const budgeted = await api.run({ maxCalls: 1, maxCost: 0.1 }); assert.equal(budgeted.completed, 1); assert.equal(budgeted.calls, 1);
    const disk = await manager.pluginStore('tasks').read<Task[]>('queue', []);
    const interrupted = disk.find(task => task.id === first.id)!; interrupted.status = 'running'; interrupted.attempts = 1;
    await manager.pluginStore('tasks').write('queue', disk);
    await host.stop(); await manager.close();
    manager = await CoreManager.open(root); host = new PluginHost(manager, [tasksPlugin, probe]); await host.start();
    assert.equal((await api.run()).completed, 1); assert.equal((await api.list()).find(task => task.id === first.id)!.status, 'completed');
  } finally { await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('超时处理器退出前隔离重试，旧异步写不会与新attempt重叠', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-task-draining-'));
  const manager = await CoreManager.open(root);
  let api!: TasksApi;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let settled!: () => void; const oldSettled = new Promise<void>(resolve => { settled = resolve; });
  let calls = 0;
  const probe: PluginDefinition = { manifest: { id: 'probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { tasks: '*' } }, async load(context) {
    api = context.getDependency<TasksApi>('tasks');
    api.register('ignore-abort', async () => {
      calls++;
      if (calls === 1) { await gate; await context.store.write('effect', { attempt: 'old' }); settled(); }
      else await context.store.write('effect', { attempt: 'new' });
      return { calls };
    });
    return {};
  } };
  const host = new PluginHost(manager, [tasksPlugin, probe]); await host.start();
  try {
    const task = await api.enqueue({ type: 'ignore-abort', entityId: 'r', inputVersion: '1', processorVersion: '1', payload: {}, timeoutMs: 500 });
    const timedOut = await api.run(); assert.equal(timedOut.failed, 1); assert.equal(timedOut.draining, 1); assert.equal(timedOut.stopped, 'attempt-draining');
    await assert.rejects(api.retry(task.id), /TASK_DRAINING/u); const blocked = await api.run(); assert.equal(blocked.processed, 0); assert.equal(blocked.stopped, 'attempt-draining'); assert.equal(calls, 1);
    release(); await oldSettled; await new Promise(resolve => setTimeout(resolve, 0));
    await api.retry(task.id); assert.equal((await api.run()).completed, 1); assert.equal(calls, 2);
    assert.deepEqual(await manager.pluginStore('probe').read('effect', {}), { attempt: 'new' });
  } finally { release(); await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('调度失败、超时与预算未完成不标当日成功，同日可继续', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-schedule-retry-'));
  const manager = await CoreManager.open(root); let api!: TasksApi; let flakyCalls = 0; let slowCalls = 0;
  const probe: PluginDefinition = { manifest: { id: 'probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { tasks: '*' } }, async load(context) {
    api = context.getDependency<TasksApi>('tasks');
    api.register('flaky', async () => { if (++flakyCalls === 1) throw new Error('retry'); return {}; });
    api.register('slow-once', async (_, execution) => { if (++slowCalls === 1) return new Promise((_, reject) => execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })); return {}; });
    return {};
  } };
  const host = new PluginHost(manager, [...builtinPlugins, probe]); await host.start();
  try {
    const input = { entityId: 'r', inputVersion: '1', processorVersion: '1', payload: {} };
    await api.enqueue({ ...input, type: 'flaky' }); await api.enqueue({ ...input, type: 'slow-once', timeoutMs: 10 });
    const failed = await host.execute('schedule tick', { now: '2026-11-10T19:00:00Z' }) as { complete: boolean; failed: number };
    assert.equal(failed.complete, false); assert.equal(failed.failed, 2);
    const state = await host.execute('schedule get', {}) as { lastDate?: string; lastAttemptComplete: boolean };
    assert.equal(state.lastDate, undefined); assert.equal(state.lastAttemptComplete, false);
    const resumed = await host.execute('schedule tick', { now: '2026-11-10T19:01:00Z' }) as { complete: boolean; completed: number };
    assert.equal(resumed.complete, true); assert.equal(resumed.completed, 2);
    await api.enqueue({ ...input, type: 'flaky', inputVersion: 'after-success' }); await host.execute('schedule configure', { maxTasks: 0 });
    assert.equal((await host.execute('schedule run', { now: '2026-11-10T19:02:00Z' }) as { complete: boolean }).complete, false);
    await host.execute('schedule configure', { maxTasks: 10 }); assert.equal((await host.execute('schedule tick', { now: '2026-11-10T19:03:00Z' }) as { complete: boolean }).complete, true);
    await api.enqueue({ ...input, type: 'flaky', inputVersion: '2' }); await host.execute('schedule configure', { maxTasks: 0 });
    assert.equal((await host.execute('schedule tick', { now: '2026-11-11T19:00:00Z' }) as { complete: boolean }).complete, false);
    await host.execute('schedule configure', { maxTasks: 10 }); assert.equal((await host.execute('schedule tick', { now: '2026-11-11T19:01:00Z' }) as { complete: boolean }).complete, true);
  } finally { await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('评分进行中切换provider丢弃旧结果，输入类型与整数预算严格校验', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-provider-race-'));
  const manager = await CoreManager.open(root); let relations!: RelationsApi;
  const probe: PluginDefinition = { manifest: { id: 'probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { relations: '*' } }, async load(context) { relations = context.getDependency<RelationsApi>('relations'); return {}; } };
  const host = new PluginHost(manager, [...builtinPlugins, probe]); await host.start();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const scoringStarted = new Promise<void>(resolve => { started = resolve; });
  try {
    const tag = await host.execute('tag create', { name: 'compression' }) as { id: string };
    relations.setProvider({ ...lexicalProvider, id: 'p1', async score(label, words, signal) { started(); await gate; return lexicalProvider.score(label, words, signal); } });
    const pending = relations.score(tag.id, ['compression']); await scoringStarted;
    relations.setProvider({ ...lexicalProvider, id: 'p2' }); release();
    await assert.rejects(pending, /STALE_PROVIDER/u); assert.equal(await relations.get(tag.id), undefined);
    const configured = await host.execute('schedule configure', { enabled: 'false' }) as { config: { enabled: boolean } }; assert.equal(configured.config.enabled, false);
    for (const [command, input] of [['schedule configure', { enabled: 'no' }], ['schedule configure', { time: 123 }], ['schedule configure', { maxCalls: 1.5 }], ['task run', { maxTasks: 1.5 }], ['task run', { maxCost: true }], ['organize query', { filename: [{}] }], ['organize query', { limit: -1 }], ['tag create', { name: 'invalid', aliases: [5] }]] as [string, Record<string, unknown>][]) await assert.rejects(host.execute(command, input), /INVALID_INPUT|INVALID_CONFIG/u);
  } finally { release(); await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('已知插件未来meta版本拒读拒写，未知分区保留，算法v2与meta v1独立', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-plugin-schema-'));
  const app = await openApplication(path.join(root, 'data'));
  try {
    const file = path.join(root, 'compression.txt'); await fs.writeFile(file, 'compression PNG'); const resource = (await app.manager.importResource(file)).resource;
    const tag = await app.plugins.execute('tag create', { name: 'compression' }) as { id: string; revision: number };
    await app.plugins.execute('content extract', { id: resource.id }); await app.plugins.execute('keyword extract', { id: resource.id });
    const decide = { resourceId: resource.id, tagId: tag.id, accepted: true, source: 'codex', reason: 'schema probe', contentVersion: 1, tagRevision: tag.revision };
    for (const id of ['content', 'keywords', 'tags']) {
      const original = (await app.manager.getResource(resource.id)).plugins[id];
      const future = { futureField: { mustRemain: true }, ...(id === 'tags' ? { decisions: [] } : { inputVersion: 1, processorVersion: 'future', items: [] }) };
      await app.manager.updatePluginMeta(resource.id, id, future, { schemaVersion: 99 });
      const before = (await app.manager.getResource(resource.id)).plugins[id];
      const commands = id === 'content' ? ['content get', 'content extract'] : id === 'keywords' ? ['keyword get', 'keyword extract'] : ['tag decide', 'tag clear'];
      for (const command of commands) await assert.rejects(app.plugins.execute(command, id === 'tags' ? decide : { id: resource.id }), error => (error as { code?: string }).code === 'UNSUPPORTED_PLUGIN_SCHEMA');
      assert.deepEqual((await app.manager.getResource(resource.id)).plugins[id], before);
      await app.manager.updatePluginMeta(resource.id, id, original?.data ?? { decisions: [] }, { schemaVersion: original?.schemaVersion ?? 1 });
    }
    await app.manager.updatePluginMeta(resource.id, 'future-unknown', { nested: { unchanged: true } }, { schemaVersion: 99 });
    await app.plugins.execute('content extract', { id: resource.id });
    const current = await app.manager.getResource(resource.id);
    assert.equal(current.plugins.content.schemaVersion, 1); assert.equal(current.plugins.content.data.processorVersion, '2'); assert.equal(current.plugins['future-unknown'].schemaVersion, 99);
    await app.manager.updatePluginMeta(resource.id, 'tags', { futureField: 'must-remain', decisions: [] }, { schemaVersion: 99 });
    const result = await app.plugins.execute('organize run', {}) as { failed: number };
    assert.equal(result.failed, 1); assert.equal((await app.manager.getResource(resource.id)).plugins.tags.schemaVersion, 99); assert.equal((await app.manager.getResource(resource.id)).plugins.tags.data.futureField, 'must-remain');
    assert.match((await app.plugins.execute('task list', {}) as Task[]).at(-1)!.error!, /不支持meta结构版本/u);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});
