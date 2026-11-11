import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForSecret } from './secret-scan.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SECRET = join(homedir(), 'AppData/Local/knowledge-base/credentials/deepseek-test-v002.secrets.json');
const LEDGER = join(homedir(), 'AppData/Local/knowledge-base/verification/v0.0.2-live-ledger.json');
const OUTPUT = resolve(REPO, process.env.KB_AGENT_AUDIT_OUTPUT ?? 'artifacts/verification/v0.0.2/secret-audit.json');

/** 精确密钥检查只在内存比较；CLI 子进程预加载网络封锁器，不能触发真实 API。 */
async function main() {
  if (!process.argv.includes('--local-credential')) { console.log(JSON.stringify({ skipped: true, externalRequests: 0, reason: 'Requires --local-credential' })); return; }
  let key;
  try { const value = JSON.parse(await readFile(SECRET, 'utf8')).DEEPSEEK_API_KEY; assert.equal(typeof value, 'string'); key = value.trim(); assert.ok(key); }
  catch { throw new Error('Credential unavailable for offline audit'); }
  const root = await mkdtemp(join(tmpdir(), 'kb-agent-secret-audit-'));
  const dataDir = join(root, 'data'), backup = join(root, 'formal.backup.json');
  const cases = [];
  const run = (name, words, input = {}) => {
    const child = spawnSync(process.execPath, ['--import', new URL('./offline-fetch.mjs', import.meta.url).href, join(REPO, 'dist/cli/main.js'), ...words, '--data-dir', dataDir, '--input', '-', '--json'], { cwd: REPO, env: { ...process.env, DEEPSEEK_API_KEY: key }, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    assert.equal(output.includes(key), false, 'CLI audit output contained a credential; content suppressed');
    assert.equal(child.error, undefined, 'CLI audit process failed; raw cause suppressed');
    let value; try { value = JSON.parse(child.stdout); } catch { throw new Error('CLI audit output was not JSON; content suppressed'); }
    const attempts = Number(/KB_OFFLINE_REQUEST_COUNT:(\d+)/.exec(child.stderr)?.[1] ?? -1);
    const safe = { name, exitCode: child.status, code: value.error?.code ?? 'OK', blockedTransportAttempts: attempts, credentialAbsentFromStdoutAndStderr: true };
    cases.push(safe); return { value, safe };
  };
  let report;
  try {
    const campaign = JSON.parse(await readFile(LEDGER, 'utf8')); assert.equal(campaign.closed, true); assert.equal(campaign.requests, 3);
    const status = run('read-only status with configured key', ['agent', 'status']); assert.equal(status.safe.code, 'OK'); assert.equal(status.safe.blockedTransportAttempts, 0);
    const profile = run('profile stores environment reference', ['agent', 'profile', 'set'], { id: 'deepseek-default', credentialEnv: 'DEEPSEEK_API_KEY', maxTokens: 128 }); assert.equal(profile.safe.code, 'OK'); assert.equal(profile.safe.blockedTransportAttempts, 0);
    const invalid = run('unsupported schema rejected before transport', ['agent', 'generate', 'object'], { messages: [{ role: 'user', content: 'Synthetic json only.' }], schema: { type: 'object', unknownRule: true } }); assert.equal(invalid.safe.code, 'AGENT_UNSUPPORTED_SCHEMA'); assert.equal(invalid.safe.blockedTransportAttempts, 0);
    const transport = run('CLI provider error sanitized with real key only in environment', ['agent', 'generate', 'text'], { messages: [{ role: 'user', content: 'Synthetic material only.' }], maxTokens: 128, reasoning: 'off' }); assert.equal(transport.safe.code, 'AGENT_PROVIDER_UNAVAILABLE'); assert.equal(transport.safe.blockedTransportAttempts, 1);
    const archived = run('backup keeps references only', ['backup'], { file: backup }); assert.equal(archived.safe.code, 'OK'); assert.equal(archived.safe.blockedTransportAttempts, 0);
    const scan = await scanForSecret(key, [REPO, dataDir], [backup, LEDGER]);
    report = { ok: scan.passed, externalRequests: 0, realRequestCampaignClosed: true, realRequestsPreviouslyUsed: campaign.requests, exactCredentialMatchCount: scan.matches.length, matchingFiles: scan.matches, filesScanned: scan.filesScanned, excludedDirectories: scan.excludedDirectories, backupEntriesDecoded: true, cliCases: cases };
    const serialized = JSON.stringify(report, null, 2); assert.equal(serialized.includes(key), false);
    await mkdir(dirname(OUTPUT), { recursive: true }); await writeFile(OUTPUT, serialized + '\n');
    if (!scan.passed) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); key = ''; }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => { console.error(JSON.stringify({ ok: false, externalRequests: 0, code: 'OFFLINE_SECRET_AUDIT_FAILED' })); process.exitCode = 1; });
