import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { handleService } from '../../service/client.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CoreManager } from '../../core/manager.js';
import { PluginHost } from '../../core/plugins.js';
import { contentPlugin } from '../content/index.js';
import { keywordsPlugin } from '../keywords/index.js';
import { tagsPlugin } from '../tags/index.js';
import { projectTrackingPlugin } from './index.js';
import type { Organization, ResourceMeta } from '../../contracts/index.js';
import type { AddProjectEntryInput, ProjectData, ProjectDocument, ProjectQueryResult } from './types.js';

const definitions = [contentPlugin, keywordsPlugin, tagsPlugin, projectTrackingPlugin];
async function fixture(withService = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-project-unit-'));
  const dataDir = path.join(root, 'data');
  if (withService) await handleService(['start'], dataDir);
  const manager = await CoreManager.open(dataDir);
  const plugins = new PluginHost(manager, definitions); await plugins.start();
  const exec = <T = unknown>(name: string, input: object = {}) => plugins.execute(`project-track ${name}`, input as Record<string, unknown>) as Promise<T>;
  const create = (name = '项目甲') => exec<Organization>('create', { name });
  async function resource(name: string, text: string) { const file = path.join(root, name); await fs.writeFile(file, text); return (await manager.importResource(file)).resource; }
  const add = (projectId: string, source: ResourceMeta, patch: Partial<AddProjectEntryInput> = {}) => exec<{ entry: ProjectData['entries'][number]; replayed: boolean }>('add', { projectId, resourceId: source.id, title: '记录', role: 'baseline', stage: 'confirmed', projectVersion: '1.0.0', ...patch });
  return { root, manager, plugins, exec, create, resource, add, async close() { await plugins.stop(); await manager.close(); if (withService) await handleService(['stop'], dataDir); await fs.rm(root, { recursive: true, force: true }); } };
}

test('项目固定全文/标签别名/关键词快照；旧版本unknown与显式known-empty不混淆', async () => {
  const f = await fixture();
  try {
    const project = await f.create(); const source = await f.resource('基线.json', '\uFEFF{ "knowledge": "first raw", "n": 1 }\n');
    const tag = await f.plugins.execute('tag create', { name: '领域', aliases: ['oldalias'] }) as Organization;
    await f.plugins.execute('tag decide', { resourceId: source.id, tagId: tag.id, accepted: true, source: 'manual', reason: '已确认', contentVersion: 1, tagRevision: tag.revision });
    const { entry } = await f.add(project.id, source);
    assert.equal(entry.snapshot.tags.source, 'resource-meta'); assert.equal(entry.snapshot.tags.items[0].name, '领域');
    assert.ok(entry.snapshot.keywords.includes('knowledge'));
    await f.plugins.execute('tag update', { id: tag.id, name: '改名', aliases: ['newalias'] });
    const next = path.join(f.root, '新版.json'); await fs.writeFile(next, '{"replacement":"second"}'); await f.manager.updateResource(source.id, next);
    const read = await f.exec<ProjectDocument>('read', { projectId: project.id, entryId: entry.id });
    assert.equal(read.text, '\uFEFF{ "knowledge": "first raw", "n": 1 }\n');
    const old = await f.exec<ProjectQueryResult>('query', { projectId: project.id, tags: ['oldalias'], keywords: ['KNOWL'] });
    assert.equal(old.total, 1); assert.equal(old.items[0].entry.id, entry.id);
    assert.equal((await f.exec<ProjectQueryResult>('query', { projectId: project.id, tags: ['newalias'] })).total, 0);
    const history = await f.add(project.id, source, { role: 'state', contentVersion: 1, title: '旧版登记' });
    assert.equal(history.entry.snapshot.tags.status, 'unknown'); assert.equal(history.entry.snapshot.originalNameKnown, false);
    const empty = await f.add(project.id, source, { role: 'state', contentVersion: 1, tags: [] });
    assert.equal(empty.entry.snapshot.tags.status, 'known'); assert.deepEqual(empty.entry.snapshot.tags.items, []);
    await f.manager.updatePluginMeta(source.id, 'content', { future: true }, { schemaVersion: 99 });
    assert.equal((await f.exec<ProjectDocument>('read', { projectId: project.id, entryId: entry.id })).text, read.text);
  } finally { await f.close(); }
});

