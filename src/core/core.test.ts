import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CoreManager } from './manager.js';
import { FileStorage } from './storage.js';
import { PluginHost, pluginOrder, satisfies } from './plugins.js';
import type { PluginDefinition } from '../contracts/index.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-core-')); const input = path.join(dir, 'note.md'); await writeFile(input, '# Resource\nknowledge architecture'); return { dir, input, data: path.join(dir, 'data') }; }
const definition = (id: string, dependencies: Record<string, string> = {}, load: PluginDefinition['load'] = async () => ({})): PluginDefinition => ({ manifest: { id, version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies }, load });

test('resource dedup, explicit copy, history, soft delete, references and backup restore', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try {
    const first = await manager.importResource(f.input); const repeated = await manager.importResource(f.input); const copy = await manager.importResource(f.input, { copy: true });
    assert.equal(first.resource.id, repeated.resource.id); assert.equal(repeated.duplicate, true); assert.notEqual(copy.resource.id, first.resource.id);
    await writeFile(f.input, 'updated'); const updated = await manager.updateResource(first.resource.id, f.input, 1); assert.equal(updated.contentVersion, 2); assert.match((await manager.readContent(first.resource.id, 1)).toString(), /knowledge/);
    await assert.rejects(manager.updateResource(first.resource.id, f.input, 1), /版本已过期/);
    const group = await manager.createOrganization({ type: 'custom', name: '引用', references: [{ kind: 'resource', id: first.resource.id }] });
    await manager.deleteResource(first.resource.id); assert.equal((await manager.listResources()).length, 1); await assert.rejects(manager.purgeResource(first.resource.id), /仍被引用/);
    await manager.restoreResource(first.resource.id); assert.equal((await manager.getResource(first.resource.id)).id, first.resource.id);
    await manager.updatePluginMeta(first.resource.id, 'one', { a: true }, { references: [{ kind: 'organization', id: group.id }] });
    await manager.updatePluginMeta(first.resource.id, 'two', { b: true }, { references: [{ kind: 'resource', id: copy.resource.id }] });
    const meta = await manager.getResource(first.resource.id); assert.deepEqual(meta.references.map(ref => ref.owner), ['one', 'two']); assert.deepEqual(meta.plugins.one.data, { a: true });
    const backup = path.join(f.dir, 'backup.json'); await manager.backup(backup); const restored = await CoreManager.open(path.join(f.dir, 'restored'));
    try { await restored.restore(backup); assert.equal((await restored.getResource(first.resource.id)).contentVersion, 2); assert.equal((await restored.check()).valid, true); await restored.reindex(); await rm(restored.storage.resolve('cache'), { recursive: true }); assert.equal((await restored.reindex()).resources, 2); } finally { await restored.close(); }
    assert.equal((await manager.check()).valid, true);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('same UUID organization references protect resource and all content versions from purge', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try {
    const { resource } = await manager.importResource(f.input);
    await manager.createOrganization({ id: resource.id, type: 'review', name: '同UUID组织', references: [{ kind: 'resource', id: resource.id }] });
    await writeFile(f.input, 'second content version'); await manager.updateResource(resource.id, f.input);
    await manager.deleteResource(resource.id);
    await assert.rejects(manager.purgeResource(resource.id), error => (error as { code?: string }).code === 'REFERENCED');
    assert.match((await manager.readContent(resource.id, 1)).toString(), /knowledge architecture/);
    await manager.updateOrganization(resource.id, { references: [] }); await manager.purgeResource(resource.id);
    assert.equal((await manager.check()).valid, true);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('same UUID resource references protect organization from deletion', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try {
    const { resource } = await manager.importResource(f.input);
    await manager.createOrganization({ id: resource.id, type: 'review', name: '同UUID组织' });
    await manager.updatePluginMeta(resource.id, 'review', {}, { references: [{ kind: 'organization', id: resource.id }] });
    await assert.rejects(manager.deleteOrganization(resource.id), error => (error as { code?: string }).code === 'REFERENCED');
    await manager.updatePluginMeta(resource.id, 'review', {}, { references: [] }); await manager.deleteOrganization(resource.id);
    assert.equal((await manager.check()).valid, true);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('true same-kind self references do not block deleting their own entity', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try {
    const { resource } = await manager.importResource(f.input);
    await manager.updatePluginMeta(resource.id, 'review', {}, { references: [{ kind: 'resource', id: resource.id }] });
    await manager.deleteResource(resource.id); await manager.purgeResource(resource.id);
    const organization = await manager.createOrganization({ type: 'review', name: '自身引用' });
    await manager.updateOrganization(organization.id, { references: [{ kind: 'organization', id: organization.id }] });
    await manager.deleteOrganization(organization.id); assert.equal((await manager.check()).valid, true);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('single writer and injected interrupted transaction recovers all files on reopen', async () => {
  const f = await fixture(); let manager = await CoreManager.open(f.data, { failAfterWrites: 1 });
  try {
    await assert.rejects(CoreManager.open(f.data), /已有写入进程/);
    await assert.rejects(manager.importResource(f.input), /事务失败注入/);
    await assert.rejects(manager.importResource(f.input), /重新打开/);
    await manager.close(); manager = await CoreManager.open(f.data);
    const resources = await manager.listResources(); assert.equal(resources.length, 1); assert.match((await manager.readContent(resources[0].resource.id)).toString(), /knowledge/); assert.equal((await manager.check()).valid, true);
    assert.equal((await manager.storage.files('journal')).filter(file => file.endsWith('.json')).length, 0);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('concurrent read snapshot never returns mixed multi-file transaction', async () => {
  const f = await fixture(); const writer = new FileStorage(f.data); await writer.init(); await writer.transaction([{ file: 'state/a.json', value: '0' }, { file: 'state/b.json', value: '0' }]); const reader = new FileStorage(f.data, true); await reader.init();
  try {
    await Promise.all([ (async () => { for (let n = 1; n <= 30; n++) await writer.transaction([{ file: 'state/a.json', value: String(n) }, { file: 'state/b.json', value: String(n) }]); })(), (async () => { for (let n = 0; n < 30; n++) { const pair = await reader.snapshot(async () => { const a = await reader.readJson<number>('state/a.json'); await new Promise(resolve => setTimeout(resolve, 1)); return [a, await reader.readJson<number>('state/b.json')]; }); assert.equal(pair[0], pair[1]); } })() ]);
  } finally { await reader.close(); await writer.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('DAG preflight detects full cycles/missing/version before loading', () => {
  assert.throws(() => pluginOrder([definition('alpha', { beta: '*' }), definition('beta', { alpha: '*' })]), error => { assert.deepEqual((error as { details: { path: string[] } }).details.path, ['alpha', 'beta', 'alpha']); return true; });
  assert.throws(() => pluginOrder([definition('alpha', { missing: '*' })]), /缺少依赖/);
  assert.throws(() => pluginOrder([definition('alpha', { beta: '^2.0.0' }), definition('beta')]), /版本不兼容/);
  assert.throws(() => pluginOrder([definition('alpha', { beta: '*' }), definition('beta')], ['beta']), /已停用/);
  assert.deepEqual(pluginOrder([definition('delta', { beta: '*' }), definition('gamma', { beta: '*' }), definition('beta')]).map(item => item.manifest.id), ['beta', 'delta', 'gamma']);
  assert.equal(satisfies('0.0.2', '^0.0.1'), false); assert.equal(satisfies('1.2.9', '~1.2.3'), true);
});

test('host enforces dependency access and meta permissions, refresh failure blocks dependents and reverse stop', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data); const trace: string[] = [];
  try {
    const resource = (await manager.importResource(f.input)).resource;
    const foreign = await manager.createOrganization({ type: 'foreign', name: 'other', pluginId: 'other' });
    const a = definition('alpha', {}, async context => { trace.push('alpha.load'); context.registerCommand('test permission', async () => context.core.updatePluginMeta(resource.id, 'other', {})); context.registerCommand('test dependency', async () => context.getDependency('other')); context.registerCommand('test organization create', async () => context.core.createOrganization({ type: 'foreign', name: 'fake', pluginId: 'other' })); context.registerCommand('test organization update', async () => context.core.updateOrganization(foreign.id, { name: 'fake' })); context.registerCommand('test organization delete', async () => context.core.deleteOrganization(foreign.id)); return { api: { ready: true }, refresh: async () => { trace.push('alpha.refresh'); throw new Error('failed'); }, stop: async () => { trace.push('alpha.stop'); } }; });
    const b = definition('beta', { alpha: '^1.0.0' }, async context => { assert.equal(context.getDependency<{ ready: boolean }>('alpha').ready, true); trace.push('beta.load'); return { refresh: async () => { trace.push('beta.refresh'); }, stop: async () => { trace.push('beta.stop'); } }; });
    const host = new PluginHost(manager, [b, a]); await host.start(); await assert.rejects(host.execute('test permission', {}), /自己的meta/); await assert.rejects(host.execute('test dependency', {}), /显式声明/); await assert.rejects(host.execute('test organization create', {}), /伪造/); await assert.rejects(host.execute('test organization update', {}), /自己的组织/); await assert.rejects(host.execute('test organization delete', {}), /自己的组织/); await assert.rejects(host.refresh(), /刷新未完成/); assert(!trace.includes('beta.refresh')); await assert.rejects(host.setEnabled('alpha', false), /cascade/); await host.setEnabled('alpha', false, true); assert(trace.indexOf('beta.stop') < trace.indexOf('alpha.stop')); assert.equal(host.list().filter(item => item.enabled).length, 0); assert.equal((await manager.getResource(resource.id)).plugins.other, undefined); assert.equal((await manager.getOrganization(foreign.id)).name, 'other'); await host.stop();
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('backup validates hashes and refuses traversal before writing', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try { const backup = path.join(f.dir, 'bad.json'); await writeFile(backup, JSON.stringify({ schemaVersion: 1, entries: [{ file: 'resources/../../escape', hash: '', content: '' }] })); await assert.rejects(manager.restore(backup), /路径|校验/); assert.equal((await manager.listResources()).length, 0); } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('core remains usable with every business plugin disabled and retains plugin data', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try {
    await manager.pluginStore('core-host').write('state', { disabled: ['alpha'], dataVersions: {}, refreshSequence: 0 });
    await manager.pluginStore('alpha').write('formal', { retained: true });
    const host = new PluginHost(manager, [definition('alpha', {}, async () => { throw new Error('must never load'); })]);
    await host.start(); assert.equal(host.list()[0].enabled, false);
    const resource = (await manager.importResource(f.input)).resource;
    await manager.updatePluginMeta(resource.id, 'unknown', { future: true });
    const organization = await manager.createOrganization({ type: 'future-kind', name: '通用组织', references: [{ kind: 'resource', id: resource.id }] });
    await manager.updateOrganization(organization.id, { name: '修改' }); await manager.deleteOrganization(organization.id);
    assert.deepEqual((await manager.getResource(resource.id)).plugins.unknown.data, { future: true }); assert.deepEqual(await manager.pluginStore('alpha').read('formal', {}), { retained: true });
    assert.equal((await manager.check()).valid, true); await host.stop();
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('stale diagnostic locks cannot produce two OS writers and killed holder releases mutex', async () => {
  const f = await fixture(); await mkdir(f.data); await writeFile(path.join(f.data, '.writer.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const storageUrl = new URL('./storage.js', import.meta.url).href;
  const code = `import { FileStorage } from ${JSON.stringify(storageUrl)}; const store=new FileStorage(process.argv[1]); try { await store.init(); process.send({acquired:true}); process.on('message',async()=>{await store.close();process.exit(0)}); } catch(error) {process.send({acquired:false,code:error.code});process.disconnect();}`;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', code, f.data], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  try {
    const results = await Promise.all(children.map(child => new Promise<{ acquired: boolean; code?: string }>((resolve, reject) => { child.once('message', value => resolve(value as { acquired: boolean; code?: string })); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`lock worker exit ${code}`)); }); })));
    assert.equal(results.filter(value => value.acquired).length, 1); assert(results.filter(value => !value.acquired).every(value => value.code === 'WRITER_LOCKED'));
    const winner = children[results.findIndex(value => value.acquired)]; const exited = new Promise(resolve => winner.once('exit', resolve)); winner.kill('SIGKILL'); await exited;
    const recovered = await CoreManager.open(f.data); try { await recovered.importResource(f.input); assert.equal((await recovered.check()).valid, true); } finally { await recovered.close(); }
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(f.dir, { recursive: true, force: true }); }
});

test('restore prevalidates canonical paths and schema before any formal data write', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  const entry = (file: string, text = '0') => ({ file, content: Buffer.from(text).toString('base64'), hash: createHash('sha256').update(text).digest('hex') });
  const backup = path.join(f.dir, 'invalid-backup.json');
  try {
    const lock = await readFile(manager.storage.resolve('.writer.lock'), 'utf8');
    for (const unsafe of ['resources/../.writer.lock', 'resources/../journal/evil.json', 'resources\\..\\.writer.lock', 'state/generation.json:stream', 'state/./generation.json', 'state/.writer.lock', 'plugins/alpha/data/../../.writer.lock']) {
      await writeFile(backup, JSON.stringify({ schemaVersion: 1, entries: [entry('state/generation.json'), entry(unsafe)] })); await assert.rejects(manager.restore(backup), /路径/);
      assert.equal(await readFile(manager.storage.resolve('.writer.lock'), 'utf8'), lock); assert.deepEqual(await manager.storage.files('state'), []); assert.deepEqual(await manager.storage.files('journal'), []);
    }
    await writeFile(backup, JSON.stringify({ schemaVersion: 1, entries: [entry('plugins/alpha/data/value.json'), entry('plugins/alpha/data/VALUE.json')] })); await assert.rejects(manager.restore(backup), /路径重复/); assert.deepEqual(await manager.storage.files('plugins'), []);
    const id = '51c13446-5555-4555-9555-e55555555555';
    await writeFile(backup, JSON.stringify({ schemaVersion: 1, entries: [entry('state/generation.json'), entry(`metadata/${id}.meta`, JSON.stringify({ id, schemaVersion: 999 }))] })); await assert.rejects(manager.restore(backup), /结构版本/); assert.deepEqual(await manager.storage.files('state'), []); assert.deepEqual(await manager.storage.files('metadata'), []);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('unknown live core schema cannot be read or updated and organization patch cannot change ownership', async () => {
  const f = await fixture(); let manager = await CoreManager.open(f.data);
  try {
    const resource = (await manager.importResource(f.input)).resource;
    const owned = await manager.createOrganization({ type: 'custom', name: 'owned', pluginId: 'alpha' });
    await manager.updateOrganization(owned.id, { name: 'changed', pluginId: 'other', id: resource.id, schemaVersion: 999, type: 'hijacked' } as Parameters<CoreManager['updateOrganization']>[1]);
    const after = await manager.getOrganization(owned.id); assert.equal(after.pluginId, 'alpha'); assert.equal(after.id, owned.id); assert.equal(after.schemaVersion, 1); assert.equal(after.type, 'custom');
    await manager.updatePluginMeta(resource.id, 'future', { opaque: { unchanged: true } }, { schemaVersion: 99 });
    assert.equal((await manager.getResource(resource.id)).plugins.future.schemaVersion, 99);
    await manager.close(); await writeFile(path.join(f.data, `metadata/${resource.id}.meta`), JSON.stringify({ ...resource, schemaVersion: 999 })); manager = await CoreManager.open(f.data);
    await assert.rejects(manager.getResource(resource.id), /结构版本/); await assert.rejects(manager.updatePluginMeta(resource.id, 'future', {}), /结构版本/); assert.equal(JSON.parse(await readFile(path.join(f.data, `metadata/${resource.id}.meta`), 'utf8')).schemaVersion, 999);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('refresh failure fences cached APIs and commands across restart without loading blocked dependents', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data); const loadConsumption: number[] = []; let shouldFail = true; let upstream = 1; let cached: { read(): number } | undefined;
  const alpha = definition('alpha', {}, async context => { context.registerCommand('alpha read', async () => upstream); return { api: { read: () => upstream }, refresh: async () => { upstream = 2; if (shouldFail) throw new Error('partial update'); } }; });
  const beta = definition('beta', { alpha: '*' }, async context => { cached = context.getDependency<{ read(): number }>('alpha'); loadConsumption.push(cached.read()); context.registerCommand('beta consume', async () => ({ upstream: cached!.read(), dependent: 1 })); return { refresh: async () => { cached!.read(); } }; });
  let host = new PluginHost(manager, [beta, alpha]);
  try {
    await host.start(); await assert.rejects(host.refresh(), /刷新未完成/); assert.throws(() => cached!.read(), /上次更新失败/); await assert.rejects(host.execute('beta consume', {}), /上次更新失败/); assert(host.list().every(item => !item.ready));
    await host.stop(); host = new PluginHost(manager, [alpha, beta]); await host.start(); assert.deepEqual(loadConsumption, [1]); await assert.rejects(host.execute('beta consume', {}), /上次更新失败/); assert(host.list().every(item => !item.ready));
    await manager.importResource(f.input); assert.equal((await manager.listResources()).length, 1);
    shouldFail = false; await host.refresh(); assert.deepEqual(loadConsumption, [1, 2]); assert(host.list().every(item => item.ready)); assert.deepEqual(await host.execute('beta consume', {}), { upstream: 2, dependent: 1 });
  } finally { await host.stop(); await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('restore and ordinary IO reject existing junction ancestors before journal or external writes', async () => {
  const f = await fixture(); const source = await CoreManager.open(f.data); const backup = path.join(f.dir, 'valid-backup.json');
  try { await source.importResource(f.input); await source.backup(backup); } finally { await source.close(); }
  const outside = path.join(f.dir, 'outside'); await mkdir(outside);
  const targetDir = path.join(f.dir, 'target'); const manager = await CoreManager.open(targetDir);
  try {
    await symlink(outside, path.join(targetDir, 'resources'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(manager.restore(backup), /符号链接或junction/);
    assert.deepEqual(await manager.storage.files('journal'), []); assert.deepEqual(await manager.storage.files('metadata'), []); assert.deepEqual(await manager.storage.files('state'), []);
    assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(outside)), []);
    await assert.rejects(manager.storage.readBytes('resources/leak.txt'), /符号链接或junction/);
    await assert.rejects(manager.importResource(f.input), /符号链接或junction/);
    assert.deepEqual(await manager.storage.files('journal'), []);
    await rm(path.join(targetDir, 'resources')); await manager.importResource(f.input); assert.equal((await manager.check()).valid, true);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('future plugin dataVersion prevents load and dependent activation without downgrading persisted version', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data); let loads = 0; let migrations = 0;
  try {
    await manager.pluginStore('core-host').write('state', { disabled: [], dataVersions: { alpha: 99 }, refreshSequence: 0 });
    const host = new PluginHost(manager, [definition('alpha', {}, async context => { loads++; await context.store.write('must-not-write', {}); return { migrate: async () => { migrations++; } }; }), definition('beta', { alpha: '*' }, async () => { loads++; return {}; })]);
    await assert.rejects(host.start(), /不支持降级/); assert.equal(loads, 0); assert.equal(migrations, 0); assert.deepEqual(await manager.pluginStore('alpha').list(), []);
    assert.equal((await manager.pluginStore('core-host').read<{ dataVersions: Record<string, number> }>('state', { dataVersions: {} })).dataVersions.alpha, 99); await host.stop();
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('generic organization type CRUD, enabled policy, use protection, backup and schema validation', async () => {
  const f = await fixture(); const manager = await CoreManager.open(f.data);
  try {
    const type = await manager.registerOrganizationType({ id: 'reading-plan', name: '阅读计划', config: { order: 'manual' } });
    assert.equal((await manager.listOrganizationTypes()).length, 1); assert.equal(type.handlerPluginId, undefined);
    await assert.rejects(manager.registerOrganizationType({ id: 'other', name: 'other', handlerPluginId: 'missing' }), /处理器插件不存在/);
    const disabled = await manager.updateOrganizationType(type.id, { enabled: false }, 1); assert.equal(disabled.revision, 2);
    await assert.rejects(manager.createOrganization({ type: type.id, name: 'should-fail' }), /已停用/);
    await assert.rejects(manager.updateOrganizationType(type.id, { name: 'stale' }, 1), /版本已过期/);
    await manager.updateOrganizationType(type.id, { enabled: true, config: { mode: 'guided' } }, 2);
    const instance = await manager.createOrganization({ type: type.id, name: '第一阶段' });
    await manager.updateOrganizationType(type.id, { enabled: false }); assert.equal((await manager.getOrganization(instance.id)).name, '第一阶段'); await manager.updateOrganization(instance.id, { name: '保留维护' });
    await assert.rejects(manager.deleteOrganizationType(type.id), /仍有实例/);
    const backup = path.join(f.dir, 'types-backup.json'); await manager.backup(backup); const restored = await CoreManager.open(path.join(f.dir, 'restored'));
    try { await restored.restore(backup); assert.equal((await restored.getOrganizationType(type.id)).enabled, false); assert.equal((await restored.check()).organizationTypes, 1); assert.equal((await restored.check()).valid, true); } finally { await restored.close(); }
    await manager.deleteOrganization(instance.id); await manager.deleteOrganizationType(type.id); assert.deepEqual(await manager.listOrganizationTypes(), []);
    const legacy = await manager.createOrganization({ type: 'historical-custom', name: '历史未知类型兼容' }); assert.equal(legacy.type, 'historical-custom');
    await mkdir(path.join(f.data, 'organization-types'), { recursive: true }); await writeFile(path.join(f.data, 'organization-types', 'future.json'), JSON.stringify({ schemaVersion: 999, id: 'future' }));
    await assert.rejects(manager.getOrganizationType('future'), /结构版本/); assert.equal((await manager.check()).valid, false);
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }); }
});
