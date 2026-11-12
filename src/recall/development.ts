import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { KnowledgeError } from '../core/errors.js';

// 显式开发负载租约，不安装钩子/任务；进程退出或租约到期后自动失效。
const MARKER = path.join(tmpdir(), 'kb-recall-development-' + createHash('sha256').update(homedir()).digest('hex').slice(0, 16) + '.json');
const MAX_WORKLOAD_MS = 30 * 60 * 1000;
export async function developmentBusy(): Promise<boolean> {
  try {
    const info = await fs.lstat(MARKER); if (info.isSymbolicLink()) throw new KnowledgeError('UNSAFE_PATH', '开发负载标记不能是链接');
    const state = JSON.parse(await fs.readFile(MARKER, 'utf8'));
    if (!Number.isInteger(state.pid) || state.expires <= Date.now()) return false;
    try { process.kill(state.pid, 0); return true; } catch { return false; }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    // Windows删除中的文件可能短暂返回EPERM；保守让出，下次轮询重新检查。
    if (process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(code ?? '')) return true;
    throw error;
  }
}
export async function requireDevelopmentIdle(): Promise<void> { if (await developmentBusy()) throw new KnowledgeError('DEVELOPMENT_BUSY', '开发负载优先，召回计算已让出；负载结束后可重试'); }

/** 同一CLI包裹真实构建/测试，在finally释放租约；子命令不经过shell解释。 */
export async function runDevelopmentWorkload(input: Record<string, unknown>) {
  if (!['node', 'npm'].includes(String(input.command)) || !Array.isArray(input.args) || input.args.some(a => typeof a !== 'string')) throw new KnowledgeError('INVALID_ARGUMENT', 'workload 需要 command=node|npm 和字符串 args', undefined, 2);
  const mutex = createServer();
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\kb-recall-development-owner' : path.join(tmpdir(), 'kb-recall-development-owner.sock');
  try { await new Promise<void>((resolve, reject) => { mutex.once('error', reject); mutex.listen(endpoint, resolve); }); } catch { throw new KnowledgeError('DEVELOPMENT_BUSY', '已有受保护开发负载执行'); }
  try {
  await requireDevelopmentIdle();
  const token = randomUUID(); const started = performance.now();
  // 过期标记仅删除本模块固定文件；拒绝符号链接。
  try { const info = await fs.lstat(MARKER); if (info.isSymbolicLink()) throw new KnowledgeError('UNSAFE_PATH', '开发标记不能是链接'); await fs.unlink(MARKER); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pending = MARKER + '.' + token + '.tmp';
  // 先完成临时文件再原子发布；并行校验不能读到create与write之间的空JSON。
  try { await fs.writeFile(pending, JSON.stringify({ pid: process.pid, expires: Date.now() + MAX_WORKLOAD_MS, token }), { flag: 'wx' }); await fs.rename(pending, MARKER); }
  finally { await fs.unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  try {
    const args = input.command === 'npm' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...input.args] : input.args;
    const result = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, args as string[], { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stderr, { end: false }); child.stderr.pipe(process.stderr, { end: false });
      const timer = setTimeout(() => child.kill(), MAX_WORKLOAD_MS);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', exitCode => { clearTimeout(timer); resolve({ exitCode }); });
    });
    return { ...result, durationMs: performance.now() - started, policy: 'explicit-development-priority', logs: 'stderr' };
  } finally { const state = JSON.parse(await fs.readFile(MARKER, 'utf8')); if (state.token === token) await fs.unlink(MARKER); }
  } finally { await new Promise<void>(resolve => mutex.close(() => resolve())); }
}