test('requestId先于动态默认值解析；并发追加无丢失且同请求只登记一次', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const source = await f.resource('source.txt', 'initial words');
    const first = await f.add(p.id, source, { requestId: 'first' });
    const next = path.join(f.root, 'updated.txt'); await fs.writeFile(next, 'changed current'); await f.manager.updateResource(source.id, next);
    const replay = await f.add(p.id, source, { requestId: 'first' });
    assert.equal(replay.replayed, true); assert.equal(replay.entry.id, first.entry.id); assert.equal(replay.entry.contentVersion, 1);
    await assert.rejects(f.add(p.id, source, { requestId: 'first', title: 'different' }), /requestId/u);
    const pair = await Promise.all([f.add(p.id, source, { role: 'state', requestId: 'same' }), f.add(p.id, source, { role: 'state', requestId: 'same' })]);
    assert.equal(pair[0].entry.id, pair[1].entry.id); assert.equal(pair.filter(x => x.replayed).length, 1);
    await Promise.all(Array.from({ length: 8 }, (_, i) => f.add(p.id, source, { role: 'change', title: `追加${i}` })));
    assert.equal(((await f.exec<Organization>('get', { projectId: p.id })).data as unknown as ProjectData).entries.length, 10);
  } finally { await f.close(); }
});

test('版本先于日期/全文分页/基线独立去重；asOf替代范围不受标签过滤和未来记录污染', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const source = await f.resource('正文.md', `# 基线\n${'完整内容'.repeat(3000)}`);
    const base = await f.add(p.id, source, { recordedAt: '2030-01-01T00:00:00+08:00' });
    const change = await f.add(p.id, source, { role: 'change', projectVersion: '1.2.0', recordedAt: '2020-01-01T00:00:00Z', replaces: { entryIds: [base.entry.id], scope: '构建流程', effect: '仅计划修改', }, stage: 'planned' });
    await f.add(p.id, source, { role: 'state', projectVersion: '1.1.0', recordedAt: '2040-01-01T00:00:00Z' });
    const page = await f.exec<ProjectQueryResult>('query', { projectId: p.id, limit: 1 });
    assert.equal(page.total, 3); assert.equal(page.items[0].entry.id, change.entry.id); assert.equal(page.baseline?.entry.id, base.entry.id); assert.equal(page.hasMore, true);
    assert.ok(page.items[0].text.length > 10000); assert.equal(page.baseline?.replacement.replacedBy[0].stage, 'planned');
    const past = await f.exec<ProjectQueryResult>('query', { projectId: p.id, asOfVersion: 'v1.0.0' });
    assert.equal(past.total, 1); assert.equal(past.baseline, null); assert.equal(past.baselineEntryId, base.entry.id); assert.deepEqual(past.items[0].replacement.replacedBy, []);
    assert.equal((await f.exec<ProjectQueryResult>('query', { projectId: p.id, keywords: ['missing'] })).baseline, null);
    assert.equal((await f.exec<ProjectQueryResult>('query', { projectId: p.id, keywords: ['missing'], includeBaseline: true })).baseline?.entry.id, base.entry.id);
    await assert.rejects(f.add(p.id, source, { projectVersion: '2.0.0' }), /baseline/u);
    const revised = await f.add(p.id, source, { projectVersion: '2.0.0', replaces: { entryIds: [base.entry.id], scope: '基线', effect: '确认新基线' } });
    assert.equal((await f.exec<ProjectQueryResult>('query', { projectId: p.id, limit: 1 })).baselineEntryId, revised.entry.id);
  } finally { await f.close(); }
});

