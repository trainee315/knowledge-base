import type { Plugin } from 'vite';
import { realpathSync } from 'node:fs';
import { request as forwardRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serviceOrigin } from '../src/service/client.js';
import { previewJson } from '../src/preview/readonly.js';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.data', import.meta.url));
const REPO_CODEX_DIR = fileURLToPath(new URL('../.codex', import.meta.url));
const DEFAULT_DENY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'];
const PRIVATE_SERVICE_FILES = ['**/.runtime/**', '**/service.sqlite', '**/service.sqlite-*'];
const PASSTHROUGH = ['accept', 'content-type', 'content-length', 'range'] as const;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);
const identity = (path: string) => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
function physicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch { return path; }
}

function proxy(request: IncomingMessage, response: ServerResponse, url: URL, target: string, origin: string): void {
  const upstream = forwardRequest(target + url.pathname + url.search, {
    method: request.method,
    headers: {
      ...Object.fromEntries(PASSTHROUGH.flatMap(name => request.headers[name] === undefined ? [] : [[name, request.headers[name]]])),
      ...(request.headers.origin === origin ? { Origin: target } : {}),
    },
  }, result => {
    const headers = Object.fromEntries(Object.entries(result.headers).filter(([key]) => !HOP_HEADERS.has(key)));
    response.writeHead(result.statusCode ?? 502, headers);
    result.pipe(response);
  });
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else previewJson(response, 503, { ok: false, error: { code: 'SERVICE_OFFLINE', message: '知识库服务不可用，请确认服务运行后重试' } });
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

/** Vite 只提供前端和热更新，业务 API 代理到统一服务。 */
export function knowledgeApiPlugin(options: { dataDir?: string } = {}): Plugin {
  const dataDir = resolve(options.dataDir ?? process.env.KB_DATA_DIR ?? DEFAULT_DATA_DIR);
  const privateRoots = [...new Set([dataDir, DEFAULT_DATA_DIR, REPO_CODEX_DIR].flatMap(path => [path, physicalPath(path)]))];
  let target: string;
  return {
    name: 'knowledge-service-proxy',
    apply: 'serve',
    config(config) {
      const privateDirectories = privateRoots.map(path => path.replaceAll('\\', '/').replace(/[!*+?()[\]{}|]/g, '\\$&') + '/**');
      return { server: { fs: { deny: [...(config.server?.fs?.deny ?? DEFAULT_DENY), '**/.data/**', ...PRIVATE_SERVICE_FILES, ...privateDirectories] } } };
    },
    async configResolved(config) {
      if (config.server.host !== '127.0.0.1') throw new Error('知识库开发服务器只允许绑定 127.0.0.1');
      target = await serviceOrigin(dataDir);
    },
    configureServer(server) {
      if (!server.httpServer) throw new Error('知识库开发服务器需要独立 HTTP 监听');
      const origin = () => {
        const address = server.httpServer?.address();
        return address && typeof address !== 'string' ? 'http://127.0.0.1:' + address.port : '';
      };
      server.middlewares.use((request, response, next) => {
        const currentOrigin = origin();
        const url = new URL(request.url ?? '/', currentOrigin || 'http://127.0.0.1');
        if (url.pathname === '/_control' || url.pathname.startsWith('/_control/')) {
          previewJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '开发服务器不提供控制接口' } });
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          if (!currentOrigin || url.origin !== currentOrigin || request.headers.host !== new URL(currentOrigin).host || request.headers.origin && request.headers.origin !== currentOrigin) {
            previewJson(response, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '仅允许本地同源访问' } });
            return;
          }
          void serviceOrigin(dataDir).then((service) => {
            target = service;
            proxy(request, response, url, target, currentOrigin);
          }).catch(() => {
            previewJson(response, 503, { ok: false, error: { code: 'SERVICE_OFFLINE', message: '知识库服务未运行，请先执行 service start' } });
          });
          return;
        }
        // 按字面路径保护 /@fs 和编码路径，正式数据只经服务 API 暴露。
        let pathname: string;
        try { pathname = decodeURIComponent(url.pathname); }
        catch { previewJson(response, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '无效路径' } }); return; }
        const file = resolve(pathname.startsWith('/@fs/') ? pathname.slice(5) : resolve(server.config.root, '.' + pathname));
        const candidates = [identity(file), identity(physicalPath(file))];
        if (privateRoots.some(root => candidates.some(candidate => candidate === identity(root) || candidate.startsWith(identity(root) + '/')))) {
          previewJson(response, 403, { ok: false, error: { code: 'PRIVATE_DATA', message: '数据文件仅可通过知识库服务访问' } });
          return;
        }
        response.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ${currentOrigin.replace('http:', 'ws:')}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
        next();
      });
      server.httpServer.once('listening', () => {
        server.config.logger.info('\n知识库开发页面 ' + origin() + '\n业务服务 ' + target + '\ndataDir: ' + dataDir);
      });
    },
  };
}
