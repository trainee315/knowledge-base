import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openApplication } from '../src/index.js';
import { createReadOnlyHandler, previewJson } from '../src/preview/readonly.js';

// 默认库按仓库定位，不随 npm 启动目录变化；环境变量只选择数据，不初始化业务库。
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.data', import.meta.url));
// 保留 Vite 默认敏感文件拒绝规则，数据目录规则须在 Vite 编译匹配器之前合并。
const DEFAULT_DENY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'];
interface DevApiOptions { dataDir?: string; open?: typeof openApplication }

/** Vite 自己承载只读 API，无代理、子进程或第二个监听端口。 */
export function knowledgeApiPlugin(options: DevApiOptions = {}): Plugin {
  return {
    name: 'knowledge-readonly-api',
    apply: 'serve',
    config(config) {
      const dataDir = resolve(options.dataDir ?? process.env.KB_DATA_DIR ?? DEFAULT_DATA_DIR).replaceAll('\\', '/');
      const literalRoot = dataDir.replace(/[!*+?()[\]{}|]/g, '\\$&');
      return { server: { fs: { deny: [...(config.server?.fs?.deny ?? DEFAULT_DENY), '**/.data/**', '**/.codex/**', `${literalRoot}/**`] } } };
    },
    configResolved(config) {
      if (config.server.host !== '127.0.0.1') throw new Error('知识库开发服务器只允许绑定 127.0.0.1');
    },
    async configureServer(server) {
      if (!server.httpServer) throw new Error('知识库开发服务器需要独立 HTTP 监听');
      const dataDir = resolve(options.dataDir ?? process.env.KB_DATA_DIR ?? DEFAULT_DATA_DIR);
      const app = await (options.open ?? openApplication)(dataDir, { readOnly: true });
      let closing: Promise<void> | undefined;
      const closeApp = () => closing ??= app.close();
      const origin = () => {
        const address = server.httpServer?.address();
        return address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
      };
      const handle = createReadOnlyHandler({ app, getOrigin: origin });
      server.middlewares.use((request, response, next) => {
        void handle(request, response).then((handled) => {
          if (handled) return;
          // 按字面路径再封一次，含URL编码的/@fs请求也不能落入SPA回退或文件转换器。
          const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
          const target = resolve(pathname.startsWith('/@fs/') ? pathname.slice(5) : resolve(server.config.root, '.' + pathname));
          const identity = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
          const candidate = identity(target);
          if ([dataDir, DEFAULT_DATA_DIR].some((root) => candidate === identity(root) || candidate.startsWith(identity(root) + '/'))) {
            previewJson(response, 403, { ok: false, error: { code: 'PRIVATE_DATA', message: '数据文件仅可通过只读资源接口访问' } }); return;
          }
          // Vite 注入开发样式和同端口 HMR；API/附件仍使用共享处理器的严格策略。
          response.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ${origin().replace('http:', 'ws:')}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
          next();
        }).catch(next);
      });
      const originalClose = server.close.bind(server);
      server.close = async () => { try { await originalClose(); } finally { await closeApp(); } };
      const originalListen = server.listen.bind(server);
      server.listen = async (...args) => {
        try { return await originalListen(...args); }
        catch (error) { await closeApp(); throw error; }
      };
      // close 事件也涵盖 Vite 配置重启；应用只释放一次。
      server.httpServer.once('close', () => { void closeApp().catch((error) => server.config.logger.error(String(error))); });
      server.httpServer.once('listening', () => {
        server.config.logger.info(`\n知识库开发预览 ${origin()}\ndataDir: ${dataDir}\n只读模式；插件启停后需重启开发预览。`);
      });
    },
  };
}