test('项目范围/引用保护/备份恢复/future schema/非法解析及参数拒绝', async () => {
  const f = await fixture();
  try {
    const p = await f.create(); const other = await f.create('项目乙'); const source = await f.resource('source.txt', 'protected original');
    await assert.rejects(f.add(p.id, source, { role: 'state' }), /baseline/u);
    const entry = (await f.add(p.id, source)).entry;
    await assert.rejects(f.add(other.id, source, { replaces: { entryIds: [entry.id], scope: 'x', effect: 'y' } }), /同一项目/u);
    await assert.rejects(f.exec('read', { projectId: other.id, entryId: entry.id }), /不存在/u);
    const bad = await f.resource('bad.json', '{'); await assert.rejects(f.add(p.id, bad, { role: 'state' }), /严格解析/u);
    const binary = await f.resource('bad.bin', 'not supported'); await assert.rejects(f.add(p.id, binary, { role: 'state' }), /严格解析/u);
    await assert.rejects(f.exec('query', { projectId: p.id, limit: 1.5 }), /整数/u);
    await assert.rejects(f.exec('query', { projectId: p.id, tags: [{}] }), /字符串数组/u);
    await assert.rejects(f.add(p.id, source, { role: 'state', projectVersion: '1.2' }), /三段/u);
    await f.manager.deleteResource(source.id);
    assert.equal((await f.exec<ProjectDocument>('read', { projectId: p.id, entryId: entry.id })).text, 'protected original');
    await assert.rejects(f.manager.purgeResource(source.id), /引用/u);
    const backup = path.join(f.root, 'backup.json'); await f.manager.backup(backup);
    const restored = await CoreManager.open(path.join(f.root, 'restored'));
    try { await restored.restore(backup); const org = await restored.getOrganization(p.id); assert.equal((org.data as unknown as ProjectData).entries[0].contentHash, entry.contentHash); await assert.rejects(restored.purgeResource(source.id), /引用/u); } finally { await restored.close(); }
    const original = await f.manager.getOrganization(p.id);
    await f.manager.updateOrganization(p.id, { data: { ...original.data, schemaVersion: 99 } }, original.revision);
    await assert.rejects(f.add(p.id, source, { role: 'state' }), /不支持的项目/u);
    assert.equal((await f.manager.getOrganization(p.id)).data.schemaVersion, 99);
  } finally { await f.close(); }
});

test('真实CLI只读命令在writer持锁时零写入；参数失败退出2；替代标注使用过滤前全域', async () => {
  const f = await fixture(true);
  try {
    const project = await f.create(); const source = await f.resource('cli.txt', 'original cli body');
    const tag = await f.plugins.execute('tag create', { name: '仅旧文档', aliases: ['old-only'] }) as Organization;
    const original = await f.add(project.id, source, { tags: [tag.id] });
    const replacement = await f.add(project.id, source, { role: 'decision', projectVersion: '1.1.0', tags: [], replaces: { entryIds: [original.entry.id], scope: '接口', effect: '替代确认', }, stage: 'confirmed' });
    const selected = await f.exec<ProjectQueryResult>('query', { projectId: project.id, tags: ['old-only'] });
    assert.equal(selected.items.length, 1); assert.equal(selected.items[0].replacement.replacedBy[0].entryId, replacement.entry.id);
    async function hashes() {
      const root = path.join(f.root, 'data');
      const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
      const records = await Promise.all(entries.filter(item => item.isFile()).map(async item => {
        const filename = path.join(item.parentPath, item.name); const stat = await fs.stat(filename);
        return [path.relative(root, filename), stat.mtimeMs, createHash('sha256').update(await fs.readFile(filename)).digest('hex')];
      }));
      return records.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    }
    const before = await hashes();
    const cli = (action: string, input: object) => spawnSync(process.execPath, [fileURLToPath(new URL('../../cli/main.js', import.meta.url)), 'project-track', action, '--data-dir', path.join(f.root, 'data'), '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8' });
    for (const action of ['list', 'get', 'documents', 'read', 'query']) {
      const result = cli(action, { projectId: project.id, entryId: original.entry.id });
      assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
    }
    for (const input of [{}, { projectId: project.id, includeBaseline: 'garbage' }, { projectId: project.id, offset: 'x' }, { projectId: project.id, limit: 1.5 }, { projectId: project.id, keywords: [{}] }]) {
      const result = cli('query', input); assert.equal(result.status, 2, result.stdout); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENT');
    }
    assert.deepEqual(await hashes(), before);
    await assert.rejects(f.add(project.id, source, { role: 'state', recordedAt: '2026-02-30T00:00:00Z' }), /无效日期/u);
  } finally { await f.close(); }
});
