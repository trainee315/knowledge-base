import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreManager, PluginHost, openApplication } from '../dist/index.js';
import { builtinPlugins } from '../dist/plugins/index.js';
import assert from 'node:assert/strict';

const results = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function check(name, run) {
  const root = await mkdtemp(join(tmpdir(), 'kb-business-review-'));
  const initialized = await openApplication(join(root, 'data')); await initialized.close();
  const manager = await CoreManager.open(join(root, 'data'));
  const api = {};
  const probe = { manifest: { id: 'review-probe', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: Object.fromEntries(['scheduler', 'tasks', 'tags', 'organizer', 'relations', 'systems'].map((id) => [id, '*'])) }, async load(context) { for (const id of Object.keys(probe.manifest.dependencies)) api[id] = context.getDependency(id); return {}; } };
  const host = new PluginHost(manager, [...builtinPlugins, probe]);
  try { await host.start(); results.push({ name, observed: await run({ ...api, manager, host, root }) }); }
  catch (error) { results.push({ name, error: String(error) }); }
  finally { await host.stop(); await manager.close(); await rm(root, { recursive: true, force: true }); }
}
async function resource(manager, root, text = 'topic knowledge') { const file = join(root, 'topic.txt'); await writeFile(file, text); return (await manager.importResource(file)).resource; }

await check('scheduler failed task blocks same-day retry', async ({ tasks, scheduler }) => {
  tasks.register('review.fail', async () => { throw new Error('review failure'); });
  await tasks.enqueue({ type: 'review.fail', entityId: 'review', inputVersion: '1', processorVersion: '1', payload: {} });
  const first = await scheduler.tick('2026-11-11T04:00:00+08:00');
  return { first, state: await scheduler.get(), second: await scheduler.tick('2026-11-11T04:10:00+08:00') };
});

await check('scheduler timeout blocks same-day retry', async ({ tasks, scheduler }) => {
  tasks.register('review.timeout', async () => { await delay(40); return 'late'; });
  await tasks.enqueue({ type: 'review.timeout', entityId: 'review', inputVersion: '1', processorVersion: '1', payload: {}, timeoutMs: 5 });
  const first = await scheduler.tick('2026-11-11T04:00:00+08:00');
  await delay(60);
  return { first, state: await scheduler.get(), second: await scheduler.tick('2026-11-11T04:10:00+08:00') };
});

await check('timeout handler overlaps retry and overwrites newer effect', async ({ tasks, manager }) => {
  let call = 0;
  const store = manager.pluginStore('review-probe');
  tasks.register('review.late', async () => {
    const current = ++call; await delay(current === 1 ? 500 : 1);
    await store.write('effect', { call: current }); return { call: current };
  });
  const task = await tasks.enqueue({ type: 'review.late', entityId: 'review', inputVersion: '1', processorVersion: '1', payload: {}, timeoutMs: 100 });
  const first = await tasks.run({ maxTasks: 1 });
  let second, retryBlocked, runBlocked;
  try { await tasks.retry(task.id); second = await tasks.run({ maxTasks: 1 }); }
  catch (error) { retryBlocked = String(error); try { runBlocked = await tasks.run({ maxTasks: 1 }); } catch (error) { runBlocked = String(error); } }
  const beforeLate = await store.read('effect', null); await delay(650);
  const afterLate = await store.read('effect', null);
  let afterSettleRetry;
  if (retryBlocked) { await tasks.retry(task.id); afterSettleRetry = await tasks.run({ maxTasks: 1 }); }
  return { first, second, retryBlocked, runBlocked, beforeLate, afterLate, afterSettleRetry, finalEffect: await store.read('effect', null), task: (await tasks.list())[0] };
});

await check('provider switched during score changes recorded identity', async ({ tags, relations }) => {
  const tag = await tags.create({ name: 'topic' });
  let release, started;
  const waiting = new Promise((done) => { started = done; });
  relations.setProvider({ id: 'review-old', version: '1', kind: 'heuristic', async score() { started(); return new Promise((done) => { release = done; }); } });
  const scoring = relations.score(tag.id, ['topic']); await waiting;
  relations.setProvider({ id: 'review-new', version: '2', kind: 'heuristic', async score() { return [{ keyword: 'topic', score: 0, reason: 'new-provider' }]; } });
  release([{ keyword: 'topic', score: 0.9, reason: 'old-provider' }]);
  try { return await scoring; } catch (error) { return { rejected: String(error), saved: await relations.get(tag.id) ?? null }; }
});

await check('stale provider candidate remains visible and can be accepted', async ({ manager, root, tags, organizer, relations }) => {
  const imported = await resource(manager, root); const tag = await tags.create({ name: 'topic' });
  await organizer.run(); const candidate = (await organizer.candidates({ resourceId: imported.id }))[0];
  relations.setProvider({ id: 'review-new', version: '2', kind: 'heuristic', async score(_label, words) { return words.map(keyword => ({ keyword, score: 0, reason: 'new-provider' })); } });
  const visible = await organizer.candidates({ resourceId: imported.id });
  let submitted; try { submitted = await organizer.submit({ candidateId: candidate.id, accepted: true, reason: 'review acceptance' }); } catch (error) { submitted = { rejected: String(error) }; }
  return { originalProvider: candidate.provider, currentProvider: relations.provider(), visibleOld: visible.some(item => item.id === candidate.id), submitted };
});

