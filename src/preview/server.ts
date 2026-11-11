import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CoreApi, ResourceMeta } from '../contracts/index.js';

interface Application {
  manager: CoreApi & { resolveContentPath(id: string): Promise<string> };
  plugins: { list(): unknown; execute(name: string, input: Record<string, unknown>, args: string[]): Promise<unknown> };
  close(): Promise<void>;
}
interface ServerOptions { app: Application; dataDir: string; webDir: string; port?: number; token?: string; onClose?: () => Promise<void> }
// 只向浏览器内联显示被动图片格式，SVG/HTML 等原件统一作为附件下载。
const INLINE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const ASSET_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function unavailable(error: unknown): boolean { return ['COMMAND_NOT_FOUND', 'UNKNOWN_COMMAND', 'PLUGIN_UNAVAILABLE', 'PLUGIN_DISABLED', 'NOT_FOUND'].includes((error as any)?.code); }

/** 页面和业务只读 API 共用 loopback origin；控制接口只接受进程随机令牌。 */
export async function createPreviewServer(options: ServerOptions) {
  const { app, dataDir, webDir } = options;
  const token = options.token ?? randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer((request, response) => { void handle(request, response); });
  let closing: Promise<void> | undefined;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { json(response, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '仅允许本地同源访问' } }); return; }
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname.startsWith('/_control/')) {
        if (request.headers.authorization !== `Bearer ${token}`) { json(response, 403, { ok: false }); return; }
        if (url.pathname === '/_control/status' && request.method === 'GET') { json(response, 200, { pid: process.pid, dataDir }); return; }
        if (url.pathname === '/_control/stop' && request.method === 'POST') { json(response, 200, { stopped: true }); setImmediate(() => { void close(); }); return; }
        json(response, 405, { ok: false }); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { ok: false, error: { code: 'READ_ONLY', message: '预览只支持读取' } }); return; }
      if (url.pathname === '/api/resources') {
        const input: Record<string, unknown> = {};
        for (const name of ['filename', 'body', 'keywords', 'tags', 'systems', 'parseStatus']) if (url.searchParams.has(name)) input[name] = url.searchParams.getAll(name);
        for (const name of ['offset', 'limit']) if (url.searchParams.has(name)) {
          const value = Number(url.searchParams.get(name));
          if (!Number.isInteger(value) || value < 0 || (name === 'limit' && (value < 1 || value > 200))) throw Object.assign(new Error('分页参数无效'), { code: 'INVALID_ARGUMENT' });
          input[name] = value;
        }
        let data;
        try { data = await app.plugins.execute('organize query', input, []); }
        catch (error) {
          if (!unavailable(error)) throw error;
          if (['body', 'keywords', 'tags', 'systems'].some((key) => input[key])) throw Object.assign(new Error('当前筛选需要启用相应业务插件'), { code: 'PLUGIN_UNAVAILABLE' });
          const all = (await app.manager.listResources()).filter((item) => (!(input.filename as string[] | undefined)?.length || (input.filename as string[]).some((term) => item.resource.originalName.normalize('NFKC').toLowerCase().includes(term.normalize('NFKC').toLowerCase()))) && (!(input.parseStatus as string[] | undefined)?.length || (input.parseStatus as string[]).includes(item.parseStatus)));
          const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 30);
          data = { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
        }
        json(response, 200, { ok: true, data }); return;
      }
      const resourceMatch = /^\/api\/resources\/([^/]+)(\/file)?$/.exec(url.pathname);
      if (resourceMatch) {
        const id = resourceMatch[1];
        if (!UUID.test(id)) throw Object.assign(new Error('资源 UUID 无效'), { code: 'INVALID_ARGUMENT' });
        const resource = await app.manager.getResource(id);
        if (resourceMatch[2]) { await file(response, resource, url.searchParams.get('inline') === '1', request.method === 'HEAD'); return; }
        let content: unknown = { status: 'unparsed' };
        try {
          content = await app.plugins.execute('content get', { id }, []) ?? { status: 'pending' };
          if ((content as any).inputVersion !== undefined && (content as any).inputVersion !== resource.contentVersion) content = { status: 'pending', stale: true };
        } catch (error) { if (!unavailable(error)) throw error; }
        json(response, 200, { ok: true, data: { resource, content } }); return;
      }
      if (url.pathname === '/api/organizations') { json(response, 200, { ok: true, data: await app.manager.listOrganizations() }); return; }
      if (url.pathname === '/api/organization-types') { json(response, 200, { ok: true, data: await app.manager.listOrganizationTypes() }); return; }
      if (url.pathname === '/api/plugins') {
        const list = await app.plugins.list() as any[];
        const data = list.map((item) => item.manifest ? { ...item.manifest, enabled: item.enabled, status: item.failure ? 'failed' : item.enabled ? (item.ready ? 'ready' : 'pending') : 'disabled', dataVersion: item.dataVersion, failure: item.failure } : item);
        json(response, 200, { ok: true, data }); return;
      }
      if (url.pathname.startsWith('/api/')) { json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '只读接口不存在' } }); return; }
      const path = resolve(webDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(resolve(webDir) + sep)) { json(response, 403, { ok: false }); return; }
      const data = await readFile(path);
      response.writeHead(200, { 'Content-Type': ASSET_TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const code = (error as any)?.code ?? 'PREVIEW_ERROR';
      const status = code === 'INVALID_ARGUMENT' ? 400 : ['NOT_FOUND', 'ENOENT'].includes(code) ? 404 : code === 'PLUGIN_UNAVAILABLE' ? 409 : 500;
      if (!response.headersSent) json(response, status, { ok: false, error: { code, message: (error as Error).message } }); else response.destroy();
    }
  }
  async function file(response: ServerResponse, resource: ResourceMeta, inline: boolean, head: boolean): Promise<void> {
    const data = await app.manager.readContent(resource.id);
    const allowedInline = inline && INLINE_MEDIA.has(resource.mediaType);
    response.writeHead(200, { 'Content-Type': allowedInline ? resource.mediaType : 'application/octet-stream', 'Content-Length': data.length, 'Content-Disposition': `${allowedInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(resource.originalName)}`, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    response.end(head ? undefined : data);
  }
  async function close(): Promise<void> {
    closing ??= (async () => {
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      try { await app.close(); } finally { await options.onClose?.(); }
    })();
    return closing;
  }
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(options.port ?? 0, '127.0.0.1', () => done()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配临时端口');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin, port: address.port, token, close };
}
