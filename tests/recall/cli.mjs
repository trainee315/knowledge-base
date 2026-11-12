import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serviceCli } from '../service-cli.mjs';
import { fixture } from './fixture.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'kb-recall-cli-')); const dataDir = path.join(root, 'data');
const data = await fixture(dataDir); let started = false;
try {
  serviceCli(dataDir, ['service', 'start']); started = true;
  const scope = { projectId: 'alpha', modules: ['battle'] };
  const overview = serviceCli(dataDir, ['recall', 'scope'], { input: { scope } }); assert.equal(overview.records, 4);
  const id = data.records.find(r => r.project === 'alpha' && r.key === 'combo').id;
  const read = serviceCli(dataDir, ['recall', 'read', '--id', id], { input: { scope } }); assert.equal(read.usage.modelCalls, 0);
  serviceCli(dataDir, ['recall', 'index', 'build']);
  const result = serviceCli(dataDir, ['recall', 'search'], { input: { query: '连击窗口', scope, retrievalMode: 'lexical' } });
  assert.ok(result.evidence.some(e => e.resourceId === id)); assert.ok(result.evidence.every(e => e.projectId === 'alpha')); assert.equal(result.usage.modelCalls, 0);
  const list = serviceCli(dataDir, ['recall', 'list'], { input: { scope } }); assert.equal(list.page.total, 4);
  serviceCli(dataDir, ['resource', 'delete', '--id', id]);
  const deleted = serviceCli(dataDir, ['recall', 'search'], { input: { query: '连击窗口', scope, retrievalMode: 'lexical' } }); assert.ok(deleted.evidence.every(e => e.resourceId !== id));
  const report = { passed: true, checks: ['service CLI dispatch', 'single JSON', 'scope', 'read without index/model', 'index build', 'BM25', 'list', 'deletion without rebuild'], dataDir };
  await writeFile('artifacts/verification/v0.0.8/cli.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { if (started) serviceCli(dataDir, ['service', 'stop']); }
