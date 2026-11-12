import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { serviceCli } from '../service-cli.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'kb-recall-demo-')); const dataDir = path.join(root, 'data');
const data = await fixture(dataDir);
const scope = { projectId: 'alpha', modules: ['battle'] };
for (const [name, input] of Object.entries({ scope: { scope }, request: { task: '如何实现连续命中的攻击加成', scope, retrievalMode: 'lexical' }, read: { id: data.records.find(r => r.project === 'alpha' && r.key === 'combo').id, scope }, suite: { cases: data.queries } })) await writeFile(path.join(root, name + '.json'), JSON.stringify(input, null, 2));
serviceCli(dataDir, ['service', 'start']);
try { serviceCli(dataDir, ['recall', 'index', 'build']); }
finally { serviceCli(dataDir, ['service', 'stop']); }
console.log(JSON.stringify({ dataDir, commands: [
  `node dist/cli/main.js service start --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js recall scope --input "${path.join(root, 'scope.json')}" --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js recall prepare --input "${path.join(root, 'request.json')}" --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js recall read --input "${path.join(root, 'read.json')}" --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js recall model prepare --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js recall index build --vectors --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js recall eval --input "${path.join(root, 'suite.json')}" --data-dir "${dataDir}" --json`,
  `node dist/cli/main.js service stop --data-dir "${dataDir}" --json`,
] }, null, 2));
