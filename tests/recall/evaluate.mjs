import { readFile, writeFile } from 'node:fs/promises';
import { CoreManager } from '../../dist/index.js';
import { buildIndex } from '../../dist/recall/index.js';
import { modelLock } from '../../dist/recall/models.js';
import { evaluate } from '../../dist/recall/evaluate.js';
import { TOPICS } from './fixture.mjs';

const baseline = JSON.parse(await readFile('artifacts/verification/v0.0.8/baseline.json', 'utf8'));
const dataDir = baseline.dataDir; const manager = await CoreManager.open(dataDir, { readOnly: true });
let records; try { records = (await manager.listResources()).map(x => x.resource); } finally { await manager.close(); }
const cases = [];
for (let i = 0; i < TOPICS.length; i++) {
  const [key, module, title, body, paraphrase, exact] = TOPICS[i];
  const resource = records.find(r => r.originalName === `${title}-alpha.md.md`);
  for (const [kind, query] of [['exact', exact], ['paraphrase', paraphrase]]) cases.push({ id: `${key}-${kind}`, split: i < 4 ? 'tune' : 'acceptance', query, scope: { projectId: 'alpha', modules: [module] }, expected: [resource.id], required: [body] });
}
for (const project of ['alpha', 'beta']) cases.push({ id: `${project}-no-answer`, split: project === 'alpha' ? 'tune' : 'acceptance', query: '税务申报的发票编号规则', scope: { projectId: project, modules: ['battle'] }, expected: [], required: [] });
await writeFile('artifacts/verification/v0.0.8/suite.json', JSON.stringify({ cases }, null, 2));
const useModels = process.argv.includes('--models'); const mode = process.argv.includes('--acceptance') ? 'acceptance' : 'tune';
const built = await buildIndex(dataDir, useModels, false);
await writeFile(`artifacts/verification/v0.0.8/index-${useModels ? 'models' : 'lexical'}.json`, JSON.stringify(built, null, 2));
console.log(JSON.stringify({ indexed: built.fragments, durationMs: built.durationMs, usage: built.usage }));
const modes = useModels ? ['literal', 'bm25', 'semantic', 'hybrid', 'hybrid-rerank', 'task'] : ['literal', 'bm25'];
const result = await evaluate(dataDir, { cases: cases.filter(c => c.split === mode), modes });
await writeFile(`artifacts/verification/v0.0.8/${mode}-${useModels ? 'models' : 'lexical'}.json`, JSON.stringify({ ...result, model: await modelLock(dataDir) }, null, 2));
console.log(JSON.stringify(result.summary));
