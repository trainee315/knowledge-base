import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CoreManager } from '../core/manager.js';
import { KnowledgeError, assert } from '../core/errors.js';
import { WriterQueue } from '../core/writer-queue.js';
import { openApplication } from '../index.js';
import { acquirePreviewMutex } from '../preview/mutex.js';
import { createReadOnlyHandler, previewError, previewJson } from '../preview/readonly.js';
import { removeServiceState, saveServiceState } from './client.js';
import { dispatch } from './dispatch.js';
import { getServicePort, openServiceDatabase, setServicePort } from './database.js';
import { createCronService } from './cron-service.js';
import { backupRestore, finishRestore } from './backup.js';
import { semanticService } from '../semantic/service.js';
import { handlePluginRoutes } from './plugin-routes.js';
import { redactCredentials } from '../records/redaction.js';

// 命令请求可携带二进制原文；浏览器写 API 自行使用更小限制。
const COMMAND_BYTES_LIMIT = 64 * 1024 * 1024;
const ASSET_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const BUILT_ASSET = /^\/assets\/[a-z\d_.-]+\.(?:js|css|svg|png|ico)$/i;
const pathIdentity = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const inside = (root: string, path: string) => pathIdentity(path).startsWith(pathIdentity(root) + sep);

async function readCommand(request: IncomingMessage) {
  assert(request.headers['content-type'] === 'application/json', 'INVALID_ARGUMENT', 'CLI 请求必须为 JSON');
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    assert(size <= COMMAND_BYTES_LIMIT, 'REQUEST_TOO_LARGE', 'CLI 请求体超出限制');
    buffers.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new KnowledgeError('INVALID_ARGUMENT', 'CLI 请求不是合法 JSON', undefined, 2); }
  const data = value as { words?: unknown; input?: unknown; stdinBase64?: unknown } | null;
  assert(data && Array.isArray(data.words) && data.words.every(word => typeof word === 'string') && data.input && typeof data.input === 'object' && !Array.isArray(data.input), 'INVALID_ARGUMENT', 'CLI 命令结构无效');
  assert(data.stdinBase64 === undefined || typeof data.stdinBase64 === 'string', 'INVALID_ARGUMENT', 'CLI 字节流结构无效');
  return {
    words: data.words as string[], input: data.input as Record<string, unknown>,
    stdinBytes: data.stdinBase64 === undefined ? undefined : Buffer.from(data.stdinBase64, 'base64'),
  };
}

