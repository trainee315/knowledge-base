import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仅读取两个明确的公开发布事实：本地002 tag及该commit的package版本，不扫描仓库内容。
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(REPO, 'dist/cli/main.js');
const SAMPLES = fileURLToPath(new URL('./', import.meta.url));
const FENCE = new URL('../../tests/project-tracking/offline-fetch.mjs', import.meta.url).href;
const PPC = process.env.PPC_CLI_PATH ?? 'C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs';
const RELEASE_TAG = 'v0.0.2';
const COMMAND_TIMEOUT_MS = 60_000; // 单条本地CLI有界退出，不启动服务或后台任务。
let demoRoot, dataDir;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 所有正式数据经真实CLI写入；stdin保留JSON及中文路径，外部fetch始终封锁。 */
async function cli(words, input = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', FENCE, ENTRY, ...words, '--input', '-', '--data-dir', dataDir, '--json'], { cwd: REPO, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); fail(new Error('Local demo command timed out')); }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', (error) => { clearTimeout(timeout); fail(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      try {
        assert.match(stderr, /KB_PROJECT_EXTERNAL_REQUEST_COUNT:0/);
        const value = JSON.parse(stdout); if (code || !value.ok) throw new Error(value.error?.message ?? 'Local demo command failed'); done(value.data);
      } catch (error) { fail(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
function command(words, viaPpc = true) {
  const quote = (value) => process.platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
  const entry = viaPpc ? PPC : ENTRY;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(entry)} ${viaPpc ? 'knowledge ' : ''}${words.map(quote).join(' ')} --data-dir ${quote(dataDir)} --json`;
}

async function main() {
  assert.equal(process.argv.length, 2, '用法：node examples/project-tracking/create-demo.mjs（不接受现有数据目录）');
  await access(ENTRY);
  const gitOptions = { cwd: REPO, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true };
  const releaseCommit = execFileSync('git', ['rev-parse', `${RELEASE_TAG}^{commit}`], gitOptions).trim();
  const releasedPackage = JSON.parse(execFileSync('git', ['show', `${releaseCommit}:package.json`], gitOptions));
  assert.equal(releasedPackage.version, '0.0.2'); assert.match(releaseCommit, /^[a-f0-9]{40}$/);
  const releaseDate = execFileSync('git', ['show', '-s', '--format=%cI', releaseCommit], gitOptions).trim();
  demoRoot = await mkdtemp(join(tmpdir(), 'knowledge-base-project-demo-')); dataDir = join(demoRoot, '项目演示库');
  const sources = join(demoRoot, '演示原件'); await mkdir(sources);
  const project = await cli(['project-track', 'create'], { name: 'knowledge-base', description: '以公开002发布事实为首基线的独立项目追踪演示。其余记录均明确标记为合成设计/计划，不等于正式发布。' });
  const releaseTag = await cli(['tag', 'create'], { name: '发布事实', aliases: ['release-fact'] });
  const designTag = await cli(['tag', 'create'], { name: '项目设计', aliases: ['原始设计别名'] });
  const importText = async (filename, text) => { const path = join(sources, filename); await writeFile(path, text); return (await cli(['resource', 'import'], { file: path, source: 'examples/project-tracking/create-demo.mjs' })).resource; };
  const importSample = async (filename) => { const path = join(sources, filename); await copyFile(join(SAMPLES, filename), path); return (await cli(['resource', 'import'], { file: path, source: 'examples/project-tracking/create-demo.mjs' })).resource; };
  const add = (resource, input) => cli(['project-track', 'add'], { projectId: project.id, resourceId: resource.id, title: resource.originalName, stage: 'confirmed', ...input });
  const baselineText = `# knowledge-base 0.0.2 发布基线\r\n\r\n本地公开 tag：${RELEASE_TAG}\r\ncommit：${releaseCommit}\r\npackage.version：${releasedPackage.version}\r\n\r\n002已发布通用Agent、DeepSeek适配与关系评分缓存；PPC通过通用knowledge CLI转发。\r\n本脚本只核对本地发布tag和版本，远端发布事实已由仓库维护者核验；不自动访问远端。\r\n003项目追踪是当前演示设计，不计作002已发布能力。\r\n`;
  const baselineResource = await importText('baseline-0.0.2.md', baselineText);
  const baseline = await add(baselineResource, { role: 'baseline', projectVersion: '0.0.2', stage: 'verified', recordedAt: releaseDate, tags: [releaseTag.id], requestId: 'demo-002-baseline' });
  const change = await add(await importSample('change.md'), { role: 'change', projectVersion: '0.0.3', recordedAt: '2026-11-11T10:00:00Z', tags: [designTag.id], requestId: 'demo-change' });
  const correction = await add(await importSample('correction.md'), { role: 'decision', projectVersion: '0.0.3', recordedAt: '2026-11-11T11:00:00Z', tags: [designTag.id], replaces: { entryIds: [change.entry.id], scope: '全文默认分页条数', effect: '默认5条、最多20条；仅修正此范围，不删除其它历史' }, requestId: 'demo-correction' });
  const plan = await add(await importSample('plan.md'), { role: 'change', projectVersion: '0.0.10', stage: 'planned', recordedAt: '2026-01-01T00:00:00Z', tags: [designTag.id], requestId: 'demo-plan' });
  const verification = await add(await importSample('verification.txt'), { role: 'verification', projectVersion: '0.0.3', stage: 'verified', recordedAt: '2026-11-11T12:00:00Z', tags: [], requestId: 'demo-verification' });
  const historyText = '\uFEFF# 固定历史全文\r\n\r\narchivedpin：这个cv1正文必须保留原BOM、CRLF与尾部空格。  \r\n';
  const historyResource = await importText('pinned-history.md', historyText);
  const pinnedInput = { role: 'state', projectVersion: '0.0.3', recordedAt: '2026-11-11T13:00:00Z', tags: [designTag.id], requestId: 'demo-history' };
  const pinned = await add(historyResource, pinnedInput);
  const updated = join(sources, 'pinned-history-current.md'); await writeFile(updated, '# 当前版本\n\nCURRENT ONLY：普通资源链接现在显示cv2；项目历史全文仍为cv1。\n');
  await cli(['resource', 'update'], { id: historyResource.id, file: updated, expectedContentVersion: 1 });
  await cli(['tag', 'update'], { id: designTag.id, name: '当前项目设计', aliases: ['新设计别名'] });
  const replay = await add(historyResource, pinnedInput); assert.equal(replay.replayed, true); assert.equal(replay.entry.id, pinned.entry.id);
  const unknown = await add(historyResource, { role: 'state', title: '历史补录：标签未知', contentVersion: 1, projectVersion: '0.0.3', recordedAt: '2026-11-11T14:00:00Z', requestId: 'demo-history-unknown' });
  assert.equal(unknown.entry.snapshot.tags.status, 'unknown'); assert.equal(verification.entry.snapshot.tags.status, 'known'); assert.equal(verification.entry.snapshot.tags.items.length, 0);
  const read = await cli(['project-track', 'read'], { projectId: project.id, entryId: pinned.entry.id });
  assert.equal(read.text, historyText); assert.equal(read.entry.contentHash, hash(Buffer.from(historyText)));
  const query = await cli(['project-track', 'query'], { projectId: project.id });
  assert.equal(query.limit, 5); assert.equal(query.items.length, 5); assert.equal(query.total, 7); assert.equal(query.items[0].entry.projectVersion, '0.0.10'); assert.equal(query.baselineEntryId, baseline.entry.id);
  const old = await cli(['project-track', 'query'], { projectId: project.id, asOfVersion: '0.0.3' }); assert.equal(old.total, 6); assert.equal(old.items.some((item) => item.entry.id === plan.entry.id), false);
  const replaced = await cli(['project-track', 'query'], { projectId: project.id, keywords: ['oldlimitmarker'], includeBaseline: true });
  assert.equal(replaced.total, 1); assert.equal(replaced.items[0].replacement.replacedBy[0].entryId, correction.entry.id); assert.equal(replaced.baselineEntryId, baseline.entry.id);
  const snapshotTags = await cli(['project-track', 'query'], { projectId: project.id, tags: ['原始设计别名'] }); assert.ok(snapshotTags.total >= 3);
  const checked = await cli(['check']); assert.equal(checked.valid, true);
  const commands = {
    query: command(['project-track', 'query', '--project-id', project.id]),
    asOf: command(['project-track', 'query', '--project-id', project.id, '--as-of-version', '0.0.3']),
    readPinned: command(['project-track', 'read', '--project-id', project.id, '--entry-id', pinned.entry.id]),
    readReplaced: command(['project-track', 'read', '--project-id', project.id, '--entry-id', change.entry.id]),
    previewStart: command(['preview', 'start']), previewStop: command(['preview', 'stop']),
    directReadPinned: command(['project-track', 'read', '--project-id', project.id, '--entry-id', pinned.entry.id], false),
  };
  const manifest = { schemaVersion: 1, demoRoot, dataDir, projectId: project.id, releaseEvidence: { tag: RELEASE_TAG, commit: releaseCommit, packageVersion: releasedPackage.version, localVerificationOnly: true }, entries: { baseline: baseline.entry.id, change: change.entry.id, correction: correction.entry.id, plan: plan.entry.id, verificationKnownEmpty: verification.entry.id, pinnedHistory: pinned.entry.id, historicalTagsUnknown: unknown.entry.id }, historicalPin: { resourceId: historyResource.id, contentVersion: 1, contentHash: pinned.entry.contentHash, currentContentVersion: 2 }, verification: { coreCheck: true, entries: 7, resources: 6, asOf003: 6, version010Before003: true, requestReplay: true, pinnedRawText: true, snapshotOldAlias: true, knownEmptyAndUnknownDistinct: true }, commands, externalRequests: 0, servicesStarted: false, warning: '通用预览/资源UUID链接读取当前版；固定历史全文只使用project-track read/query。同UUID跨格式更新不支持，应另导入新资源。系统临时目录可能后续被清理，长期保留请备份。' };
  const manifestFile = join(demoRoot, 'project-demo.json'); await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, dataDir, manifestFile, projectId: project.id, releaseCommit, entries: 7, resources: 6, coreCheck: true, pinnedHistoryCv: 1, currentResourceCv: 2, requestReplay: true, externalRequests: 0, servicesStarted: false, commands }, null, 2));
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, code: 'PROJECT_DEMO_FAILED', message: error.message, demoRoot, dataDir })); process.exitCode = 1; });