await check('invalid argument types are silently accepted/coerced', async ({ host, tasks, scheduler, organizer }) => {
  const attempt = async (name, input) => { try { return { accepted: await host.execute(name, input, []) }; } catch (error) { return { rejected: String(error) }; } };
  const configured = await attempt('schedule configure', { enabled: 'false', time: 123 });
  const enabledFalse = await attempt('schedule configure', { enabled: 'false' });
  tasks.register('review.noop', async () => null);
  for (let i = 0; i < 3; i++) await tasks.enqueue({ type: 'review.noop', entityId: String(i), inputVersion: '1', processorVersion: '1', payload: {} });
  const fractional = await attempt('task run', { maxTasks: 1.5 });
  const query = await attempt('organize query', { filename: [{ unexpected: true }] });
  return { configured, enabledFalse, fractional, query };
});

await check('manual rejection/acceptance and stale tag/resource input', async ({ manager, root, tags, organizer }) => {
  const imported = await resource(manager, root); const tag = await tags.create({ name: 'topic' });
  await organizer.run(); const candidate = (await organizer.candidates())[0];
  const rejected = await tags.decide({ resourceId: imported.id, tagId: tag.id, accepted: false, source: 'manual', reason: 'manual no', contentVersion: 1, tagRevision: 1 });
  const protectedRejection = await tags.decide({ resourceId: imported.id, tagId: tag.id, accepted: true, source: 'automatic', reason: 'auto yes', contentVersion: 1, tagRevision: 1 });
  await tags.decide({ resourceId: imported.id, tagId: tag.id, accepted: true, source: 'manual', reason: 'manual yes', contentVersion: 1, tagRevision: 1 });
  const protectedAcceptance = await tags.decide({ resourceId: imported.id, tagId: tag.id, accepted: false, source: 'automatic', reason: 'auto no', contentVersion: 1, tagRevision: 1 });
  await tags.update(tag.id, { description: 'changed' });
  let staleTag; try { await organizer.submit({ candidateId: candidate.id, accepted: true, reason: 'stale' }); staleTag = 'ACCEPTED'; } catch (error) { staleTag = String(error); }
  const updated = join(root, 'new.txt'); await writeFile(updated, 'new version'); await manager.updateResource(imported.id, updated);
  let staleResource; try { await tags.decide({ resourceId: imported.id, tagId: tag.id, accepted: true, source: 'manual', reason: 'old', contentVersion: 1, tagRevision: 2 }); staleResource = 'ACCEPTED'; } catch (error) { staleResource = String(error); }
  return { rejected, protectedRejection, protectedAcceptance, staleTag, staleResource };
});

await check('system parents/cycles/references update and deletion protection', async ({ manager, root, systems }) => {
  const imported = await resource(manager, root); const system = await systems.create('review system');
  let cycle; try { await systems.update(system.id, { nodes: [{ id: 'a', title: 'a', order: 1, parentId: 'b' }, { id: 'b', title: 'b', order: 2, parentId: 'a' }] }); cycle = 'ACCEPTED'; } catch (error) { cycle = String(error); }
  let missingParent; try { await systems.addNode(system.id, { id: 'c', title: 'c', order: 1, parentId: 'missing' }); missingParent = 'ACCEPTED'; } catch (error) { missingParent = String(error); }
  const attached = await systems.addNode(system.id, { id: 'one', title: 'one', order: 1, resourceId: imported.id });
  await manager.deleteResource(imported.id);
  let purgeBlocked; try { await manager.purgeResource(imported.id); purgeBlocked = 'PURGED'; } catch (error) { purgeBlocked = String(error); }
  await manager.restoreResource(imported.id);
  const cleared = await systems.update(system.id, { nodes: [] });
  await manager.updatePluginMeta(imported.id, 'review-probe', {}, { references: [{ kind: 'organization', id: system.id }] });
  let deleteBlocked; try { await systems.delete(system.id); deleteBlocked = 'DELETED'; } catch (error) { deleteBlocked = String(error); }
  await manager.updatePluginMeta(imported.id, 'review-probe', {}, { references: [] }); await systems.delete(system.id);
  return { cycle, missingParent, attachedReferences: attached.references, clearedReferences: cleared.references, purgeBlocked, deleteBlocked, finalOrganizations: (await manager.listOrganizations()).length };
});

await writeFile(new URL('./business-review-result.json', import.meta.url), JSON.stringify(results, null, 2));
const observed = results.map(item => { assert.equal(item.error, undefined); return item.observed; });
for (const index of [0, 1]) { assert.equal(observed[index].state.lastDate, undefined); assert.equal(observed[index].second.triggered, true); }
assert.match(observed[2].retryBlocked, /TASK_DRAINING/);
assert.equal(observed[2].runBlocked.processed, 0); assert.equal(observed[2].runBlocked.stopped, 'attempt-draining');
assert.equal(observed[2].finalEffect.call, 2); assert.equal(observed[2].task.result.call, 2);
assert.match(observed[3].rejected, /STALE_PROVIDER/); assert.equal(observed[3].saved, null);
assert.equal(observed[4].visibleOld, false); assert.match(observed[4].submitted.rejected, /STALE_INPUT/);
for (const key of ['configured', 'fractional', 'query']) assert.match(observed[5][key].rejected, /INVALID_INPUT/);
assert.equal(observed[5].enabledFalse.accepted.config.enabled, false);
assert.equal(observed[6].protectedRejection.applied, false); assert.equal(observed[6].protectedAcceptance.applied, false);
assert.match(observed[6].staleTag, /STALE_INPUT/); assert.match(observed[6].staleResource, /STALE_INPUT/);
assert.equal(observed[7].clearedReferences.length, 0); assert.match(observed[7].purgeBlocked, /引用/); assert.match(observed[7].deleteBlocked, /引用/); assert.equal(observed[7].finalOrganizations, 0);
console.log(JSON.stringify({ passed: true, scenarios: results.length, evidence: 'artifacts/business-review-result.json' }));
