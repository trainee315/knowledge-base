import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 此补丁只针对交付时 PPC 基线；导出五个 CLI 必需文件，不读取或复制压图业务。
const BASELINE = '72a78f1b2a26c49ae3d6cddd6548dd10eb69d18e';
const BASE_FILES = ['cli/README.md', 'cli/api.mjs', 'cli/ppc.mjs', 'cli/service.mjs', 'cli/windows.mjs'];
const PATCH_FILES = ['cli/README.md', 'cli/knowledge.mjs', 'cli/knowledge.test.mjs', 'cli/ppc.mjs'];
const TEMP_PREFIX = 'knowledge-base-ppc-patch-中文 空格-';
const SOURCE = resolve(process.argv[2] ?? 'C:/Users/mamar/Desktop/personalProjectCenter');
const KNOWLEDGE_HOME = resolve(process.argv[3] ?? fileURLToPath(new URL('../../', import.meta.url)));
const PATCH = fileURLToPath(new URL('./knowledge-cli.patch', import.meta.url));
const OUTPUT = process.env.KB_PPC_VERIFY_OUTPUT ? resolve(process.env.KB_PPC_VERIFY_OUTPUT) : fileURLToPath(new URL('./verification.json', import.meta.url));
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
function git(args, cwd = SOURCE) { return run('git', args, cwd); }

/** 补丁仅应用到独立临时目录；验证结束核对原始 index/文件未变并清理自己创建的目录。 */
async function main() {
  assert.ok(process.argv.length <= 4, '用法：node integrations/ppc/verify.mjs [PPC仓库] [知识库仓库]');
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), BASELINE, '验证要求 PPC HEAD 与补丁基线一致');
  await access(join(KNOWLEDGE_HOME, 'dist/cli/main.js'));
  const knowledgeVersion = JSON.parse(await readFile(join(KNOWLEDGE_HOME, 'package.json'), 'utf8')).version;
  assert.equal(typeof knowledgeVersion, 'string', '目标知识库必须声明版本');
  const patch = await readFile(PATCH);
  const paths = [...patch.toString('utf8').matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => { assert.equal(match[1], match[2]); return match[1]; }).sort();
  assert.deepEqual(paths, PATCH_FILES);
  const index = resolve(SOURCE, git(['rev-parse', '--git-path', 'index']).toString().trim());
  const indexBefore = sha256(await readFile(index));
  const originalFiles = Object.fromEntries(await Promise.all(PATCH_FILES.map(async (file) => [file, sha256(await readFile(join(SOURCE, file)))])));
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const canonical = await realpath(directory);
  let result;
  try {
    for (const file of BASE_FILES) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), git(['show', `${BASELINE}:${file}`]));
    }
    git(['apply', '--check', PATCH], directory);
    git(['apply', PATCH], directory);
    for (const file of PATCH_FILES) {
      const actual = (await readFile(join(directory, file), 'utf8')).replaceAll('\r\n', '\n');
      const expected = (await readFile(join(SOURCE, file), 'utf8')).replaceAll('\r\n', '\n');
      assert.equal(actual, expected, `补丁输出必须等于已交付的适配文件：${file}`);
    }
    const help = run(process.execPath, [join(directory, 'cli/ppc.mjs'), '--help'], directory).toString();
    assert.match(help, /ppc knowledge/); assert.match(help, /ppc note search/);
    const forwarded = run(process.execPath, [join(directory, 'cli/ppc.mjs'), 'knowledge', '--help', '--knowledge-home', KNOWLEDGE_HOME, '--json'], directory).toString();
    const response = JSON.parse(forwarded);
    assert.equal(response.ok, true); assert.equal(response.data.version, knowledgeVersion);
    const tests = run(process.execPath, ['--test', '--test-reporter=tap', join(directory, 'cli/knowledge.test.mjs')], directory).toString();
    assert.match(tests, /# tests 2/); assert.match(tests, /# pass 2/); assert.match(tests, /# fail 0/);
    assert.equal(sha256(await readFile(index)), indexBefore, '原始 PPC git index 不得改变');
    for (const [file, hash] of Object.entries(originalFiles)) assert.equal(sha256(await readFile(join(SOURCE, file))), hash);
    result = {
      passed: true, verifiedAt: new Date().toISOString(), baseline: BASELINE, knowledgeVersion,
      node: process.version, git: git(['--version']).toString().trim(),
      patchSha256: sha256(patch), patchBytes: patch.length, patchFiles: paths, exportedBaselineFiles: BASE_FILES,
      applyCheck: true, appliedOnlyToTemporaryDirectory: true, cliHelp: true, realKnowledgeHelpForwarding: true,
      dedicatedTests: { total: 2, passed: 2, failed: 0 }, originalIndexUnchanged: true, originalFilesUnchanged: true,
      originalIndexSha256: indexBefore, ppcRemotesAtVerification: git(['remote', '-v']).toString().trim().split(/\r?\n/).filter(Boolean),
      ppcCommittedOrPushed: false, serviceOrPackInvoked: false, testOutput: tests,
    };
  } finally {
    const scope = relative(await realpath(tmpdir()), canonical);
    assert.ok(scope && !scope.startsWith('..') && !isAbsolute(scope) && basename(directory).startsWith(TEMP_PREFIX));
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert.equal(await realpath(directory), canonical, '清理前必须确认仍为自己创建的临时目录');
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(access(directory), { code: 'ENOENT' });
  result.temporaryDirectoryRemoved = true;
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, applyCheck: true, cliHelp: true, realKnowledgeHelpForwarding: true, dedicatedTests: 2, originalIndexUnchanged: true, temporaryDirectoryRemoved: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
