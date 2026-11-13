import { spawn } from 'node:child_process';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleService, locateService } from '../service/client.js';
import { KnowledgeError } from '../core/errors.js';
import { redactCredentials } from '../records/redaction.js';
import { quoteArgument } from './contract.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOG_TAIL_BYTES = 256 * 1024; // 限制单次日志读取量，防止大日志阻塞 CLI。
const MAX_LOG_LINES = 1000;
const BROWSER_OPEN_TIMEOUT_MS = 15_000; // 外部打开程序异常时不阻塞 CLI。

/** 只打开本地服务地址；参数不经过 shell 插值。 */
export async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new KnowledgeError('INVALID_URL', '仅支持打开本地服务地址');
  const windows = process.platform === 'win32';
  const file = windows ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:KB_OPEN_URL'] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: 'ignore', env: { ...process.env, KB_OPEN_URL: url } });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('打开浏览器超时')); }, BROWSER_OPEN_TIMEOUT_MS);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('浏览器启动程序退出：' + code)); });
  });
}

export async function startAndOpen(dataDir: string, input: Record<string, unknown>) {
  const state = await handleService(['start', ...(input.port !== undefined ? ['--port', String(input.port)] : [])], dataDir);
  const warnings: string[] = [];
  if (state.running && 'url' in state && ![true, 'true'].includes(input.noOpen as any)) {
    try { await openBrowser(state.url); } catch { warnings.push('服务已启动，但无法自动打开浏览器；请手动访问上述地址。'); }
  }
  return { ...state, stopCommand: `cli.bat service stop --data-dir ${quoteArgument(dataDir)}`, warnings };
}

/** 菜单中的启动也经过源码入口，缺少页面构建时可自动修复。 */
export function prepareAndStart(dataDir: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/launch.mjs'), 'up', '--data-dir', dataDir, '--json'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      try {
        const reply = JSON.parse(output);
        if (code !== 0 || !reply.ok) throw new KnowledgeError(reply.error?.code ?? 'SETUP_FAILED', reply.error?.message ?? '启动准备失败', reply.error, code ?? 1);
        resolve(reply.data);
      } catch (error) { reject(error); }
    });
  });
}

/** 权限诊断使用 access，不试写文件，也不创建知识库。 */
export async function doctor(dataDir: string) {
  const checks: { name: string; ok: boolean; message: string }[] = [];
  checks.push({ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 24, message: process.version + '（要求 24+）' });
  let npmPath: string | undefined;
  for (const directory of [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]) {
    for (const relative of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js']) {
      try { const candidate = path.resolve(directory, relative); await access(candidate); npmPath = candidate; break; } catch {}
    }
    if (npmPath) break;
  }
  checks.push({ name: 'npm', ok: Boolean(npmPath), message: npmPath ?? '未找到 npm；请安装包含 npm 的 Node.js 24+' });
  for (const [name, file] of [['核心构建', 'dist/cli/main.js'], ['页面构建', 'dist/web/index.html'], ['依赖', 'node_modules/typescript/bin/tsc']]) {
    try { await access(path.join(REPO_ROOT, file)); checks.push({ name, ok: true, message: file }); }
    catch { checks.push({ name, ok: false, message: '缺少 ' + file }); }
  }
  let ancestor = dataDir;
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) break;
      ancestor = path.dirname(ancestor);
    }
  }
  try {
    if (!(await lstat(ancestor)).isDirectory()) throw new Error('数据路径不是目录');
    await access(ancestor, constants.R_OK | constants.W_OK);
    checks.push({ name: '数据目录权限', ok: true, message: ancestor === dataDir ? dataDir : `${dataDir} 尚未创建；父目录可写` });
  }
  catch { checks.push({ name: '数据目录权限', ok: false, message: '无法访问或写入 ' + ancestor }); }
  const service = await locateService(dataDir);
  checks.push({ name: '服务连通性', ok: Boolean(service), message: service ? service.state.url : '未检测到可验证的服务；可能尚未启动或状态、连通性异常' });
  return { healthy: checks.every(check => check.ok), dataDir, checks, suggestions: checks.every(check => check.ok) ? [] : [`运行 cli.bat up --data-dir ${quoteArgument(dataDir)} --no-open；启动失败时查看 service logs`] };
}

export async function serviceLogs(dataDir: string, lines = 50) {
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) throw new KnowledgeError('INVALID_ARGUMENT', '--lines 必须为 1–1000', undefined, 2);
  const logPath = path.join(dataDir, '.runtime', 'service.log');
  try {
    const root = await realpath(dataDir);
    const runtime = await realpath(path.dirname(logPath));
    if (path.relative(root, runtime) !== '.runtime' || (await lstat(logPath)).isSymbolicLink()) throw new KnowledgeError('UNSAFE_PATH', '日志目录不能是符号链接或 junction');
    const file = await open(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8').split(/\r?\n/).filter((_, index) => !start || index > 0).filter(Boolean).slice(-lines).join('\n');
      return { logPath, text: redactCredentials(text).text, truncated: start > 0, lines };
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { logPath, text: '', lines, truncated: false };
    throw error;
  }
}
