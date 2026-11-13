import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Private corpus/annotations stay outside the repository; the evaluator only reads source and SQLite.
const DEFAULT_SAMPLE_SIZE = 120;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const dataDir = path.resolve(args['data-dir'] ?? '.data');
const baselinePath = path.resolve(args.baseline ?? '.data/quality-v15-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const digest = value => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(path.join(dataDir, 'cache/semantic/index.sqlite'), { readOnly: true });
const all = (sql, ...parameters) => db.prepare(sql).all(...parameters);
const tags = fs.readdirSync(path.join(dataDir, 'organizations')).filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(fs.readFileSync(path.join(dataDir, 'organizations', file), 'utf8')))
  .filter(tag => tag.type === 'tag' && !tag.data.semanticDeletedAt);
const fragments = new Map(all('SELECT id,payload FROM fragments').map(row => [row.id, JSON.parse(row.payload)]));
const terms = all('SELECT id,name FROM keyword_terms');
const links = all('SELECT keyword,resource,fragment,value,start,end,score FROM keyword_links');
const matches = all('SELECT tag,fragment,score FROM matches');
const jobs = all('SELECT kind,id,state,wanted,published FROM jobs');
const termsByResource = new Map();
const linksByKeyword = new Map();
for (const link of links) {
  if (!termsByResource.has(link.resource)) termsByResource.set(link.resource, new Set());
  termsByResource.get(link.resource).add(normalize(link.value));
  if (!linksByKeyword.has(link.keyword)) linksByKeyword.set(link.keyword, []);
  linksByKeyword.get(link.keyword).push(link);
}

