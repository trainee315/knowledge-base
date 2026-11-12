import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { openApplication } from '../../dist/index.js';

const root = await mkdtemp(path.join(tmpdir(), 'kb-recall-baseline-')); const dataDir = path.join(root, 'data');
const data = await fixture(dataDir); const rows = [];
for (const q of data.queries) {
  const started = performance.now(); const app = await openApplication(dataDir, { readOnly: true });
  try {
    const result = await app.plugins.execute('organize query', { body: [q.query], limit: 1000 }, []);
    const ids = result.items.map(x => x.resource.id).filter(id => data.config.resources[id]?.projectId === q.scope.projectId && data.config.resources[id]?.modules.includes(q.scope.modules[0])).slice(0, 5);
    rows.push({ id: q.id, split: q.split, expected: q.expected.length, hits: ids.filter(id => q.expected.includes(id)).length, returned: ids.length, durationMs: performance.now() - started });
  } finally { await app.close(); }
}
const workloads = [];
for (let repeat = 0; repeat < 5; repeat++) for (const workload of ['build', 'tests']) {
  const command = workload === 'build' ? ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'] : ['--test', 'dist/core/core.test.js'];
  const start = performance.now(); const child = spawnSync(process.execPath, command, { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  workloads.push({ repeat, workload, durationMs: performance.now() - start, exitCode: child.status }); if (child.status !== 0) throw new Error(child.stderr + child.stdout);
}
const snapshot = createHash('sha256').update(JSON.stringify(data.records.map(({ project, key, content }) => ({ project, key, content })))).digest('hex');
const output = { at: new Date().toISOString(), baseline: '81387b5 + recall scaffolding; existing organizer unchanged', fixtureSnapshot: snapshot, dataDir, hardware: { cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() }, rows, workloads };
await mkdir('artifacts/verification/v0.0.8', { recursive: true });
await writeFile('artifacts/verification/v0.0.8/baseline.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ dataDir, rows: rows.length, workloads: workloads.length, fixtureSnapshot: snapshot }));
