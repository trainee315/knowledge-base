import { semanticResourceQuery } from '../semantic/query.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CoreApi, ResourceMeta } from '../contracts/index.js';
import { browse } from './browse.js';
import { handleTranscripts } from './transcripts.js';
export interface PreviewApplication {
  manager: CoreApi;
  plugins: { list(): unknown; execute(name: string, input: Record<string, unknown>, args: string[]): Promise<unknown> };
  close(): Promise<void>;
}

interface HandlerOptions {
  app: PreviewApplication;
  getOrigin(): string;
  dataDir?: string;
  control?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>;
  extension?: (request: IncomingMessage, response: ServerResponse, url: URL, origin: string) => Promise<boolean>;
}
// 只向浏览器内联显示被动图片格式，SVG/HTML 等原件统一作为附件下载。
const INLINE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function previewJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function unavailable(error: unknown): boolean { return ['COMMAND_NOT_FOUND', 'UNKNOWN_COMMAND', 'PLUGIN_UNAVAILABLE', 'PLUGIN_DISABLED', 'NOT_FOUND'].includes((error as any)?.code); }


export function previewError(response: ServerResponse, error: unknown): void {
  const code = (error as any)?.code ?? 'PREVIEW_ERROR';
  const status = code === 'INVALID_ARGUMENT' ? 400 : code === 'LOCAL_ONLY' ? 403 : ['NOT_FOUND', 'ENOENT'].includes(code) ? 404 : ['PLUGIN_UNAVAILABLE', 'REVISION_CONFLICT', 'ALIAS_CONFLICT', 'TRANSCRIPT_BUSY', 'WRITER_LOCKED'].includes(code) ? 409 : 500;
  if (!response.headersSent) previewJson(response, status, { ok: false, error: { code, message: (error as Error).message } }); else response.destroy();
}
/** CLI 与 Vite 共享浏览及显式配置入口；false 交由各自页面处理器。 */
export function createReadOnlyHandler(options: HandlerOptions) {
  const { app } = options;
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const origin = options.getOrigin();
      if (!origin || request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { previewJson(response, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '仅允许本地同源访问' } }); return true; }
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/_control' || url.pathname.startsWith('/_control/')) {
        if (options.control) await options.control(request, response, url);
        else previewJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '开发服务器不提供控制接口' } });
        return true;
      }
      if (await options.extension?.(request, response, url, origin)) return true;
      if (options.dataDir && await handleTranscripts(request, response, url, options.dataDir, origin)) return true;
      if (request.method !== 'GET' && request.method !== 'HEAD') { previewJson(response, 405, { ok: false, error: { code: 'READ_ONLY', message: '预览只支持读取' } }); return true; }
      if (url.pathname.startsWith('/api/browse/') || url.pathname.startsWith('/api/project-tracking/')) { previewJson(response, 200, { ok: true, data: await browse(app, url) }); return true; }
      if (url.pathname === '/api/resources') {
        const input: Record<string, unknown> = {};
        if (url.searchParams.has('tagMatch')) input.tagMatch = url.searchParams.get('tagMatch');
        for (const name of ['filename', 'body', 'keywords', 'tags', 'systems', 'parseStatus']) if (url.searchParams.has(name)) input[name] = url.searchParams.getAll(name);
        for (const name of ['offset', 'limit']) if (url.searchParams.has(name)) {
          const value = Number(url.searchParams.get(name));
          if (!Number.isInteger(value) || value < 0 || (name === 'limit' && (value < 1 || value > 200))) throw Object.assign(new Error('分页参数无效'), { code: 'INVALID_ARGUMENT' });
          input[name] = value;
        }
        let data;
        try { data = options.dataDir ? await semanticResourceQuery(options.dataDir, input, value => app.plugins.execute('organize query', value, [])) : await app.plugins.execute('organize query', input, []); }
        catch (error) {
          if (!unavailable(error)) throw error;
          if (['body', 'keywords', 'tags', 'systems'].some((key) => input[key])) throw Object.assign(new Error('当前筛选需要启用相应业务插件'), { code: 'PLUGIN_UNAVAILABLE' });
          const all = (await app.manager.listResources()).filter((item) => (!(input.filename as string[] | undefined)?.length || (input.filename as string[]).some((term) => item.resource.originalName.normalize('NFKC').toLowerCase().includes(term.normalize('NFKC').toLowerCase()))) && (!(input.parseStatus as string[] | undefined)?.length || (input.parseStatus as string[]).includes(item.parseStatus)));
          const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 30);
          data = { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
        }
        previewJson(response, 200, { ok: true, data }); return true;
      }
      const resourceMatch = /^\/api\/resources\/([^/]+)(\/file)?$/.exec(url.pathname);
      if (resourceMatch) {
        const id = resourceMatch[1];
        if (!UUID.test(id)) throw Object.assign(new Error('资源 UUID 无效'), { code: 'INVALID_ARGUMENT' });
        const resource = await app.manager.getResource(id);
        if (resourceMatch[2]) { await file(response, resource, url.searchParams.get('inline') === '1', request.method === 'HEAD'); return true; }
        let content: unknown = { status: 'unparsed' };
        try {
          content = await app.plugins.execute('content get', { id }, []) ?? { status: 'pending' };
          if ((content as any).inputVersion !== undefined && (content as any).inputVersion !== resource.contentVersion) content = { status: 'pending', stale: true };
        } catch (error) { if (!unavailable(error)) throw error; }
        previewJson(response, 200, { ok: true, data: { resource, content } }); return true;
      }
      if (url.pathname === '/api/organizations') { previewJson(response, 200, { ok: true, data: (await app.manager.listOrganizations()).filter(org => !org.data.semanticDeletedAt).map(org => org.type === 'session-transcript' ? { ...org, data: { schemaVersion: 1 } } : org) }); return true; }
      if (url.pathname === '/api/organization-types') { previewJson(response, 200, { ok: true, data: await app.manager.listOrganizationTypes() }); return true; }
      if (url.pathname === '/api/plugins') {
        const list = await app.plugins.list() as any[];
        const data = list.map((item) => item.manifest ? { ...item.manifest, enabled: item.enabled, status: item.failure ? 'failed' : item.enabled ? (item.ready ? 'ready' : 'pending') : 'disabled', dataVersion: item.dataVersion, failure: item.failure } : item);
        previewJson(response, 200, { ok: true, data }); return true;
      }
      if (url.pathname.startsWith('/api/')) { previewJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '只读接口不存在' } }); return true; }
      return false;
    } catch (error) { previewError(response, error); return true; }
  };
  async function file(response: ServerResponse, resource: ResourceMeta, inline: boolean, head: boolean): Promise<void> {
    const data = await app.manager.readContent(resource.id);
    const allowedInline = inline && INLINE_MEDIA.has(resource.mediaType);
    response.writeHead(200, { 'Content-Type': allowedInline ? resource.mediaType : 'application/octet-stream', 'Content-Length': data.length, 'Content-Disposition': `${allowedInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(resource.originalName)}`, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    response.end(head ? undefined : data);
  }
}
