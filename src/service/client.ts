import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KnowledgeError } from '../core/errors.js';
import { acquirePreviewMutex } from '../preview/mutex.js';

interface ServiceState { running: true; dataDir: string; url: string; port: number; pid: number; token: string }
type PublicState = Omit<ServiceState, 'token' | 'running'> & { running: boolean; stopping?: boolean; active?: unknown };
export interface ServiceCommand { words: string[]; input: Record<string, unknown>; stdinBase64?: string }

const START_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 3_000;
const DRAIN_TIMEOUT_MS = 330_000;
const identity = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
const statePath = (dataDir: string): string => resolve(dataDir, '.runtime', 'service.json');

async function runtimeDirectory(dataDir: string, create = false): Promise<void> {
  const path = resolve(dataDir, '.runtime');
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || identity(await realpath(path)) !== identity(path)) throw new KnowledgeError('UNSAFE_PATH', '服务运行目录不能是符号链接或 junction');
}

export async function saveServiceState(state: ServiceState): Promise<void> {
  await runtimeDirectory(state.dataDir, true);
  const temp = resolve(state.dataDir, '.runtime', 'service-' + randomUUID() + '.tmp');
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temp, statePath(state.dataDir));
  } finally { await rm(temp, { force: true }); }
}

export async function removeServiceState(dataDir: string, token: string): Promise<void> {
  try {
    const current = await readStateFile(dataDir);
    if (current?.token === token) await rm(statePath(dataDir), { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function readStateFile(dataDir: string): Promise<ServiceState | undefined> {
  await runtimeDirectory(dataDir);
  const file = statePath(dataDir);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  const state = JSON.parse(await readFile(file, 'utf8')) as ServiceState;
  const url = new URL(state.url);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.origin !== state.url || !/^[a-f0-9]{64}$/.test(state.token) || identity(state.dataDir) !== identity(dataDir)) return undefined;
  return state;
}

function authorization(state: ServiceState): Record<string, string> {
  return { Authorization: 'Bearer ' + state.token };
}

export async function locateService(inputDataDir: string): Promise<{ state: ServiceState; status: PublicState } | undefined> {
  try {
    const dataDir = await realpath(resolve(inputDataDir));
    const state = await readStateFile(dataDir);
    if (!state) return undefined;
    const response = await fetch(state.url + '/_control/status', { headers: authorization(state), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS), redirect: 'error' });
    const status = await response.json() as PublicState;
    return response.ok && status.pid === state.pid && identity(status.dataDir) === identity(dataDir) ? { state, status } : undefined;
  } catch { return undefined; }
}

function offline(dataDir: string): KnowledgeError {
  return new KnowledgeError('SERVICE_OFFLINE', '未检测到可验证的知识库服务；可能尚未启动或状态、连通性异常。请检查 service status --data-dir "' + dataDir + '"');
}

export async function serviceOrigin(dataDir: string): Promise<string> {
  const service = await locateService(dataDir);
  if (!service) throw offline(dataDir);
  return service.state.url;
}

export async function callService(dataDir: string, command: ServiceCommand): Promise<unknown> {
  const service = await locateService(dataDir);
  if (!service) throw offline(dataDir);
  const response = await fetch(service.state.url + '/_control/command', {
    method: 'POST',
    headers: { ...authorization(service.state), 'Content-Type': 'application/json' },
    body: JSON.stringify(command), redirect: 'error',
  });
  const reply = await response.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown; exitCode: number } };
  if (!reply.ok) {
    const error = reply.error;
    throw new KnowledgeError(error?.code ?? 'SERVICE_ERROR', error?.message ?? '服务调用失败', error?.details, error?.exitCode ?? 1);
  }
  return reply.data;
}

async function launch(dataDir: string, port?: number): Promise<PublicState> {
  const logPath = resolve(dataDir, '.runtime', 'service.log');
  try { if ((await lstat(logPath)).isSymbolicLink()) throw new KnowledgeError('UNSAFE_PATH', '服务日志不能是符号链接'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  await log.write(`${new Date().toISOString()} 启动知识库服务\n`);
  try {
  return new Promise((resolve, reject) => {
    const args = [fileURLToPath(new URL('./worker.js', import.meta.url)), dataDir, ...(port === undefined ? [] : [String(port)])];
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
    let ready = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new KnowledgeError('SERVICE_START_TIMEOUT', '知识库服务启动超时'));
    }, START_TIMEOUT_MS);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!ready) reject(new KnowledgeError('SERVICE_START_FAILED', '知识库服务进程退出 (' + code + ')'));
    });
    child.once('message', (message: { ok: boolean; code?: string; message?: string; state: PublicState }) => {
      clearTimeout(timer);
      if (!message.ok) {
        reject(new KnowledgeError(message.code ?? 'SERVICE_START_FAILED', message.message ?? '知识库服务启动失败'));
        return;
      }
      ready = true;
      child.disconnect();
      child.unref();
      resolve(message.state);
    });
  });
  } finally { await log.close(); }
}

export async function handleService(args: string[], inputDataDir: string): Promise<PublicState | { running: false; dataDir: string; stoppedPid?: number }> {
  const [operation, ...options] = args;
  let port: number | undefined;
  if (!['start', 'stop', 'status', 'restart'].includes(operation) || options.length && (!['start', 'restart'].includes(operation) || options.length !== 2 || options[0] !== '--port' || !/^\d{1,5}$/.test(options[1]) || Number(options[1]) > 65535)) {
    throw new KnowledgeError('INVALID_ARGUMENT', '请使用 service start|restart [--port 0–65535]、service status 或 service stop', undefined, 2);
  }
  if (options.length) port = Number(options[1]);
  const requested = resolve(inputDataDir);
  if (operation === 'start' || operation === 'restart') await mkdir(requested, { recursive: true });
  let dataDir: string;
  try { dataDir = await realpath(requested); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { running: false, dataDir: requested }; throw error; }

  if (operation === 'status') return (await locateService(dataDir))?.status ?? { running: false, dataDir };
  const release = await acquirePreviewMutex(dataDir, 'operation', DRAIN_TIMEOUT_MS);
  try {
    const service = await locateService(dataDir);
    if (operation === 'stop' || operation === 'restart') {
      if (service) {
        const response = await fetch(service.state.url + '/_control/stop', { method: 'POST', headers: authorization(service.state), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS), redirect: 'error' });
        if (!response.ok) throw new KnowledgeError('SERVICE_STOP_FAILED', '知识库服务未能停止');
        const released = await acquirePreviewMutex(dataDir, 'instance', DRAIN_TIMEOUT_MS);
        try { await removeServiceState(dataDir, service.state.token); } finally { await released(); }
      }
      if (operation === 'stop') return { running: false, dataDir, stoppedPid: service?.state.pid };
    } else if (service) {
      if (port && port !== service.state.port) throw new KnowledgeError('SERVICE_ALREADY_RUNNING', '服务已运行于 ' + service.state.url + '，可使用 restart 切换端口');
      return service.status;
    }
    await runtimeDirectory(dataDir, true);
    return await launch(dataDir, port);
  } finally { await release(); }
}
