import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Audit automatic definitions before any temporary manual evaluation labels are configured.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
if (!args['data-dir'] || !args.snapshot || !args.output) throw new Error('Required: --data-dir --snapshot --output');
const dataDir = path.resolve(args['data-dir']);
const snapshot = JSON.parse(fs.readFileSync(path.resolve(args.snapshot), 'utf8'));
const db = new DatabaseSync(path.join(dataDir, 'cache/semantic/index.sqlite'), { readOnly: true });
const accepted = db.prepare(`SELECT e.*,f.payload fragmentPayload FROM match_evidence e
  JOIN fragments f ON e.fragment=f.id
  WHERE EXISTS(SELECT 1 FROM matches m WHERE m.tag=e.tag AND m.fragment=e.fragment)`).all()
  .map(row => ({ ...row, evidence: JSON.parse(row.payload), content: JSON.parse(row.fragmentPayload) }));
const jobs = db.prepare("SELECT id,state,wanted,published FROM jobs WHERE kind='tag'").all();
const review = snapshot.tags.map(tag => {
  const rows = accepted.filter(row => row.tag === tag.id)
    .sort((a, b) => b.score - a.score || a.fragment.localeCompare(b.fragment));
  const body = rows.filter(row => row.evidence.scope === 'body');
  const samples = [body[0], body.at(-1)].filter((row, index, values) => row && values.indexOf(row) === index);
  if (!samples.length && rows.length) samples.push(rows[0]);
  const job = jobs.find(item => item.id === tag.id);
  return {
    id: tag.id, name: tag.name, aliases: tag.data.aliases, origin: tag.data.semanticOrigin,
    ready: job?.state === 'ready' && job?.wanted === job?.published,
    matchDocuments: new Set(rows.map(row => row.content.resourceId)).size, acceptedBody: body.length,
    samples: samples.map(row => ({
      fragmentId: row.fragment, score: row.score, evidence: row.evidence, resource: row.content.resourceId,
      title: row.content.title, headings: row.content.headings, text: row.content.text,
    })),
  };
});
db.close();
const report = {
  method: 'Per automatic tag: strongest and weakest accepted body evidence; if absent, one accepted document-theme evidence. Stress sample, not a whole-library precision estimate. Judge names and evidence separately; document-theme evidence is not body evidence.',
  dataDir, tags: review,
};
fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: path.resolve(args.output), tags: review.length,
  ready: review.filter(tag => tag.ready).length, samples: review.reduce((sum, tag) => sum + tag.samples.length, 0),
  empty: review.filter(tag => !tag.samples.length).map(tag => tag.name) }, null, 2));
