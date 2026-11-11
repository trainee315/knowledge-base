import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KnowledgeError } from '../core/errors.js';
import { acquirePreviewMutex } from './mutex.js';

export interface PreviewState { running: boolean; dataDir: string; url?: string; port?: number; pid?: number; token?: string }
// 只控制临时预览；正式业务状态不依赖这些进程记录。
const START_TIMEOUT_MS = 30_000;
const identity = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
export const statePath = (dataDir: string): string => resolve(dataDir, '.runtime', 'preview.json');

async function runtimeDirectory(dataDir: string, create = false): Promise<void> {
  const path = resolve(dataDir, '.runtime');
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || identity(await realpath(path)) !== identity(path)) throw new KnowledgeError('UNSAFE_PATH', '预览运行目录不能是符号链接或 junction');
}

export async function saveState(state: PreviewState): Promise<void> {
  await runtimeDirectory(state.dataDir, true);
  const temp = resolve(state.dataDir, '.runtime', `preview-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temp, statePath(state.dataDir));
  } finally { await rm(temp, { force: true }); }
}

export async function removeState(dataDir: string, token?: string): Promise<void> {
  try {
    await runtimeDirectory(dataDir);
    const current = JSON.parse(await readFile(statePath(dataDir), 'utf8')) as PreviewState;
    if (!token || current.token === token) await rm(statePath(dataDir), { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function readState(dataDir: string): Promise<PreviewState | undefined> {
  try {
    await runtimeDirectory(dataDir);
    const state = JSON.parse(await readFile(statePath(dataDir), 'utf8')) as PreviewState;
    const url = new URL(state.url ?? '');
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !state.token || identity(state.dataDir) !== identity(dataDir)) return undefined;
    const response = await fetch(`${url.origin}/_control/status`, { headers: { Authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1500) });
    const status = await response.json() as { pid: number; dataDir: string };
    return response.ok && status.pid === state.pid && identity(status.dataDir) === identity(dataDir) ? state : undefined;
  } catch { return undefined; }
}

function publicState(state: PreviewState): Omit<PreviewState, 'token'> {
  const { token: _token, ...result } = state;
  return result;
}

function reuse(state: PreviewState, port: number): Omit<PreviewState, 'token'> {
  if (port && port !== state.port) throw new KnowledgeError('PREVIEW_ALREADY_RUNNING', `预览已运行于 ${state.url}，请先停止再切换端口`);
  return publicState(state);
}

function launch(dataDir: string, port: number): Promise<unknown> {
  return new Promise((done, fail) => {
    let settled = false;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), '--data-dir', dataDir, '--port', String(port)], {
      detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(() => { child.kill(); fail(new Error('临时预览启动超时')); }, START_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); fail(error); });
    child.once('exit', (code) => { clearTimeout(timer); if (!settled) fail(new Error(`临时预览进程退出 (${code})`)); });
    child.once('message', (message: any) => {
      settled = true; clearTimeout(timer);
      if (!message.ok) { fail(new KnowledgeError(message.code ?? 'PREVIEW_ERROR', message.error)); return; }
      child.disconnect(); child.unref(); done(publicState(message.state));
    });
  });
}

/** canonical 目录与 OS IPC 互斥消除别名/失效 PID 文件的生命周期竞争。 */
export async function handlePreview(args: string[], inputDataDir: string): Promise<unknown> {
  const [operation, ...options] = args.filter((arg) => arg !== '--json');
  let port = 0;
  if (operation === 'start' && options.length) {
    if (options.length !== 2 || options[0] !== '--port' || !/^\d{1,5}$/.test(options[1]) || Number(options[1]) > 65535) throw new KnowledgeError('INVALID_ARGUMENT', '预览端口必须为 0–65535', undefined, 2);
    port = Number(options[1]);
  } else if (options.length || !['start', 'stop', 'status'].includes(operation)) {
    throw new KnowledgeError('INVALID_ARGUMENT', '请使用 preview start [--port 端口]、preview status 或 preview stop', undefined, 2);
  }
  const requested = resolve(inputDataDir);
  if (operation === 'start') await mkdir(requested, { recursive: true });
  let dataDir: string;
  try { dataDir = await realpath(requested); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { running: false, dataDir: requested }; throw error; }
  const release = await acquirePreviewMutex(dataDir, 'operation');
  try {
    const existing = await readState(dataDir);
    if (operation === 'status') return existing ? publicState(existing) : { running: false, dataDir };
    if (operation === 'stop') {
      if (!existing) return { running: false, dataDir };
      const response = await fetch(`${existing.url}/_control/stop`, { method: 'POST', headers: { Authorization: `Bearer ${existing.token}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('临时预览服务未能停止');
      // 等待旧 worker 释放实例锁；之后才能清理记录或允许下一次 start。
      const instanceReleased = await acquirePreviewMutex(dataDir, 'instance', 5000);
      try { await removeState(dataDir, existing.token); } finally { await instanceReleased(); }
      return { running: false, dataDir, stoppedPid: existing.pid };
    }
    if (existing) return reuse(existing, port);
    await runtimeDirectory(dataDir, true);
    return await launch(dataDir, port);
  } finally { await release(); }
}
