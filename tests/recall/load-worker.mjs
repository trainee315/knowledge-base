import { readFile, readdir, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepare } from '../../dist/recall/recall.js';
import { buildIndex } from '../../dist/recall/index.js';
const { dataDir } = JSON.parse(await readFile('artifacts/verification/v0.0.8/baseline.json', 'utf8'));
const mode = process.argv[2]; const started = performance.now(); let runs = 0; const stats = [];
let deferred = 0;
let stopped = false; process.stdin.on('data', () => { stopped = true; }); process.stdin.on('end', () => { stopped = true; });
console.log('ready');
while (!stopped && performance.now() - started < 60_000) {
  try {
  if (mode === 'query') stats.push((await prepare(dataDir, { query: '如何实现连续命中的攻击加成', scope: { projectId: 'alpha', modules: ['battle'] }, rerank: true })).usage);
  else {
    if (mode === 'index-cold') {
      const resolved = await realpath(dataDir); const temporary = await realpath(tmpdir());
      if (!resolved.startsWith(temporary + path.sep) || !path.basename(path.dirname(resolved)).startsWith('kb-recall-baseline-')) throw new Error('NOT_SYNTHETIC_FIXTURE');
      const cache = path.join(resolved, 'cache', 'recall-vectors');
      for (const name of await readdir(cache)) if (/^[a-f0-9]{64}\.json$/.test(name)) await unlink(path.join(cache, name));
    }
    stats.push((await buildIndex(dataDir, true, true)).usage);
  }
  runs++;
  } catch (error) {
    if (error.code !== 'DEVELOPMENT_BUSY' && !String(error.message).includes('DEVELOPMENT_BUSY')) throw error;
    deferred++; await new Promise(resolve => setTimeout(resolve, 200));
  }
}
console.log(JSON.stringify({ mode, runs, deferred, durationMs: performance.now() - started, stats }));
