import { readFile, writeFile } from 'node:fs/promises';
import { modelLock, infer, emptyUsage } from '../../dist/recall/models.js';
import { openIndex, scopedFragments } from '../../dist/recall/index.js';
import { snapshot, allowed, resolveScope } from '../../dist/recall/scope.js';
const { dataDir } = JSON.parse(await readFile('artifacts/verification/v0.0.8/baseline.json', 'utf8'));
const { cases } = JSON.parse(await readFile('artifacts/verification/v0.0.8/suite.json', 'utf8'));
const source = await snapshot(dataDir); const index = await openIndex(dataDir); const lock = await modelLock(dataDir); const rows = []; const usage = emptyUsage();
try {
  const tune = cases.filter(c => c.split === 'tune');
  const vectors = await infer(dataDir, lock, 'embed', tune.map(c => c.query), usage, true);
  for (let i = 0; i < tune.length; i++) {
    const c = tune[i]; const scope = resolveScope(source.config, { scope: c.scope });
    const candidates = scopedFragments(index.db, source.records.filter(r => allowed(r, scope)).map(r => r.resourceId));
    const scores = candidates.map(x => ({ id: x.fragment.id, expected: c.expected.includes(x.fragment.resourceId), score: x.vector.reduce((sum, v, n) => sum + v * vectors.values[i][n], 0), text: x.fragment.text })).sort((a, b) => b.score - a.score);
    rows.push({ id: c.id, noAnswer: !c.expected.length, top: scores.slice(0, 3) });
  }
} finally { index.db.close(); }
await writeFile('artifacts/verification/v0.0.8/tuning-scores.json', JSON.stringify({ rows, usage }, null, 2));
console.log(JSON.stringify(rows));
