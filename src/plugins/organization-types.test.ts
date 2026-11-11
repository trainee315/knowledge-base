import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openApplication } from '../index.js';
import { CoreManager } from '../core/manager.js';
import type { OrganizationType } from '../contracts/index.js';

/** 比较整棵数据目录内容，证明只读启动没有偷偷初始化方式或插件状态。 */
async function fingerprint(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  try { await visit(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return result;
}

test('业务默认组织方式首次登记一次，只读零写，删除后重开与恢复不重建', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-type-defaults-')); const data = path.join(root, 'data');
  let app = await openApplication(data, { readOnly: true });
  try {
    assert.deepEqual(await app.manager.listOrganizationTypes(), []); await app.close();
    assert.deepEqual(await fingerprint(data), {}); assert.equal(await fs.stat(data).then(() => true, () => false), false);
    app = await openApplication(data);
    const defaults = await app.manager.listOrganizationTypes();
    assert.deepEqual(defaults.map(value => value.id).sort(), ['keyword', 'project-development-tracking', 'system', 'tag']);
    assert.equal(defaults.find(value => value.id === 'tag')!.handlerPluginId, 'tags');
    assert.equal(defaults.find(value => value.id === 'keyword')!.handlerPluginId, 'keywords');
    assert.equal(defaults.find(value => value.id === 'system')!.handlerPluginId, 'systems');
    assert.equal(defaults.find(value => value.id === 'project-development-tracking')!.handlerPluginId, 'project-tracking');
    assert.ok(defaults.every(value => value.revision === 1 && value.enabled));
    defaults[defaults.findIndex(value => value.id === 'system')] = await app.manager.updateOrganizationType('system', { name: '自定义体系名称', config: { defaultView: 'tree' }, enabled: false }, 1);
    await app.close(); const before = await fingerprint(data);
    app = await openApplication(data, { readOnly: true }); assert.deepEqual(await app.manager.listOrganizationTypes(), defaults); await app.close(); assert.deepEqual(await fingerprint(data), before);
    app = await openApplication(data); assert.deepEqual(await app.manager.listOrganizationTypes(), defaults);
    await app.manager.deleteOrganizationType('keyword'); await app.close(); app = await openApplication(data);
    await assert.rejects(app.manager.getOrganizationType('keyword'));
    assert.deepEqual((await app.manager.listOrganizationTypes()).map(value => value.id).sort(), ['project-development-tracking', 'system', 'tag']);
    const backup = path.join(root, 'backup.json'); await app.manager.backup(backup); await app.close();
    const archive = JSON.parse(await fs.readFile(backup, 'utf8')) as { entries: { file: string }[] };
    assert.ok(archive.entries.some(entry => entry.file === 'organization-types/tag.json'));
    assert.ok(archive.entries.some(entry => entry.file === 'organization-types/system.json'));
    assert.ok(archive.entries.some(entry => entry.file === 'organization-types/project-development-tracking.json'));
    assert.ok(!archive.entries.some(entry => entry.file === 'organization-types/keyword.json'));
    const restoredRoot = path.join(root, 'restored'); const restored = await CoreManager.open(restoredRoot);
    try { await restored.restore(backup); assert.deepEqual((await restored.listOrganizationTypes()).map(value => value.id).sort(), ['project-development-tracking', 'system', 'tag']); } finally { await restored.close(); }
    app = await openApplication(restoredRoot); assert.deepEqual((await app.manager.listOrganizationTypes()).map(value => value.id).sort(), ['project-development-tracking', 'system', 'tag']); assert.equal((await app.manager.check()).valid, true);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('通用组织方式CRUD、版本冲突、使用中保护和disabled保留旧组织', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-type-crud-')); const manager = await CoreManager.open(path.join(root, 'data'));
  try {
    const created = await manager.registerOrganizationType({ id: 'reading-list', name: '阅读列表', description: '通用组织处理器', config: { sort: 'manual' } });
    assert.equal(created.revision, 1); assert.equal(created.enabled, true); assert.deepEqual(await manager.getOrganizationType(created.id), created); assert.equal((await manager.listOrganizationTypes()).length, 1);
    assert.deepEqual(await manager.registerOrganizationType({ id: created.id, name: '重复登记不覆盖' }), created);
    const disabled = await manager.updateOrganizationType(created.id, { enabled: false, name: '我的阅读列表', config: { sort: 'title' } }, 1);
    assert.equal(disabled.revision, 2); assert.deepEqual(disabled.config, { sort: 'title' });
    await assert.rejects(manager.createOrganization({ type: created.id, name: '禁止新增' }));
    await assert.rejects(manager.updateOrganizationType(created.id, { enabled: true }, 1));
    const enabled = await manager.updateOrganizationType(created.id, { enabled: true }, disabled.revision);
    const organization = await manager.createOrganization({ type: created.id, name: '现有集合', data: { notes: '保留' } });
    await assert.rejects(manager.deleteOrganizationType(created.id));
    await manager.updateOrganizationType(created.id, { enabled: false }, enabled.revision);
    assert.equal((await manager.getOrganization(organization.id)).name, '现有集合'); assert.equal((await manager.listOrganizations(created.id)).length, 1);
    await manager.updateOrganization(organization.id, { name: '仍可维护旧集合' }); await assert.rejects(manager.createOrganization({ type: created.id, name: '禁止新增2' }));
    const archive = path.join(root, 'types-backup.json'); await manager.backup(archive); const restored = await CoreManager.open(path.join(root, 'restored'));
    try {
      await restored.restore(archive); assert.deepEqual(await restored.getOrganizationType(created.id), await manager.getOrganizationType(created.id));
      assert.equal((await restored.getOrganization(organization.id)).name, '仍可维护旧集合'); await assert.rejects(restored.createOrganization({ type: created.id, name: '恢复后仍禁新增' }));
    } finally { await restored.close(); }
    await manager.deleteOrganization(organization.id); await manager.deleteOrganizationType(created.id);
    await assert.rejects(manager.getOrganizationType(created.id)); assert.deepEqual(await manager.listOrganizationTypes(), []);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('独立CLI组织方式CRUD、默认业务方式disabled控制和只读并发', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-type-cli-')); const data = path.join(root, '中文 数据');
  const cli = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  function run(command: string[], input: Record<string, unknown> = {}, success = true) {
    const child = spawnSync(process.execPath, [cli, ...command, '--data-dir', data, '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(child.status, success ? 0 : 1, child.stdout + child.stderr); const output = JSON.parse(child.stdout) as { ok: boolean; data: unknown };
    assert.equal(output.ok, success); return output.data;
  }
  try {
    const created = run(['organization-type', 'register'], { id: 'collection', name: '集合', config: { layout: 'list' } }) as OrganizationType;
    assert.equal((run(['organization-type', 'get'], { id: created.id }) as OrganizationType).name, '集合');
    assert.ok((run(['organization-type', 'list']) as OrganizationType[]).some(value => value.id === created.id));
    const updated = run(['organization-type', 'update'], { id: created.id, enabled: false, config: { layout: 'tree' }, expectedRevision: 1 }) as OrganizationType;
    assert.equal(updated.enabled, false); assert.deepEqual(updated.config, { layout: 'tree' });
    run(['organization', 'create'], { type: created.id, name: '不能创建' }, false); run(['organization-type', 'delete'], { id: created.id });
    const tag = run(['tag', 'create'], { name: '现有标签' }) as { id: string };
    run(['organization-type', 'update'], { id: 'tag', enabled: false }); run(['tag', 'create'], { name: '禁止的新标签' }, false);
    assert.equal((run(['tag', 'get'], { id: tag.id }) as { id: string }).id, tag.id); run(['organization-type', 'delete'], { id: 'tag' }, false);
    const manager = await CoreManager.open(data);
    try { const before = await fingerprint(data); assert.ok((run(['organization-type', 'list']) as OrganizationType[]).length); assert.deepEqual(await fingerprint(data), before); } finally { await manager.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
