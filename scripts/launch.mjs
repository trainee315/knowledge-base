#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rm, readdir, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIN_NODE_MAJOR = 24; // sqlite 及当前构建工具的最低运行环境。
const RUNTIME = path.join(ROOT, '.runtime');
const STAMP = path.join(RUNTIME, 'setup.json');
const LOCK = path.join(RUNTIME, 'setup.lock');
const LOG = path.join(RUNTIME, 'setup.log');
const ENTRY = path.join(ROOT, 'dist/cli/main.js');
let argv = process.argv.slice(2);
let textMode = argv.includes('--format=text') || argv.some((arg, index) => arg === '--format' && argv[index + 1] === 'text');
if (argv.includes('--json') || argv.includes('--json=true')) textMode = false;
const fail = (code, message, suggestions, exitCode = 1) => Object.assign(new Error(message), { code, suggestions, exitCode });
async function exists(file) { try { await access(file); return true; } catch { return false; } }

/** 固定 npm 入口以参数数组执行，避免 Windows cmd 对路径及参数再次解释。 */
async function npmEntry() {
  const locations = [path.dirname(process.execPath), ...String(process.env.PATH ?? '').split(path.delimiter)];
  for (const directory of locations) for (const relative of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js']) {
    const candidate = path.resolve(directory, relative);
    if (await exists(candidate)) return candidate;
  }
  throw fail('NPM_MISSING', '找不到 npm CLI', ['安装包含 npm 的 Node.js 24+，重新打开终端后重试']);
}

/** 比较源码、配置及锁文件的内容，避免每次启动都重新构建。 */
async function fingerprint() {
  const hash = createHash('sha256');
  async function visit(relative) {
    const file = path.join(ROOT, relative);
    const info = await stat(file);
    if (info.isDirectory()) {
      for (const child of (await readdir(file)).sort()) {
        if (['node_modules', 'dist', 'tests'].includes(child) || child.startsWith('.')) continue;
        await visit(path.join(relative, child));
      }
    } else hash.update(relative).update(await readFile(file));
  }
  for (const relative of ['src', 'web', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json']) await visit(relative);
  return hash.digest('hex');
}

async function dependenciesReady() {
  try {
    const expected = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const installed = JSON.parse(await readFile(path.join(ROOT, 'node_modules/.package-lock.json'), 'utf8'));
    for (const [key, value] of Object.entries(expected.packages)) {
      if (!key || value.optional) continue;
      if (installed.packages[key]?.version !== value.version || !await exists(path.join(ROOT, key))) return false;
    }
    return await exists(path.join(ROOT, 'node_modules/typescript/bin/tsc')) && await exists(path.join(ROOT, 'node_modules/vite/bin/vite.js'));
  } catch { return false; }
}

/** 准备互斥覆盖安装与构建，只在全部成功后保存内容指纹。 */
async function prepare() {
  await mkdir(RUNTIME, { recursive: true });
  let lock;
  try { lock = await open(LOCK, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw fail('SETUP_BUSY', '另一个启动入口正在准备环境，或上次异常退出留下了准备锁', [`等待该启动完成；若确认没有准备进程，再删除 ${LOCK} 后重试`]);
  }
  await lock.writeFile(String(process.pid));
  try {
    const log = await open(LOG, 'w');
    try {
      async function npm(args) {
        const entry = await npmEntry();
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [entry, ...args], { cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(fail('SETUP_FAILED', `npm ${args.join(' ')} 失败，退出码 ${code}`, [`查看准备日志：${LOG}`, `在项目目录执行 npm ${args.join(' ')} 排查后重试`])));
        });
      }
      let changed = false;
      if (!await dependenciesReady()) {
        process.stderr.write('正在安装依赖（npm ci），日志：' + LOG + '\n');
        await npm(['ci']); changed = true;
      }
      const current = await fingerprint();
      let previous;
      try { previous = JSON.parse(await readFile(STAMP, 'utf8')); } catch {}
      if (changed || previous?.fingerprint !== current || !await exists(ENTRY) || !await exists(path.join(ROOT, 'dist/web/index.html'))) {
        process.stderr.write('正在构建核心和页面，日志：' + LOG + '\n');
        await npm(['run', 'build']);
        await writeFile(STAMP, JSON.stringify({ fingerprint: current, builtAt: new Date().toISOString() }));
      } else process.stderr.write('依赖和构建产物已就绪。\n');
    } finally { await log.close(); }
  } finally { await lock.close(); await rm(LOCK, { force: true }); }
}

/** up 的早期校验先于 npm 和文件写入，防止拼错参数仍触发安装。 */
async function validateUp(args, commandIndex) {
  const booleans = new Set(['json', 'no-open', 'help']);
  const values = new Set(['port', 'data-dir', 'format', 'input']);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (index === commandIndex) continue;
    const token = args[index];
    if (!token.startsWith('--')) throw fail('INVALID_ARGUMENT', '多余参数：' + token, ['cli.bat up --help'], 2);
    const equal = token.indexOf('=');
    const name = token.slice(2, equal < 0 ? undefined : equal);
    if (!booleans.has(name) && !values.has(name)) throw fail('INVALID_ARGUMENT', '未知参数：--' + name, ['cli.bat up --help'], 2);
    let value = equal < 0 ? undefined : token.slice(equal + 1);
    if (value === undefined && (values.has(name) || ['true', 'false'].includes(args[index + 1]))) value = args[++index];
    if (booleans.has(name) && value !== undefined && !['true', 'false'].includes(value)) throw fail('INVALID_ARGUMENT', token + ' 必须为 true/false', ['cli.bat up --help'], 2);
    if (values.has(name) && (!value || value.startsWith('--'))) throw fail('INVALID_ARGUMENT', token + ' 需要值', ['cli.bat up --help'], 2);
    options[name] = value ?? true;
  }
  let result = {};
  if (options.input !== undefined) {
    let source;
    if (options.input === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); source = Buffer.concat(chunks).toString('utf8'); }
    else source = await readFile(path.resolve(options.input), 'utf8');
    try { result = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw fail('INVALID_ARGUMENT', '--input 不是有效 JSON', ['cli.bat up --help'], 2); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('INVALID_ARGUMENT', '--input 顶层必须为对象', ['cli.bat up --help'], 2);
    result = Object.fromEntries(Object.entries(result).map(([key, value]) => [key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value]));
  }
  result = { ...result, ...options };
  delete result.input;
  for (const [key, value] of Object.entries(result)) {
    if (!booleans.has(key) && !values.has(key)) throw fail('INVALID_ARGUMENT', '未知参数：--' + key, ['cli.bat up --help'], 2);
    if (booleans.has(key) && ![true, false, 'true', 'false'].includes(value)) throw fail('INVALID_ARGUMENT', '--' + key + ' 必须为布尔值', ['cli.bat up --help'], 2);
    if (['data-dir', 'format'].includes(key) && (typeof value !== 'string' || !value.trim())) throw fail('INVALID_ARGUMENT', '--' + key + ' 需要非空字符串', ['cli.bat up --help'], 2);
  }
  if (result.port !== undefined && (!/^\d+$/.test(result.port) || Number(result.port) > 65535)) throw fail('INVALID_ARGUMENT', '--port 必须为 0–65535', ['cli.bat up --help'], 2);
  if (result.format !== undefined && !['json', 'text'].includes(result.format)) throw fail('INVALID_ARGUMENT', '--format 必须为 json/text', ['cli.bat up --help'], 2);
  textMode = result.format === 'text' && ![true, 'true'].includes(result.json);
  return ['up', ...Object.entries(result).flatMap(([key, value]) => ['--' + key, String(value)])];
}

