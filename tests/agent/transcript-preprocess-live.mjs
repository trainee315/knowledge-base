import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { openApplication, CoreManager } from '../../dist/index.js';
import { discover, readSession, joinSessions } from '../../dist/records/source.js';
import { transcriptCommand, prepareTranscriptInput, plan, previewSummary } from '../../dist/records/transcript.js';
import { configuration, directoryMatches } from '../../dist/records/config.js';
import { textSize } from '../../dist/records/preprocess.js';
import { redactCredentials } from '../../dist/records/redaction.js';

// 显式授权的本地实测入口；真实材料、响应与费用账本全部写入忽略目录。
if (!process.argv.includes('--live')) throw new Error('Requires explicit --live and authorization for private session data');
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const stage = process.argv.includes('--stage') ? argument('--stage') : 'prepare';
if (!['prepare', 'history', 'incremental', 'report'].includes(stage)) throw new Error('Unknown stage');
const dataDir = resolve(process.argv.includes('--data-dir') ? argument('--data-dir') : '.data');
const experiment = process.argv.includes('--experiment') ? argument('--experiment') : undefined;
if (experiment !== undefined && experiment !== 'aggressive') throw new Error('Unknown experiment');
const modes = experiment ? ['off', 'conservative', 'aggressive'] : ['off', 'conservative'];
const id = process.argv.includes('--id') ? argument('--id') : undefined;
if (!id || id.startsWith('--')) throw new Error('Requires explicit --id for the authorized transcript instance');
const runtime = join(dataDir, '.runtime/v0.0.9', experiment ?? '');
const manifestFile = join(runtime, 'manifest.json');
const ledgerFile = join(runtime, 'calls.json');
await mkdir(runtime, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
async function read(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; } }
async function organization() { return transcriptCommand(dataDir, 'get', { id }); }
let manifest = await read(manifestFile, null);
let ledger = await read(ledgerFile, { version: 'v0.0.9', attempts: [] });

// 即使结构解析失败，也记录已发生的供应商调用及其可取得的usage。
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Unexpected live endpoint');
  const body = JSON.parse(options.body);
  const request = textSize(body.messages.map(message => message.content).join(''));
  const attempt = { at: new Date().toISOString(), stage, round: manifest?.round ?? 1, request, inputFingerprint: digest(options.body), model: body.model };
  ledger.attempts.push(attempt);
  attempt.requestFile = join(runtime, `request-${String(ledger.attempts.length).padStart(3, '0')}.json`);
  await writeFile(attempt.requestFile, redactCredentials(options.body, manifest && process.env[manifest.profile.credentialEnv] ? [process.env[manifest.profile.credentialEnv]] : []).text);
  await save(ledgerFile, ledger);
  try {
    const response = await nativeFetch(url, options);
    attempt.httpStatus = response.status;
    try {
      const result = await response.clone().json();
      const responseFile = join(runtime, `response-${String(ledger.attempts.length).padStart(3, '0')}.json`);
      const known = manifest && process.env[manifest.profile.credentialEnv] ? [process.env[manifest.profile.credentialEnv]] : [];
      await writeFile(responseFile, redactCredentials(JSON.stringify(result, null, 2), known).text);
      attempt.responseFile = responseFile;
      if (result.usage) attempt.usage = result.usage;
      if (result.model) attempt.actualModel = result.model;
    } catch { attempt.responseUnreadable = true; }
    attempt.finishedAt = new Date().toISOString();
    await save(ledgerFile, ledger);
    return response;
  } catch (error) {
    attempt.failed = true;
    await save(ledgerFile, ledger);
    throw error;
  }
};

