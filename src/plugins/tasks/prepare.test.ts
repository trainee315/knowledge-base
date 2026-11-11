import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoreManager, PluginHost } from '../../index.js';
import type { PluginDefinition } from '../../contracts/index.js';
import { tasksPlugin, type TasksApi } from './index.js';

test('prepare在预算前动态估0/淘汰旧任务，预算不足不阻零费用任务，耗时后不派发', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-task-prepare-')); const manager = await CoreManager.open(root);
  let tasks!: TasksApi; let calls = 0; let covered = false; let obsoleteExhausted = false;
  const probe: PluginDefinition = { manifest: { id: 'prepare-probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { tasks: '*' } }, async load(context) {
    tasks = context.getDependency<TasksApi>('tasks');
    tasks.register('dynamic', async () => { calls++; return {}; }, { async prepare(task) { return task.entityId === 'obsolete' ? { obsolete: true } : { estimatedCalls: covered ? 0 : 1 }; } });
    tasks.register('free', async () => { calls++; return {}; });
    tasks.register('slow-prepare', async () => { calls++; return {}; }, { async prepare() { await new Promise(resolve => setTimeout(resolve, 60)); return { estimatedCalls: 1 }; } });
    tasks.register('fail-until-obsolete', async () => { throw new Error('one failed attempt'); }, { async prepare() { return { obsolete: obsoleteExhausted }; } });
    return {};
  } };
  const host = new PluginHost(manager, [tasksPlugin, probe]); await host.start();
  try {
    const input = { inputVersion: '1', processorVersion: '1', payload: {} };
    await tasks.enqueue({ ...input, type: 'dynamic', entityId: 'paid', estimatedCalls: 9 });
    await tasks.enqueue({ ...input, type: 'free', entityId: 'free' }); await tasks.enqueue({ ...input, type: 'dynamic', entityId: 'obsolete', estimatedCalls: 9 });
    const first = await tasks.run(); assert.equal(first.calls, 0); assert.equal(calls, 1); assert.equal(first.completed, 2); assert.equal(first.unfinished, 1);
    covered = true; const next = await tasks.run(); assert.equal(next.calls, 0); assert.equal(next.completed, 1); assert.equal(calls, 2);
    await tasks.enqueue({ ...input, type: 'slow-prepare', entityId: 'slow' });
    const slow = await tasks.run({ maxDurationMs: 20, maxCalls: 1 }); assert.equal(slow.stopped, 'time-budget'); assert.equal(slow.calls, 0); assert.equal(calls, 2);
    const exhausted = await tasks.enqueue({ ...input, type: 'fail-until-obsolete', entityId: 'old-scope', maxAttempts: 1 });
    assert.equal((await tasks.run()).failed, 1); obsoleteExhausted = true;
    const retired = await tasks.run(); assert.equal(retired.completed, 1); assert.equal(retired.calls, 0); assert.equal(calls, 2);
    const retiredTask = (await tasks.list()).find(task => task.id === exhausted.id)!; assert.equal(retiredTask.status, 'completed'); assert.equal(retiredTask.attempts, 1);
  } finally { await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