function firstCommand(args) {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--data-dir', '--input', '--format'].includes(value)) { index++; continue; }
    if (['--json', '--help'].includes(value) && ['true', 'false'].includes(args[index + 1])) { index++; continue; }
    if (!value.startsWith('-')) return index;
  }
  return -1;
}

function wantsHelp(args) {
  if (args[firstCommand(args)] === 'help') return true;
  let help = false;
  args.forEach((value, index) => {
    if (value === '-h' || value === '--help') help = args[index + 1] !== 'false';
    if (value.startsWith('--help=')) help = value.slice(7) === 'true';
  });
  return help;
}

/** 源码入口先处理环境准备，再将业务参数交给编译后的 CLI。 */
async function main() {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) throw fail('NODE_VERSION_UNSUPPORTED', `当前 ${process.version}，需要 Node.js 24+`, ['安装 Node.js 24+ 后重新运行 start.bat']);
  let help = wantsHelp(argv);
  const commandIndex = firstCommand(argv);
  if (argv[commandIndex] === 'up' && !help) {
    argv = await validateUp(argv, commandIndex);
    help = wantsHelp(argv);
    if (!help) await prepare();
  }
  if (!await exists(ENTRY)) {
    if (help || !argv.length) {
      const data = { usage: 'cli.bat up [--data-dir path] [--port 0–65535] [--no-open] [--format text]', description: '首次启动会准备依赖和构建；完成后支持全部命令帮助', commands: ['up', 'doctor'], suggestions: ['cli.bat up --format text'] };
      process.stdout.write(textMode ? data.usage + '\n' + data.description + '\n' : JSON.stringify({ ok: true, data }) + '\n'); return;
    }
    if (argv[0] === 'doctor') {
      const data = { healthy: false, checks: [{ name: 'Node.js', ok: true, message: process.version }, { name: '核心构建', ok: false, message: '缺少 dist/cli/main.js' }], suggestions: ['cli.bat up --no-open --format text'] };
      process.stdout.write(textMode ? '缺少构建产物；运行 cli.bat up --no-open --format text\n' : JSON.stringify({ ok: true, data }) + '\n'); process.exitCode = 1; return;
    }
    throw fail('BUILD_MISSING', '缺少核心构建产物', ['运行 cli.bat up --format text 完成首次准备']);
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...argv], { cwd: process.cwd(), windowsHide: true, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}
main().catch(error => {
  process.exitCode = error.exitCode ?? 1;
  const output = { ok: false, error: { code: error.code ?? 'SETUP_FAILED', message: error.message, suggestions: error.suggestions ?? [`检查环境及目录权限；准备日志：${LOG}`], helpCommand: 'cli.bat up --help' } };
  process.stdout.write(textMode ? `启动失败 [${output.error.code}]\n原因：${error.message}\n建议：${output.error.suggestions.join('\n')}\n` : JSON.stringify(output) + '\n');
});
