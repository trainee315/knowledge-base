# 只读页面与临时预览

生产预览读取真实核心和启用插件的数据，不保存独立业务状态。先在仓库根运行 `npm install`、`npm run build`。

```powershell
./cli.bat preview start --data-dir "D:\资料\知识库 数据" --json
./cli.bat preview status --data-dir "D:\资料\知识库 数据" --json
./cli.bat preview stop --data-dir "D:\资料\知识库 数据" --json
```

`start` 启动隐藏的独立 Node 进程，默认只监听 `127.0.0.1` 的系统空闲端口，返回 URL、端口和 PID。可用 `--port 4174` 指定端口。同一数据目录重复启动返回已有服务；realpath 归一后大小写/junction 别名复用同一实例。独立的 OS IPC 操作锁与实例锁串行化生命周期并保证唯一服务，不依赖可被抢占的 PID 磁盘锁，进程崩溃后 OS 自动释放互斥。`stop` 通过本地随机令牌关闭对应服务，并等待实例互斥释放，不根据记录的 PID 强行终止其它进程。关闭浏览器页签不会停止服务，请使用明确的停止命令。服务状态和控制令牌位于数据目录 `.runtime/`，不进入正式备份。

页面及 `/api/` 共用一个 origin，只允许 GET/HEAD 业务请求。拒绝外部 Host/Origin；控制接口需要启动时生成的令牌。页面提供分页资源查询、匹配原因、解析状态、资源详情和完整 meta、通用组织及体系节点、插件状态。筛选条件间 AND，同一条件逗号分隔的多个值 OR；解析状态在分页前筛选。插件停用后相应筛选和插件面板隐藏或禁用，通用资源查询继续工作。

组织页分别展示组织方式与实例：通用方式的名称、描述、处理器、启停和配置来自 `/api/organization-types`，不需要核心枚举业务类型；组织实例与体系节点仍通过 UUID 连接资源。

首次使用时数据目录可以不存在：`status` 返回未运行且不创建目录，`start` 仅创建空根目录和 `.runtime` 并可打开空库页面，不会初始化正式业务资源、组织方式或插件状态。独立 CLI + Chrome 探针为 `node artifacts/preview-first-use-probe.mjs`，结果见 `artifacts/preview/first-use-result.json` 和 `empty-library.png`。

插件依赖图在预览进程启动时载入；通过 CLI 更改插件启停配置后，停止并重新启动预览以载入新的启用状态。

Markdown 原始 HTML 作为文字显示；脚本协议和任意文件路径不能成为可点击链接。内部链接统一使用 `kb://resource/<uuid>`，图片也通过此协议解析。外链只允许 HTTP(S)，图片仅允许知识库 UUID 引用。核心识别为 PNG/JPEG/GIF 等被动图片格式时可内联，SVG/HTML 等原件始终作为附件下载。内容版本变化而提取尚未完成时展示待解析，不会展示旧版本正文。失效或非法 UUID 引用通过 referenceStatus/diagnostics 显式警示，原始 meta/API 保留机器值。

开发时先按需启动 API 服务，再设置其地址运行 Vite：

```powershell
$env:KB_PREVIEW_API = 'http://127.0.0.1:4174'
npm run dev
```

Vite 通过同源 `/api` 代理转发到该地址；它的代理默认重写上游 Host。正式预览使用 `dist/web`，不依赖 Vite。

`web/src/panels.ts` 提供随构建注册的 `registerPreviewPanel({pluginId,title,component})` 扩展点；自定义 Vue 面板接收 `resource` 和对应插件 meta 的 `data`。只有启用插件且资源有相应分区时展示。未知 meta 分区始终能通过完整元数据浏览。

## 验证

```powershell
npm run build
node --test dist/preview/*.test.js
npm run test:web
C:/nvm4w/nodejs/node.exe --test C:/Users/mamar/Desktop/personalProjectCenter/cli/knowledge.test.mjs
```

浏览器回归使用 `playwright-core` 启动独立 headless Chrome，默认 Chrome 路径为 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可由 `KB_CHROME_PATH` 覆盖。`PPC_CLI_PATH` 可覆盖 PPC 入口，`KB_BROWSER_EVIDENCE` 可覆盖截图输出路径。

回归通过 PPC knowledge 导入 Markdown、TXT、PNG、二进制、创建标签并提交人工归属、编排体系，再通过核心补充到 33 份真实资源。检查开发 Vite 代理、分页、无结果、正文/关键词/标签/体系组合和解析状态筛选、详情、安全 Markdown、UUID 图片解码与重复资源导航、失效引用诊断、无法解析二进制、组织节点、八插件状态、级联停用后的筛选与面板，以及 390px 布局。测试最终停止预览、关闭 Chrome 并清理临时数据。

截图和结构化结果默认生成在 `artifacts/preview/`。2026-11-10 本机 Chrome 回归已通过；`resources-markdown.png`、`resources-mobile.png`、`broken-reference.png`、`empty-results.png`、`unsupported-resource.png`、`organizations.png`、`plugins-enabled.png`、`plugins-disabled.png` 供视觉复核。浏览器连接插件不可用时，此回归仍可运行，不访问用户既有页签。
