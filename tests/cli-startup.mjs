import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 在最小隔离项目中验证准备流程，避免删改当前仓库的依赖和构建产物。
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-startup 中文 空格 '));
  for (const directory of ['src', 'web', 'scripts', 'node_modules/typescript/bin', 'node_modules/vite/bin']) await mkdir(path.join(root, directory), { recursive: true });
  await copyFile(new URL('../scripts/launch.mjs', import.meta.url), path.join(root, 'scripts/launch.mjs'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { build: 'node build.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await writeFile(path.join(root, 'node_modules/.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await writeFile(path.join(root, 'node_modules/typescript/bin/tsc'), 'fixture');
  await writeFile(path.join(root, 'node_modules/vite/bin/vite.js'), 'fixture');
  await writeFile(path.join(root, 'tsconfig.json'), '{}');
  await writeFile(path.join(root, 'src/source.txt'), 'first');
  await writeFile(path.join(root, 'build.mjs'), `import fs from 'node:fs'; fs.mkdirSync('dist/cli',{recursive:true});fs.mkdirSync('dist/web',{recursive:true});fs.appendFileSync('build-count.txt','build\\n');fs.writeFileSync('dist/web/index.html','fixture');fs.writeFileSync('dist/cli/main.js', 'console.log(JSON.stringify({ok:true,data:{args:process.argv.slice(2),cwd:process.cwd()}}))');`);
  return root;
}
function invoke(root, args, input) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/launch.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, input: input && JSON.stringify(input) });
  return { ...result, value: result.stdout.startsWith('{') ? JSON.parse(result.stdout) : undefined };
}

test('cold startup builds once, reuses valid artifacts, rebuilds changed sources and preserves input paths', async () => {
  const root = await fixture();
  try {
    const help = invoke(root, ['up', '--help', '--input', 'missing.json']); assert.equal(help.status, 0, help.stderr);
    await assert.rejects(access(path.join(root, '.runtime')));
    const invalid = invoke(root, ['up', '--porrt', '123']); assert.equal(invalid.status, 2);
    await assert.rejects(access(path.join(root, '.runtime')));
    const first = invoke(root, ['--json', 'up', '--input', '-'], { noOpen: true, dataDir: path.join(root, '中文 资料'), port: 0 });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(first.value.data.args.includes(path.join(root, '中文 资料')), true);
    assert.equal(first.value.data.cwd, process.cwd());
    assert.equal(first.stdout.trim().split('\n').length, 1);
    const second = invoke(root, ['up', '--no-open']); assert.equal(second.status, 0, second.stdout);
    assert.equal((await readFile(path.join(root, 'build-count.txt'), 'utf8')).trim().split('\n').length, 1);
    await writeFile(path.join(root, 'src/source.txt'), 'changed');
    assert.equal(invoke(root, ['up', '--no-open']).status, 0);
    assert.equal((await readFile(path.join(root, 'build-count.txt'), 'utf8')).trim().split('\n').length, 2);
    await rm(path.join(root, 'dist/web/index.html'));
    assert.equal(invoke(root, ['up', '--no-open']).status, 0);
    assert.equal((await readFile(path.join(root, 'build-count.txt'), 'utf8')).trim().split('\n').length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed build preserves reason and logs; preparation lock prevents concurrent writes', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, 'build.mjs'), `console.error('synthetic build failure');process.exit(7);`);
    const result = invoke(root, ['up', '--no-open']);
    assert.equal(result.status, 1); assert.equal(result.value.error.code, 'SETUP_FAILED');
    assert.match(await readFile(path.join(root, '.runtime/setup.log'), 'utf8'), /synthetic build failure/);
    await assert.rejects(access(path.join(root, '.runtime/setup.lock')));
    await writeFile(path.join(root, '.runtime/setup.lock'), String(process.pid));
    const busy = invoke(root, ['up']); assert.equal(busy.value.error.code, 'SETUP_BUSY');
    assert.equal(await readFile(path.join(root, '.runtime/setup.lock'), 'utf8'), String(process.pid));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing dependencies fail with actionable npm ci output without starting service', async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, 'node_modules/.package-lock.json'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { preinstall: 'node -e "process.exit(9)"' } }));
    const result = invoke(root, ['up', '--no-open']);
    assert.equal(result.status, 1); assert.equal(result.value.error.code, 'SETUP_FAILED');
    assert.match(result.value.error.message, /npm ci/);
    await assert.rejects(access(path.join(root, 'dist')));
    await assert.rejects(access(path.join(root, '.runtime/setup.lock')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real launcher starts and reuses a service in a Chinese temporary data directory', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'kb-launcher 中文 '));
  try {
    const first = invoke(root, ['--json', 'up', '--data-dir', dir, '--no-open']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(first.value.data.running, true);
    const second = invoke(root, ['up', '--no-open', '--data-dir', dir, '--json']);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(second.value.data.pid, first.value.data.pid);
    assert.match(second.stderr, /已就绪/);
    const response = await fetch(first.value.data.url); assert.equal(response.status, 200);
  } finally {
    const stopped = invoke(root, ['service', 'stop', '--data-dir', dir]);
    assert.equal(stopped.status, 0, stopped.stdout);
    await rm(dir, { recursive: true, force: true });
  }
});
