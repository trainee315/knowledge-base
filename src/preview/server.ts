import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadOnlyHandler, previewError, previewJson, type PreviewApplication } from './readonly.js';

interface ServerOptions { app: PreviewApplication; dataDir: string; webDir: string; port?: number; token?: string; onClose?: () => Promise<void> }
const ASSET_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** 构建页面与本地 API 同源；独立 CLI 预览提供令牌控制接口。 */
export async function createPreviewServer(options: ServerOptions) {
  const { app, dataDir, webDir } = options;
  const token = options.token ?? randomBytes(32).toString('hex');
  let origin = '';
  let closing: Promise<void> | undefined;
  const handle = createReadOnlyHandler({ app, dataDir, getOrigin: () => origin, control: async (request, response, url) => {
    if (request.headers.authorization !== `Bearer ${token}`) { previewJson(response, 403, { ok: false }); return; }
    if (url.pathname === '/_control/status' && request.method === 'GET') { previewJson(response, 200, { pid: process.pid, dataDir }); return; }
    if (url.pathname === '/_control/stop' && request.method === 'POST') { previewJson(response, 200, { stopped: true }); setImmediate(() => { void close(); }); return; }
    previewJson(response, 405, { ok: false });
  } });
  const server = createServer((request, response) => {
    void (async () => {
      if (await handle(request, response)) return;
      try {
        const url = new URL(request.url ?? '/', origin);
        const path = resolve(webDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!path.startsWith(resolve(webDir) + sep)) { previewJson(response, 403, { ok: false }); return; }
        const data = await readFile(path);
        response.writeHead(200, { 'Content-Type': ASSET_TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : data);
      } catch (error) { previewError(response, error); }
    })();
  });
  async function close(): Promise<void> {
    closing ??= (async () => {
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      try { await app.close(); } finally { await options.onClose?.(); }
    })();
    return closing;
  }
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', fail); done(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法分配临时端口');
    origin = `http://127.0.0.1:${address.port}`;
    return { server, url: origin, port: address.port, token, close };
  } catch (error) { await close(); throw error; }
}
