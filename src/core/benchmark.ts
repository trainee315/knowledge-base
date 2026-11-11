import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { CoreManager } from './manager.js';

// 合成规模用于首期人工验收，不在每次单元测试重复耗时任务。
const RESOURCE_COUNT = 1000;
const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-benchmark-'));
const manager = await CoreManager.open(path.join(dir, 'data'));
try {
  const input = path.join(dir, 'input.md'); const start = performance.now();
  for (let index = 0; index < RESOURCE_COUNT; index++) { await writeFile(input, `# 合成资源 ${index}\n基准内容 knowledge ${index}`); await manager.importResource(input, { originalName: `note-${index}.md` }); }
  const importedMs = performance.now() - start;
  const pageStart = performance.now(); const page = await manager.listResources({ offset: 900, limit: 50 }); const pagedMs = performance.now() - pageStart; assert.equal(page.length, 50);
  const reindexStart = performance.now(); const indexed = await manager.reindex(); const reindexMs = performance.now() - reindexStart; assert.equal(indexed.resources, RESOURCE_COUNT);
  const checkStart = performance.now(); const checked = await manager.check(); const checkMs = performance.now() - checkStart; assert.equal(checked.valid, true);
  await manager.close(); const reader = await CoreManager.open(path.join(dir, 'data'), { readOnly: true });
  let coldReadMs: number; try { const coldStart = performance.now(); assert.equal((await reader.listResources({ offset: 900, limit: 50 })).length, 50); coldReadMs = performance.now() - coldStart; } finally { await reader.close(); }
  console.log(JSON.stringify({ resources: RESOURCE_COUNT, importedMs, pagedMs, reindexMs, checkMs, coldReadMs, valid: checked.valid }));
} finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