async function sources(config, cutoff) {
  const files = (await Promise.all(['sessions', 'archived_sessions'].map(async dir => {
    try { return await discover(join(config.sourceRoot, dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
  }))).flat();
  const fragments = [];
  for (const file of files) {
    const session = await readSession(file, Date.parse(cutoff));
    if (!session.child && !session.afterCutoff && directoryMatches(config, session.directories)) fragments.push(session);
  }
  return joinSessions(fragments);
}

if (stage === 'prepare') {
  if (manifest) throw new Error('Frozen manifest already exists; reuse it');
  if (experiment) {
    const original = await read(join(dataDir, '.runtime/v0.0.9/manifest.json'), null);
    if (!original || original.id !== id) throw new Error('Original frozen samples are unavailable');
    const sessions = await sources(original.org.data.config, original.cutoff);
    const samples = original.samples.map(sample => {
      const all = sessions.find(session => session.id === sample.entry.sessionId)?.turns.flatMap(turn => turn.messages) ?? [];
      const hydrate = message => {
        const source = all.find(item => item.position === message.position && item.fingerprint === message.fingerprint);
        if (!source) throw new Error('Frozen source fingerprint changed');
        return { ...message, ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}) };
      };
      return { entry: sample.entry, feature: sample.feature, messages: sample.messages.map(hydrate), context: sample.context.map(hydrate), scores: sample.scores, comparisons: {} };
    });
    manifest = { version: 'v0.0.9', experiment, round: 1, id, cutoff: original.cutoff, org: original.org, profile: original.profile, samples, batches: [] };
    await save(manifestFile, manifest);
    console.log(JSON.stringify({ stage, experiment, cutoff: manifest.cutoff, samples: samples.map(sample => ({ feature: sample.feature, modes: modes.map(mode => { const p = prepareTranscriptInput(manifest.org.data.config.focus, sample.context, sample.messages, mode); return { mode, before: p.cleaning.stats.before.characters, after: p.cleaning.stats.after.characters, requestCharacters: p.characters }; }) })) }));
  } else {
  const org = await organization();
  const cutoff = new Date().toISOString();
  if (org.data.lease?.expires > Date.now()) throw new Error('Transcript is currently running');
  const sessions = await sources(org.data.config, cutoff);
  const pool = org.data.entries.map(entry => {
    const session = sessions.find(item => item.id === entry.sessionId);
    if (!session) throw new Error('Historical source missing');
    const all = session.turns.flatMap(turn => turn.messages);
    const messages = entry.messages.map(ref => {
      const message = all.find(item => item.position === ref.position && item.fingerprint === ref.fingerprint);
      if (!message) throw new Error('Historical provenance mismatch');
      return message;
    });
    let context = all.filter(message => message.position < messages[0].position).slice(-2);
    if (Buffer.byteLength(JSON.stringify(context)) > org.data.config.maxChunkBytes / 4) context = [];
    const spoken = messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => message.content).join('\n');
    const tools = messages.filter(message => message.role === 'tool-result').map(message => message.content).join('\n');
    return { entry, messages, context, scores: { tools: textSize(tools).characters, corrections: (spoken.match(/纠正|改为|作废|撤销|更正|调整为/gu) ?? []).length, verification: (spoken.match(/验证|测试|失败|修复|错误|通过/gu) ?? []).length } };
  });
  const samples = [];
  for (const feature of ['tools', 'corrections', 'verification']) {
    const available = pool.filter(candidate => !samples.some(sample => sample.entry.resourceId === candidate.entry.resourceId));
    available.sort((a, b) => b.scores[feature] - a.scores[feature] || a.messages[0].at.localeCompare(b.messages[0].at) || a.messages[0].position - b.messages[0].position || a.entry.sessionId.localeCompare(b.entry.sessionId));
    samples.push({ ...available[0], feature, comparisons: {} });
  }
  const app = await openApplication(dataDir, { readOnly: true });
  let profiles;
  try { profiles = (await app.manager.pluginStore('agent').read('profiles', { profiles: [] })).profiles; } finally { await app.close(); }
  const profile = profiles.find(profile => profile.id === org.data.config.profile);
  if (!profile || !process.env[profile.credentialEnv]) throw new Error('Live profile credential is unavailable');
  manifest = { version: 'v0.0.9', id, cutoff, org, profile, samples, batches: [] };
  const preview = previewSummary(await plan(org, { to: cutoff, preprocessing: 'conservative' }));
  manifest.initialPreview = preview;
  await save(manifestFile, manifest);
  console.log(JSON.stringify({ stage, cutoff, historicalSamples: samples.map(sample => ({ feature: sample.feature, messages: sample.messages.length, before: prepareTranscriptInput(org.data.config.focus, sample.context, sample.messages, 'off').cleaning.stats.before.characters, after: prepareTranscriptInput(org.data.config.focus, sample.context, sample.messages).cleaning.stats.after.characters })), candidates: preview.candidates.length, inputBytes: preview.inputBytes, blocked: preview.skips.filter(skip => skip.reason === 'oversized-turn' || skip.reason.startsWith('source-error:')) }));
  }
} else {
  if (!manifest || manifest.id !== id) throw new Error('Run --stage prepare first');
  if (experiment && process.argv.includes('--round')) {
    const round = Number(argument('--round'));
    if (!Number.isSafeInteger(round) || round < manifest.round || round > manifest.round + 1) throw new Error('Invalid experiment round');
    if (round > manifest.round) {
      if (!manifest.complete) throw new Error('Finish the existing round first');
      manifest.previousRounds ??= [];
      manifest.previousRounds.push({ round: manifest.round, samples: manifest.samples.map(sample => ({ feature: sample.feature, comparison: sample.comparisons.aggressive })) });
      const feature = process.argv.includes('--feature') ? argument('--feature') : undefined;
      if (feature && !manifest.samples.some(sample => sample.feature === feature)) throw new Error('Unknown sample feature');
      for (const sample of manifest.samples) if (!feature || sample.feature === feature) delete sample.comparisons.aggressive;
      manifest.round = round;
      manifest.complete = false;
      await save(manifestFile, manifest);
    }
  }
  const known = process.env[manifest.profile.credentialEnv] ? [process.env[manifest.profile.credentialEnv]] : [];
  if (stage === 'history') {
    const evaluationDir = join(runtime, 'evaluation');
    const manager = await CoreManager.open(evaluationDir);
    try { await manager.pluginStore('agent').write('profiles', { schemaVersion: 1, profiles: [manifest.profile] }); } finally { await manager.close(); }
    const evaluator = await openApplication(evaluationDir);
    try { await evaluator.plugins.refresh(); } finally { await evaluator.close(); }
    for (const sample of manifest.samples) for (const mode of modes) {
      let comparison = sample.comparisons[mode];
      if (!comparison) {
        const config = configuration({ ...manifest.org.data.config, alias: `v009-r${manifest.round ?? 1}-${sample.feature}-${mode}`, enabled: false, preprocessing: mode, maxCalls: 0 });
        const org = await transcriptCommand(evaluationDir, 'create', config);
        comparison = sample.comparisons[mode] = { organizationId: org.id };
        const writer = await openApplication(evaluationDir);
        try {
          const current = await writer.manager.getOrganization(org.id);
          const prepared = prepareTranscriptInput(config.focus, sample.context, sample.messages, mode, known);
          current.data.tasks = [{ id: digest(JSON.stringify(sample.entry.messages)), sessionId: sample.entry.sessionId, messages: sample.messages, context: sample.context, config, cutoff: manifest.cutoff, backfill: true, status: 'pending', prepared }];
          await writer.manager.updateOrganization(org.id, { data: current.data }, current.revision);
        } finally { await writer.close(); }
        await save(manifestFile, manifest);
      }
      if (comparison.resourceId) continue;
      console.log(JSON.stringify({ stage, feature: sample.feature, mode, state: 'calling' }));
      const outcome = await transcriptCommand(evaluationDir, 'retry', { id: comparison.organizationId, maxCalls: 1 });
      const entries = await transcriptCommand(evaluationDir, 'records', { id: comparison.organizationId });
      comparison.resourceId = entries.at(-1).resourceId;
      comparison.outcome = outcome;
      await save(manifestFile, manifest);
      console.log(JSON.stringify({ stage, feature: sample.feature, mode, state: 'saved', calls: outcome.calls }));
    }
    if (experiment) { manifest.complete = true; await save(manifestFile, manifest); }
  }
  if (stage === 'incremental') {
    for (;;) {
      const org = await organization();
      const pending = org.data.tasks.filter(task => task.status !== 'success').length;
      const preview = await transcriptCommand(dataDir, 'preview', { id, to: manifest.cutoff, preprocessing: 'conservative' });
      const blocked = preview.skips.filter(skip => skip.reason === 'oversized-turn' || skip.reason.startsWith('source-error:'));
      if (blocked.length) throw new Error(JSON.stringify({ blocked }));
      if (!pending && !preview.candidates.length) { manifest.complete = true; await save(manifestFile, manifest); break; }
      console.log(JSON.stringify({ stage, pending, candidates: preview.candidates.length, state: 'calling' }));
      const outcome = await transcriptCommand(dataDir, pending ? 'retry' : 'run', { id, to: manifest.cutoff, preprocessing: 'conservative', maxCalls: 1 });
      manifest.batches.push(outcome);
      await save(manifestFile, manifest);
      console.log(JSON.stringify({ stage, ...outcome, skips: undefined }));
      if (!outcome.saved && !outcome.calls) throw new Error('No progress under configured budgets');
    }
  }
  if (stage === 'report') {
    const evaluation = await openApplication(join(runtime, 'evaluation'), { readOnly: true });
    try {
      for (const sample of manifest.samples) for (const mode of modes) {
        const comparison = sample.comparisons[mode];
        if (!comparison?.resourceId) continue;
        comparison.resource = await evaluation.manager.getResource(comparison.resourceId);
        comparison.body = (await evaluation.manager.readContent(comparison.resourceId)).toString('utf8');
      }
    } finally { await evaluation.close(); }
    const app = await openApplication(dataDir, { readOnly: true });
    try {
      const org = await app.manager.getOrganization(id);
      const old = new Set(manifest.org.data.entries.map(entry => entry.resourceId));
      manifest.newRecords = [];
      if (!experiment) for (const entry of org.data.entries.filter(entry => !old.has(entry.resourceId))) manifest.newRecords.push({ entry, resource: await app.manager.getResource(entry.resourceId), body: (await app.manager.readContent(entry.resourceId)).toString('utf8') });
      manifest.check = await app.manager.check();
    } finally { await app.close(); }
    await save(manifestFile, manifest);
    const summarize = (resource, label) => {
      const data = resource.plugins.transcripts.data;
      const prepared = data.preprocessing;
      const before = prepared.cleaning.stats.before, after = prepared.cleaning.stats.after;
      const rules = {};
      for (const change of prepared.cleaning.stats.changes) {
        const rule = rules[change.rule] ??= { hits: 0, removedCharacters: 0 };
        rule.hits++; rule.removedCharacters += change.before - change.after;
      }
      return { label, before, after, removedCharacters: before.characters - after.characters, reductionPercent: (before.characters - after.characters) / before.characters * 100, roles: prepared.cleaning.stats.roles, rules, request: { beforeCharacters: prepared.beforeCharacters, afterCharacters: prepared.characters, beforeBytes: prepared.beforeBytes, afterBytes: prepared.bytes }, usage: data.usage, model: data.model.actualModel, promptVersion: data.promptVersion };
    };
    const history = manifest.samples.map(sample => ({ feature: sample.feature, ...Object.fromEntries(modes.map(mode => [mode, summarize(sample.comparisons[mode].resource, sample.feature + '-' + mode)])) }));
    const incremental = manifest.newRecords.map((item, index) => summarize(item.resource, 'session-' + (index + 1)));
    const totals = incremental.reduce((sum, item) => ({ beforeCharacters: sum.beforeCharacters + item.before.characters, afterCharacters: sum.afterCharacters + item.after.characters, beforeBytes: sum.beforeBytes + item.before.bytes, afterBytes: sum.afterBytes + item.after.bytes, inputTokens: sum.inputTokens + item.usage.inputTokens, outputTokens: sum.outputTokens + item.usage.outputTokens }), { beforeCharacters: 0, afterCharacters: 0, beforeBytes: 0, afterBytes: 0, inputTokens: 0, outputTokens: 0 });
    totals.removedCharacters = totals.beforeCharacters - totals.afterCharacters;
    totals.reductionPercent = totals.beforeCharacters ? totals.removedCharacters / totals.beforeCharacters * 100 : 0;
    const actualUsage = ledger.attempts.reduce((sum, attempt) => ({ inputTokens: sum.inputTokens + (attempt.usage?.prompt_tokens ?? 0), outputTokens: sum.outputTokens + (attempt.usage?.completion_tokens ?? 0), totalTokens: sum.totalTokens + (attempt.usage?.total_tokens ?? 0) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const metrics = { version: 'v0.0.9', cutoff: manifest.cutoff, complete: manifest.complete ?? false, checkValid: manifest.check.valid, characterUnit: 'Unicode code points of selected message content; context counted separately in request sizes', history, incremental, totals, calls: { total: ledger.attempts.length, history: ledger.attempts.filter(item => item.stage === 'history').length, incremental: ledger.attempts.filter(item => item.stage === 'incremental').length, usage: actualUsage } };
    await save(join(runtime, 'metrics.json'), metrics);
    console.log(JSON.stringify({ stage, complete: manifest.complete, historyRecords: manifest.samples.reduce((sum, sample) => sum + Object.values(sample.comparisons).filter(item => item.resourceId).length, 0), newRecords: manifest.newRecords.length, calls: ledger.attempts.length, checkValid: manifest.check.valid }));
    console.log(JSON.stringify({ totals, calls: metrics.calls }));
  }
}
