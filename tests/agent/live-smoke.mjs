import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForSecret } from './secret-scan.mjs';

// 真实调用必须双重显式启用；请求账本留在仓库外，跨进程累计最多五次。
const LIMIT = 5;
const MODEL = 'deepseek-flash';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PRIVATE_ROOT = join(homedir(), 'AppData/Local/knowledge-base');
const SECRET_FILE = join(PRIVATE_ROOT, 'credentials/deepseek-test-v002.secrets.json');
const LEDGER_FILE = join(PRIVATE_ROOT, 'verification/v0.0.2-live-ledger.json');
const OUTPUT = join(REPO, 'artifacts/verification/v0.0.2');
const stageIndex = process.argv.indexOf('--stage');
const stage = stageIndex >= 0 ? process.argv[stageIndex + 1] : 'core';
const optedIn = process.argv.includes('--live') && process.env.KB_AGENT_LIVE === '1';
const nativeFetch = globalThis.fetch;

function failure(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) { return typeof error?.code === 'string' && /^(AGENT|LIVE|INVALID|STALE)_[A-Z_]+$/.test(error.code) ? error.code : 'LIVE_VERIFICATION_FAILED'; }
function safeUsage(value) { return Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].map((key) => [key, Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0])); }

async function main() {
  if (!optedIn) { console.log(JSON.stringify({ skipped: true, requests: 0, reason: 'Requires --live and KB_AGENT_LIVE=1' })); return; }
  if (!['core', 'relations'].includes(stage)) throw failure('LIVE_INVALID_STAGE');
  const identity = createHash('sha256').update(LEDGER_FILE.toLowerCase()).digest('hex');
  const mutex = createServer((socket) => socket.destroy());
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\knowledge-base-live-${identity}` : `\0knowledge-base-live-${identity}`;
  await new Promise((done, fail) => { mutex.once('error', () => fail(failure('LIVE_ALREADY_RUNNING'))); mutex.listen(endpoint, done); });
  mutex.unref();
  let service, host, manager, tempRoot;
  let secret = '';
  let ledger;
  const report = { stage, syntheticDataOnly: true, responseBodiesPersisted: false, reasoningDisabled: true };
  try {
    try { const credentials = JSON.parse(await readFile(SECRET_FILE, 'utf8')); if (typeof credentials.DEEPSEEK_API_KEY !== 'string' || !credentials.DEEPSEEK_API_KEY.trim()) throw failure('LIVE_CREDENTIAL_UNAVAILABLE'); secret = credentials.DEEPSEEK_API_KEY.trim(); }
    catch { throw failure('LIVE_CREDENTIAL_UNAVAILABLE'); }
    try { ledger = JSON.parse(await readFile(LEDGER_FILE, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('LIVE_LEDGER_INVALID'); ledger = { campaign: 'v0.0.2', requests: 0, records: [], phases: {} }; }
    if (ledger.campaign !== 'v0.0.2' || !Number.isSafeInteger(ledger.requests) || ledger.requests < 0 || ledger.requests > LIMIT || !Array.isArray(ledger.records)) throw failure('LIVE_LEDGER_INVALID');
    const saveLedger = async () => {
      await mkdir(dirname(LEDGER_FILE), { recursive: true });
      const file = `${LEDGER_FILE}.${randomUUID()}.tmp`;
      await writeFile(file, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(file, LEDGER_FILE);
    };
    const countedFetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'https://api.deepseek.com' || !['/models', '/chat/completions'].includes(url.pathname) || url.search || url.hash) throw failure('LIVE_ENDPOINT_BLOCKED');
      if (url.pathname === '/chat/completions') {
        let body; try { body = JSON.parse(String(init.body)); } catch { throw failure('LIVE_REQUEST_INVALID'); }
        if (body.model !== MODEL || body.thinking?.type !== 'disabled' || body.stream !== false || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 512 || JSON.stringify(body).includes(secret)) throw failure('LIVE_REQUEST_INVALID');
      }
      if (ledger.closed) throw failure('LIVE_CAMPAIGN_CLOSED');
      if (ledger.requests >= LIMIT) throw failure('LIVE_BUDGET_EXHAUSTED');
      const record = { ordinal: ++ledger.requests, purpose: url.pathname === '/models' ? 'models' : stage, startedAt: new Date().toISOString() };
      ledger.records.push(record); await saveLedger();
      const start = Date.now();
      try {
        const response = await nativeFetch(input, { ...init, redirect: 'error' });
        if (response.ok && url.pathname === '/chat/completions') {
          try {
            const payload = await response.clone().json();
            record.usage = safeUsage({ inputTokens: payload.usage?.prompt_tokens, outputTokens: payload.usage?.completion_tokens, totalTokens: payload.usage?.total_tokens });
            if (typeof payload.model === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(payload.model) && !payload.model.includes(secret)) record.actualModel = payload.model;
          } catch { /* 正文解析失败交由正式adapter分类，不记录原始响应或异常。 */ }
        }
        record.httpStatus = response.status; record.durationMs = Date.now() - start; await saveLedger(); return response;
      } catch { record.status = 'network-failed'; record.durationMs = Date.now() - start; await saveLedger(); throw failure('LIVE_NETWORK_FAILED'); }
    };
    const { AgentService } = await import('../../dist/agent/service.js');
    const { DeepSeekProvider } = await import('../../dist/agent/deepseek.js');
    const provider = new DeepSeekProvider({ fetch: countedFetch, resolveCredential: (name) => name === 'DEEPSEEK_API_KEY' ? secret : undefined });
    service = new AgentService({ providers: [provider], profiles: [{ id: 'live-smoke', revision: 1, providerId: provider.id, model: MODEL, credentialEnv: 'DEEPSEEK_API_KEY', timeoutMs: 60_000, maxTokens: 512, temperature: 0, reasoning: 'off' }] });
    const annotate = async (result, purpose, startedAt) => {
      const model = typeof result.model === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(result.model) && !result.model.includes(secret) ? result.model : 'redacted';
      const value = { ok: true, purpose, model, usage: safeUsage(result.usage), durationMs: Date.now() - startedAt };
      Object.assign(ledger.records.at(-1), value); await saveLedger(); return value;
    };
    if (stage === 'core') {
      if (process.argv.includes('--models') && !ledger.phases.models) {
        const response = await countedFetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw failure(response.status === 401 ? 'AGENT_AUTH_FAILED' : 'LIVE_MODELS_UNAVAILABLE');
        let models; try { models = await response.json(); } catch { throw failure('LIVE_MODELS_INVALID'); }
        if (!Array.isArray(models.data) || !models.data.some((item) => item?.id === MODEL)) throw failure('LIVE_MODEL_NOT_AVAILABLE');
        ledger.phases.models = { ok: true, model: MODEL }; await saveLedger();
      }
      if (!ledger.phases.text) {
        const start = Date.now();
        const result = await service.generateText({ profile: 'live-smoke', maxTokens: 256, messages: [{ role: 'user', content: 'Reply with exactly the two words: synthetic success' }] });
        assert.ok(result.value.trim());
        ledger.phases.text = await annotate(result, 'text', start); await saveLedger();
      }
      if (!ledger.phases.object) {
        const start = Date.now();
        const result = await service.generateObject({ profile: 'live-smoke', maxTokens: 256, messages: [{ role: 'user', content: 'Return only json {"label":"synthetic","count":2}.' }], schema: { type: 'object', properties: { label: { type: 'string', const: 'synthetic' }, count: { type: 'integer', const: 2 } }, required: ['label', 'count'], additionalProperties: false } });
        ledger.phases.object = await annotate(result, 'object', start); await saveLedger();
      }
      report.results = { models: ledger.phases.models, text: ledger.phases.text, object: ledger.phases.object };
    } else {
      if (ledger.phases.relations?.ok) report.results = ledger.phases.relations;
      else {
        const { CoreManager, PluginHost } = await import('../../dist/index.js');
        const { builtinPlugins } = await import('../../dist/plugins/index.js');
        const { createAgentPlugin } = await import('../../dist/plugins/agent/index.js');
        tempRoot = await mkdtemp(join(tmpdir(), 'kb-agent-live-synthetic-'));
        manager = await CoreManager.open(join(tempRoot, 'data'));
        host = new PluginHost(manager, builtinPlugins.map((definition) => definition.manifest.id === 'agent' ? createAgentPlugin({ service }) : definition));
        const beforeLoad = ledger.requests; await host.start();
        await host.execute('agent status', {}, []); await host.execute('relation get-config', {}, []);
        assert.equal(ledger.requests, beforeLoad);
        const tag = await host.execute('tag create', { name: 'Synthetic knowledge', description: 'Synthetic example about knowledge resources; no user notes.' }, []);
        await host.execute('relation configure', { mode: 'agent', agentProfile: 'live-smoke', scoringLogicVersion: 'v002-live-smoke', maxBatchSize: 2 }, []);
        assert.equal(ledger.requests, beforeLoad);
        const start = Date.now();
        const first = await host.execute('relation score', { id: tag.id, keywords: ['knowledge', 'unrelated-marker'], maxCalls: 1 }, []);
        assert.equal(ledger.requests - beforeLoad, 1); assert.equal(first.coverage.length, 2);
        const afterFirst = ledger.requests;
        const second = await host.execute('relation score', { id: tag.id, keywords: [' Knowledge ', 'UNRELATED-MARKER'], maxCalls: 0 }, []);
        assert.equal(ledger.requests, afterFirst); assert.equal(second.stats.reused, 2); assert.equal(second.stats.requests, 0);
        const backup = join(tempRoot, 'formal.backup.json'); await manager.backup(backup);
        const scan = await scanForSecret(secret, [join(tempRoot, 'data')], [backup]); if (!scan.passed) throw failure('LIVE_SECRET_FOUND');
        const record = ledger.records.at(-1);
        ledger.phases.relations = { ok: true, purpose: 'relations', model: MODEL, actualModel: record.actualModel, usage: record.usage, durationMs: Date.now() - start, requestsFirst: 1, requestsSecond: 0, covered: 2, positiveScores: first.scores.length, secretAbsentFromDataAndBackup: true, httpStatus: record.httpStatus };
        await saveLedger(); report.results = ledger.phases.relations;
      }
    }
    const scan = await scanForSecret(secret, [REPO]); if (!scan.passed) throw failure('LIVE_SECRET_FOUND');
    report.secretScan = { passed: true, filesScanned: scan.filesScanned, excludedDirectories: scan.excludedDirectories };
    report.ok = true;
    if (ledger.phases.text?.ok && ledger.phases.object?.ok && ledger.phases.relations?.ok) { ledger.closed = true; ledger.closedAt = new Date().toISOString(); await saveLedger(); report.campaignClosed = true; }
  } catch (error) { report.ok = false; report.code = safeCode(error); process.exitCode = 1; }
  finally {
    try { await host?.stop(); await manager?.close(); service?.stop(); }
    finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      await new Promise((done) => mutex.close(done));
    }
  }
  report.requestsUsedTotal = ledger?.requests ?? 0; report.requestLimit = LIMIT;
  await mkdir(OUTPUT, { recursive: true });
  const serialized = JSON.stringify(report, null, 2);
  if (secret && serialized.includes(secret)) throw failure('LIVE_SECRET_FOUND');
  await writeFile(join(OUTPUT, `live-${stage}.json`), serialized + '\n');
  secret = '';
  console.log(serialized);
}

main().catch(() => { console.error(JSON.stringify({ ok: false, code: 'LIVE_VERIFICATION_FAILED' })); process.exitCode = 1; });
