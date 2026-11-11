import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { CoreManager } from '../../core/manager.js';
import { PluginHost } from '../../core/plugins.js';
import type { PluginDefinition } from '../../contracts/index.js';
import { tasksPlugin, type TasksApi } from './index.js';

// 独立基准使用临时目录，不污染用户知识库；1000条输入验证批次重启恢复。
const TASK_COUNT = 1000;
const BATCH_SIZE = 100;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-task-benchmark-'));
let api!: TasksApi;
const probe: PluginDefinition = {
  manifest: { id: 'benchmark', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { tasks: '*' } },
  async load(context) {
    api = context.getDependency<TasksApi>('tasks');
    api.register('benchmark', async task => ({ entityId: task.entityId }));
    return {};
  },
};
let manager = await CoreManager.open(root);
let host = new PluginHost(manager, [tasksPlugin, probe]);
await host.start();
const started = performance.now();
try {
  for (let index = 0; index < TASK_COUNT; index++) await api.enqueue({ type: 'benchmark', entityId: `resource-${index}`, inputVersion: '1', processorVersion: '1', payload: {} });
  const enqueuedMs = performance.now() - started;
  const first = await api.run({ maxTasks: BATCH_SIZE });
  await host.stop(); await manager.close();
  manager = await CoreManager.open(root); host = new PluginHost(manager, [tasksPlugin, probe]); await host.start();
  let batches = 1;
  while ((await api.list()).some(task => task.status !== 'completed')) { await api.run({ maxTasks: BATCH_SIZE }); batches++; }
  const after = await api.list();
  if (after.length !== TASK_COUNT || after.some(task => task.status !== 'completed' || task.attempts !== 1)) throw new Error('基准验证失败：丢失、重复或未完成任务');
  process.stdout.write(JSON.stringify({ tasks: TASK_COUNT, firstBatch: first.completed, batches, restarts: 1, completed: after.length, duplicateExecutions: 0, enqueuedMs: Math.round(enqueuedMs), totalMs: Math.round(performance.now() - started), note: '真实文件队列；轻量处理器；不代表1000资源正文处理性能' }) + '\n');
} finally { await host.stop(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