function commandError(response: ServerResponse, error: unknown): void {
  const known = error instanceof KnowledgeError;
  previewJson(response, 200, {
    ok: false,
    error: {
      code: known ? error.code : (error as NodeJS.ErrnoException)?.code ?? 'EXECUTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      exitCode: known ? error.exitCode : 1,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

/** 单一进程承接生命周期、业务请求和后台调度。 */
async function start(): Promise<void> {
  const dataDir = await realpath(resolve(process.argv[2]));
  const webDir = await realpath(fileURLToPath(new URL('../web/', import.meta.url)));
  const dataInsideWeb = pathIdentity(dataDir) === pathIdentity(webDir) || inside(webDir, dataDir);
  await access(resolve(webDir, 'index.html'));
  const release = await acquirePreviewMutex(dataDir, 'instance', 3000);
  const token = randomBytes(32).toString('hex');
  const queue = new WriterQueue();
  const inFlight = new Set<Promise<void>>();
  let origin = '';
  let port = 0;
  let stopping = false;
  let maintenance = false;
  let db: Awaited<ReturnType<typeof openServiceDatabase>> | undefined;
  let cron: Awaited<ReturnType<typeof createCronService>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let closing: Promise<void> | undefined;
  const semantic = semanticService(dataDir, action => queue.run(action));

  function close(): Promise<void> {
    stopping = true;
    closing ??= (async () => {
      try {
        await Promise.allSettled([semantic.stop(), cron?.stop(), ...inFlight]);
      } finally {
        try {
          // 备份或恢复的 finally 可能重新启用计时器；请求排空后再次停止。
          await cron?.stop();
        } finally {
          try {
            if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
            db?.close();
            await removeServiceState(dataDir, token);
          } finally { await release(); }
        }
      }
    })();
    return closing;
  }

  const domainDispatch = (words: string[], input: Record<string, unknown>, stdinBytes?: Buffer) => queue.run(() => dispatch(dataDir, words, input, stdinBytes));
  const shutdown = () => { void close().catch(() => { process.exitCode = 1; }); };
  try {
    const recovery = await CoreManager.open(dataDir);
    await recovery.close();
    const database = db = await openServiceDatabase(dataDir);
    const scheduler = cron = await createCronService({ db: database, dataDir, dispatch: domainDispatch });
    await queue.run(() => finishRestore(dataDir, database, scheduler));

    async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const allowedHost = origin && request.headers.host === new URL(origin).host;
      const requestOrigin = request.headers.origin;
      const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
      if (!allowedHost || url.origin !== origin || requestOrigin && requestOrigin !== origin) {
        previewJson(response, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '仅允许本地同源访问' } });
        return;
      }
      const control = url.pathname === '/_control' || url.pathname.startsWith('/_control/');
      if (control && (requestOrigin !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers.authorization !== 'Bearer ' + token)) {
        previewJson(response, 403, { ok: false, error: { code: 'CONTROL_FORBIDDEN', message: '控制接口仅供授权 CLI 使用' } });
        return;
      }
      if (control && url.pathname === '/_control/status' && request.method === 'GET') {
        previewJson(response, 200, { running: true, stopping, dataDir, pid: process.pid, url: origin, port, active: { requests: inFlight.size, cron: scheduler.status(), maintenance } });
        return;
      }
      if (control && url.pathname === '/_control/stop' && request.method === 'POST') {
        stopping = true;
        previewJson(response, 200, { stopping: true });
        setImmediate(shutdown);
        return;
      }
      if (stopping || maintenance) {
        const error = new KnowledgeError(stopping ? 'SERVICE_STOPPING' : 'SERVICE_BUSY', stopping ? '服务正在停止' : '服务正在执行备份或恢复');
        if (control) commandError(response, error);
        else previewJson(response, 503, { ok: false, error: { code: error.code, message: error.message } });
        return;
      }
      if (control && url.pathname === '/_control/command' && request.method === 'POST') {
        try {
          const { words, input, stdinBytes } = await readCommand(request);
          let data: unknown;
          if (words[0] === 'backup' || words[0] === 'restore') {
            if (inFlight.size > 1 || maintenance) throw new KnowledgeError('SERVICE_BUSY', '有其他请求正在执行，请稍后重试备份或恢复');
            maintenance = true;
            try { await semantic.stop(); data = await queue.run(() => backupRestore(words[0] as 'backup' | 'restore', input, dataDir, database, scheduler)); }
            finally { maintenance = false; if (!stopping) semantic.start(); }
          } else {
            const result = await queue.run(() => scheduler.command(words, input));
            data = result.handled ? result.data : await domainDispatch(words, input, stdinBytes);
          }
          semantic.wake();
          previewJson(response, 200, { ok: true, data });
        } catch (error) {
          if (error instanceof KnowledgeError && error.code === 'RESTORE_RECOVERY_REQUIRED') {
            stopping = true;
            setImmediate(shutdown);
          }
          commandError(response, error);
        }
        return;
      }
      if (control) {
        previewJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '控制接口不存在' } });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await queue.run(async () => {
          if (await semantic.handle(request, response, url, origin)) return;
          if (await handlePluginRoutes(request, response, url, origin, { dataDir, dispatch: domainDispatch, cron: scheduler })) return;
          const app = await openApplication(dataDir, { readOnly: true });
          try {
            const handle = createReadOnlyHandler({
              app, dataDir, getOrigin: () => origin,
              extension: scheduler.handle,
            });
            await handle(request, response);
          } finally { await app.close(); }
        });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        previewJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '静态页面仅支持读取' } });
        return;
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      if (pathname !== '/index.html' && !BUILT_ASSET.test(pathname)) {
        previewJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '静态资源不存在' } });
        return;
      }
      const path = await realpath(resolve(webDir, '.' + pathname));
      if (!inside(webDir, path) || dataInsideWeb && inside(dataDir, path)) {
        previewJson(response, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '无效静态文件路径' } });
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        'Content-Type': ASSET_TYPES[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    }

    const listener = server = createServer({ requestTimeout: 30_000 }, (request, response) => {
      const operation = route(request, response).catch(error => previewError(response, error));
      if (request.url === '/_control/status' || request.url === '/_control/stop') return;
      inFlight.add(operation);
      void operation.then(() => inFlight.delete(operation));
    });
    const requestedPort = process.argv[3] === undefined ? getServicePort(database) : Number(process.argv[3]);
    await new Promise<void>((ready, fail) => {
      listener.once('error', fail);
      listener.listen(requestedPort, '127.0.0.1', () => {
        listener.removeListener('error', fail);
        ready();
      });
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new KnowledgeError('SERVICE_START_FAILED', '无法分配服务端口');
    port = address.port;
    origin = 'http://127.0.0.1:' + port;
    const state = { running: true as const, dataDir, pid: process.pid, url: origin, port };
    setServicePort(database, requestedPort);
    await saveServiceState({ ...state, token });
    scheduler.start();
    semantic.start();
    process.send?.({ ok: true, state });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);
  } catch (error) {
    await close();
    throw error;
  }
}

void start().catch((error: unknown) => {
  const message = redactCredentials(error instanceof Error ? error.message : String(error)).text;
  const code = error instanceof KnowledgeError ? error.code : (error as NodeJS.ErrnoException)?.code;
  process.stderr.write(`${new Date().toISOString()} ${code ?? 'SERVICE_START_FAILED'}: ${message}\n`);
  process.send?.({ ok: false, code, message });
  process.exitCode = 1;
  process.disconnect?.();
});
