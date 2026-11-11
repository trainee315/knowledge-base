import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CoreManager } from '../core/manager.js';

const cli = fileURLToPath(new URL('./main.js', import.meta.url));
function run(dataDir: string, args: string[], input?: unknown) { const result = spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir, '--json'], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8' }); const lines = result.stdout.trim().split(/\r?\n/); assert.equal(lines.length, 1, result.stderr); return { ...result, data: JSON.parse(lines[0]) }; }

test('CLI has single-object output, UTF8 input, correct exit codes and read-only queries alongside writer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-cli-'));
  const dataDir = path.join(dir, '中文 空格');
  try {
    let result = run(dataDir, ['--json', 'resource', 'list']); assert.equal(result.status, 0); assert.deepEqual(result.data.data, []);
    result = run(dataDir, ['resource', 'import']); assert.equal(result.status, 2); assert.equal(result.data.error.code, 'INVALID_ARGUMENT');
    result = run(dataDir, ['resource', 'get', '--id', 'not-a-uuid']); assert.equal(result.status, 1); assert.equal(result.data.error.code, 'INVALID_ID');
    const source = path.join(dir, '中文.md'); await writeFile(source, '# 单一 JSON 输出\n脚本导入');
    result = run(dataDir, ['resource', 'import', '--input', '-'], { file: source }); assert.equal(result.status, 0, result.stdout); const id = result.data.data.resource.id;
    const manager = await CoreManager.open(dataDir);
    try { const stateBefore = await readFile(manager.storage.resolve('plugins/tasks/data/queue.json'), 'utf8'); result = run(dataDir, ['resource', 'list']); assert.equal(result.status, 0); assert.equal(result.data.data.length, 1); result = run(dataDir, ['organize', 'query', '--input', '-'], { filename: ['中文'] }); assert.equal(result.status, 0); assert.equal(result.data.data.total, 1); const stateAfter = await readFile(manager.storage.resolve('plugins/tasks/data/queue.json'), 'utf8'); assert.equal(stateAfter, stateBefore); result = run(dataDir, ['resource', 'delete', '--id', id]); assert.equal(result.status, 1); assert.equal(result.data.error.code, 'WRITER_LOCKED'); } finally { await manager.close(); }
    result = run(dataDir, ['resource', 'delete', '--id', id]); assert.equal(result.status, 0); result = run(dataDir, ['resource', 'restore', '--id', id]); assert.equal(result.status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
