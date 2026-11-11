import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CoreManager } from '../../core/manager.js';
import { PluginHost } from '../../core/plugins.js';
import type { PluginDefinition } from '../../contracts/index.js';
import contentPlugin, { type ContentApi } from './index.js';
import keywordsPlugin, { type KeywordsApi } from '../keywords/index.js';

async function helpers(manager: CoreManager) {
  let content!: ContentApi; let keywords!: KeywordsApi;
  const probe: PluginDefinition = { manifest: { id: 'version-probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { content: '^1.0.0', keywords: '^1.0.0' } }, async load(context) {
    content = context.getDependency<ContentApi>('content'); keywords = context.getDependency<KeywordsApi>('keywords'); return {};
  } };
  const host = new PluginHost(manager, [contentPlugin, keywordsPlugin, probe]); await host.start();
  return { content, keywords, close: () => host.stop() };
}

async function tree(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) if (file.isFile()) {
    const full = path.join(file.parentPath, file.name); result[path.relative(directory, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return result;
}

test('readVersion keeps pinned bytes, BOM/CRLF and history format; fromText is deterministic and readonly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-version-')); let manager = await CoreManager.open(path.join(dir, 'data'));
  try {
    const input = path.join(dir, 'first.json'); const original = '\uFEFF { "固定": "ＣＡＣＨＥ old" }\r\n\r\n'; await writeFile(input, original);
    const { resource } = await manager.importResource(input); await writeFile(input, '{"latest":"new"}'); await manager.updateResource(resource.id, input);
    await manager.close();
    // 离线旧库夹具模拟当前名称变化，历史格式仍必须取history.file。
    const metadata = path.join(dir, 'data', 'metadata', `${resource.id}.meta`); const meta = JSON.parse(await readFile(metadata, 'utf8')); meta.originalName = 'new.md'; await writeFile(metadata, JSON.stringify(meta));
    manager = await CoreManager.open(path.join(dir, 'data')); const api = await helpers(manager);
    try {
      const before = await tree(path.join(dir, 'data'));
      const pinned = await api.content.readVersion(resource.id, 1);
      assert.equal(pinned.rawText, original); assert.equal(pinned.text, original.slice(1)); assert.equal(pinned.status, 'parsed'); assert.equal(pinned.extension, '.json'); assert.equal(pinned.format, '.json'); assert.equal(pinned.filename, 'version-1.json'); assert.equal(pinned.originalNameKnown, false);
      assert.equal(pinned.contentHash, createHash('sha256').update(original).digest('hex')); assert.equal(pinned.contentVersion, 1);
      const derived = api.keywords.fromText(pinned.rawText!); assert.deepEqual(derived, api.keywords.fromText(pinned.rawText!)); assert.ok(derived.items.some(item => item.value === 'cache')); assert.ok(!derived.items.some(item => item.value === 'latest')); assert.equal(api.keywords.normalize('  ＣＡＣＨＥ \n Test '), 'cache test');
      assert.deepEqual(await tree(path.join(dir, 'data')), before);
      await assert.rejects(api.content.readVersion(resource.id, 0), error => (error as { code?: string }).code === 'INVALID_ARGUMENT'); await assert.rejects(api.content.readVersion(resource.id, 99), error => (error as { code?: string }).code === 'NOT_FOUND');
      assert.throws(() => api.keywords.fromText(null as unknown as string), /必须为字符串/);
    } finally { await api.close(); }
    await manager.close(); manager = await CoreManager.open(path.join(dir, 'data'), { readOnly: true }); const readonly = await helpers(manager);
    try { const before = await tree(path.join(dir, 'data')); assert.equal((await readonly.content.readVersion(resource.id, 1)).rawText, original); readonly.keywords.fromText(original); assert.deepEqual(await tree(path.join(dir, 'data')), before); } finally { await readonly.close(); }
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
});

test('readVersion distinguishes malformed JSON, invalid UTF8 and unsupported original without writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-version-format-')); const manager = await CoreManager.open(path.join(dir, 'data'));
  try {
    const entries = [['bad.json', Buffer.from(' { bad }\r\n'), 'failed'], ['bad.txt', Buffer.from([0xff, 0xfe]), 'failed'], ['image.bin', Buffer.from('some text'), 'unsupported']] as const;
    const api = await helpers(manager);
    try { for (const [name, bytes, status] of entries) { const file = path.join(dir, name); await writeFile(file, bytes); const { resource } = await manager.importResource(file); const before = await tree(path.join(dir, 'data')); const result = await api.content.readVersion(resource.id, 1); assert.equal(result.status, status); assert.equal(result.originalNameKnown, true); assert.equal(result.rawText, name === 'bad.txt' ? null : bytes.toString()); assert.deepEqual(await tree(path.join(dir, 'data')), before); } } finally { await api.close(); }
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
});

test('readVersion rejects hash mismatch and future content schema without masking original bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-version-integrity-')); const manager = await CoreManager.open(path.join(dir, 'data'));
  try {
    const input = path.join(dir, 'note.txt'); await writeFile(input, 'original'); const { resource } = await manager.importResource(input); await writeFile(input, 'latest'); const updated = await manager.updateResource(resource.id, input); const api = await helpers(manager);
    try {
      await writeFile(manager.storage.resolve(updated.history[0].file), 'corrupted');
      await assert.rejects(api.content.readVersion(resource.id, 1), error => (error as { code?: string }).code === 'CONTENT_HASH_MISMATCH');
      await manager.updatePluginMeta(resource.id, 'content', { future: true }, { schemaVersion: 99 });
      const before = await tree(path.join(dir, 'data')); await assert.rejects(api.content.readVersion(resource.id, 2), error => (error as { code?: string }).code === 'UNSUPPORTED_PLUGIN_SCHEMA'); assert.deepEqual(await tree(path.join(dir, 'data')), before);
    } finally { await api.close(); }
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
});