function metrics(cases) {
  const tp = cases.filter(item => item.expected && item.actual).length;
  const fp = cases.filter(item => !item.expected && item.actual).length;
  const fn = cases.filter(item => item.expected && !item.actual).length;
  const tn = cases.filter(item => !item.expected && !item.actual).length;
  return { pairs: cases.length, tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}

// Only explicitly annotated pairs are scored. Missing evaluation labels are visible failures.
const labels = baseline.labels.map(expected => {
  const tag = tags.find(item => normalize(item.name) === normalize(expected.name));
  const hitResources = new Set(matches.filter(item => item.tag === tag?.id).map(item => fragments.get(item.fragment)?.resourceId));
  const cases = expected.cases.map(item => ({ ...item, actual: hitResources.has(item.resource) }));
  const job = jobs.find(item => item.kind === 'tag' && item.id === tag?.id);
  const configMatches = !!tag && normalize(String(tag.data.description ?? '')) === normalize(expected.description)
    && expected.aliases.every(alias => (tag.data.aliases ?? []).some(value => normalize(value) === normalize(alias)));
  return { name: expected.name, split: expected.split, id: tag?.id, ready: job?.state === 'ready' && job?.wanted === job?.published,
    configMatches, metrics: metrics(cases), failures: cases.filter(item => item.actual !== item.expected), cases };
});
const concepts = baseline.concepts.map(item => ({ ...item,
  retained: item.accepted.some(value => termsByResource.get(item.resource)?.has(normalize(value))) }));
const retained = concepts.filter(item => item.retained).length;
const sourceTexts = new Map();
const preservation = baseline.documents.map(document => {
  const file = path.join(dataDir, 'resources/md', `${document.id}.md`);
  if (!fs.existsSync(file)) return { id: document.id, preserved: false, reason: 'missing' };
  const bytes = fs.readFileSync(file); sourceTexts.set(document.id, bytes.toString('utf8'));
  return { id: document.id, preserved: digest(bytes) === document.hash };
});
const offsetFailures = links.filter(link => {
  const text = sourceTexts.get(link.resource);
  return text !== undefined && text.slice(link.start, link.end) !== link.value;
}).map(({ resource, fragment, value, start, end }) => ({ resource, fragment, value, start, end }));

function category(value) {
  const chinese = /\p{Script=Han}/u.test(value), latin = /\p{Script=Latin}/u.test(value);
  return chinese && latin ? 'mixed' : chinese ? 'chinese' : 'latin-other';
}

// Deterministic round-robin sampling covers language and long/template-heavy source strata.
const strata = new Map();
for (const term of terms) {
  const evidence = linksByKeyword.get(term.id) ?? [];
  const fromLong = evidence.some(link => (sourceTexts.get(link.resource)?.length ?? 0) > 1800);
  const key = `${category(term.name)}:${fromLong ? 'long' : 'short'}`;
  if (!strata.has(key)) strata.set(key, []);
  strata.get(key).push(term);
}
for (const values of strata.values()) values.sort((a, b) => digest(a.id).localeCompare(digest(b.id)));
const requested = Number(args['sample-size'] ?? DEFAULT_SAMPLE_SIZE);
if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('sample-size must be a positive integer');
const sample = [];
const sortedStrata = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b));
while (sample.length < Math.min(requested, terms.length)) {
  for (const [stratum, values] of sortedStrata) {
    const term = values.shift();
    if (!term || sample.length >= requested) continue;
    const evidence = (linksByKeyword.get(term.id) ?? []).slice().sort((a, b) => b.score - a.score).slice(0, 2).map(link => {
      const fragment = fragments.get(link.fragment);
      const text = sourceTexts.get(link.resource) ?? '';
      return { resource: link.resource, title: fragment?.title, headings: fragment?.headings,
        excerpt: text.slice(Math.max(0, link.start - 90), Math.min(text.length, link.end + 90)), score: link.score };
    });
    sample.push({ ...term, stratum, evidence });
  }
}
const annotations = args.annotations ? JSON.parse(fs.readFileSync(path.resolve(args.annotations), 'utf8')) : [];
const annotated = sample.map(item => ({ id: item.id, name: item.name, annotation: annotations.find(row => row.id === item.id)?.status ?? 'unreviewed' }));
const unknownAnnotation = annotations.find(row => !['valid', 'invalid', 'uncertain'].includes(row.status));
if (unknownAnnotation) throw new Error(`Unknown annotation status: ${unknownAnnotation.status}`);
const reviewed = annotated.filter(item => item.annotation !== 'unreviewed');
const valid = annotated.filter(item => item.annotation === 'valid');
const report = {
  dataDir, baselineHash: digest(fs.readFileSync(baselinePath)), method: baseline.protocol,
  counts: { resources: sourceTexts.size, fragments: fragments.size, keywords: terms.length, tags: tags.length },
  preservation: { checked: preservation.length, failures: preservation.filter(item => !item.preserved) },
  offsets: { checked: links.filter(link => sourceTexts.has(link.resource)).length, failures: offsetFailures },
  rejectedTermsPresent: baseline.rejectedTerms.filter(value => terms.some(term => normalize(term.name) === normalize(value))),
  keywordRetention: { total: concepts.length, retained, rate: retained / concepts.length, missing: concepts.filter(item => !item.retained) },
  labelMetrics: Object.fromEntries(['development', 'heldout'].map(split => [split, metrics(labels.filter(label => label.split === split).flatMap(label => label.cases))])),
  labelEvaluationReady: labels.every(label => label.ready && label.configMatches),
  labels,
  keywordReview: { sampled: sample.length, reviewed: reviewed.length, valid: valid.length, validRate: reviewed.length === sample.length ? valid.length / sample.length : null, annotations: annotated },
  sample,
  automaticTags: tags.filter(tag => tag.data.semanticOrigin === 'automatic').map(tag => ({ id: tag.id, name: tag.name, aliases: tag.data.aliases })),
};
db.close();
if (args.output) fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: args.output ? path.resolve(args.output) : null,
  counts: report.counts, preservation: report.preservation, offsets: { checked: report.offsets.checked, failures: report.offsets.failures.length },
  rejectedTermsPresent: report.rejectedTermsPresent, keywordRetention: { total: concepts.length, retained, rate: retained / concepts.length },
  labelEvaluationReady: report.labelEvaluationReady,
  labelMetrics: report.labelMetrics, labels: labels.map(label => ({ name: label.name, split: label.split, ready: label.ready, configMatches: label.configMatches, metrics: label.metrics })),
  keywordReview: { sampled: sample.length, reviewed: reviewed.length, valid: valid.length, validRate: report.keywordReview.validRate },
}, null, 2));
