# 本地页面与临时预览

生产预览读取真实核心和启用插件的数据，不保存独立业务状态。先在仓库根运行 `npm install`、`npm run build`。

```powershell
./cli.bat preview start --data-dir "D:\资料\知识库 数据" --json
./cli.bat preview status --data-dir "D:\资料\知识库 数据" --json
./cli.bat preview stop --data-dir "D:\资料\知识库 数据" --json
```

`start` 启动隐藏的独立 Node 进程，默认只监听 `127.0.0.1` 的系统空闲端口，返回 URL、端口和 PID。可用 `--port 4174` 指定端口。同一数据目录重复启动返回已有服务；realpath 归一后大小写/junction 别名复用同一实例。独立的 OS IPC 操作锁与实例锁串行化生命周期并保证唯一服务，不依赖可被抢占的 PID 磁盘锁，进程崩溃后 OS 自动释放互斥。`stop` 通过本地随机令牌关闭对应服务，并等待实例互斥释放，不根据记录的 PID 强行终止其它进程。关闭浏览器页签不会停止服务，请使用明确的停止命令。服务状态和控制令牌位于数据目录 `.runtime/`，不进入正式备份。

页面及 `/api/` 共用一个 origin。资源浏览使用 GET/HEAD，Session 实例配置通过专用 POST/PATCH 接口保存。拒绝外部 Host/Origin；控制接口需要启动时生成的令牌。页面提供分页资源查询、匹配原因、解析状态、资源详情和完整 meta、通用组织及体系节点、插件状态。筛选条件间 AND，同一条件逗号分隔的多个值 OR；解析状态在分页前筛选。插件停用后相应筛选和插件面板隐藏或禁用，通用资源查询继续工作。

组织页分别展示组织方式与实例：通用方式的名称、描述、处理器、启停和配置来自 `/api/organization-types`，不需要核心枚举业务类型；组织实例与体系节点仍通过 UUID 连接资源。

首次使用时数据目录可以不存在：`status` 返回未运行且不创建目录，`start` 仅创建空根目录和 `.runtime` 并可打开空库页面，不会初始化正式业务资源、组织方式或插件状态。独立 CLI + Chrome 探针为 `node artifacts/preview-first-use-probe.mjs`，结果见 `artifacts/preview/first-use-result.json` 和 `empty-library.png`。

插件依赖图在预览进程启动时载入；通过 CLI 更改插件启停配置后，停止并重新启动预览以载入新的启用状态。

Markdown 原始 HTML 作为文字显示；脚本协议和任意文件路径不能成为可点击链接。内部链接统一使用 `kb://resource/<uuid>`，图片也通过此协议解析。外链只允许 HTTP(S)，图片仅允许知识库 UUID 引用。核心识别为 PNG/JPEG/GIF 等被动图片格式时可内联，SVG/HTML 等原件始终作为附件下载。内容版本变化而提取尚未完成时展示待解析，不会展示旧版本正文。失效或非法 UUID 引用通过 referenceStatus/diagnostics 显式警示，原始 meta/API 保留机器值。

开发时安装依赖后直接启动一个 Vite 进程，无需先 build 或启动 CLI 预览：

```powershell
npm run dev
# 可选：显式选择库或端口
$env:KB_DATA_DIR = 'D:\临时知识库'
npm run dev -- --port 5184
```

默认 `http://127.0.0.1:5183`，strictPort 固定端口；占用时报错，不自动换号。Vite 在同一进程、同一监听端口直接运行共享浏览与实例配置 API，源码由配置加载器构建，不依赖预先编译的 dist，也不使用 KB_PREVIEW_API 或4174代理。默认 dataDir 为本仓绝对路径 `.data`，启动日志同时显示 URL 与 dataDir；KB_DATA_DIR 可选其它库。首次目录不存在时显示空库，不创建目录或初始化业务数据。按 Ctrl+C 停止，插件启停后需重启；开发不暴露 `/_control`，监听失败和关闭均释放只读应用。

开发 Host/Origin 严格同源。Session 配置 POST/PATCH 使用 application/json 和修订号校验，其余浏览接口使用 GET/HEAD。原件只通过 `/api/resources/<uuid>/file` 下载，Vite 的静态文件范围限制在页面、依赖和共享 Markdown 渲染器，数据目录禁止直接文件访问。开发样式/HMR 所需策略仅用于页面，原件的附件/sandbox 限制不变。正式预览使用 `dist/web`，仍由 CLI 独立启动/停止、动态选端口和令牌控制，不依赖 Vite。

`web/src/panels.ts` 提供随构建注册的 `registerPreviewPanel({pluginId,title,component})` 扩展点；自定义 Vue 面板接收 `resource` 和对应插件 meta 的 `data`。只有启用插件且资源有相应分区时展示。未知 meta 分区始终能通过完整元数据浏览。

## 验证

```powershell
npm run build
node --test dist/preview/*.test.js
node --test web/tests/dev.integration.mjs
npm run test:web
```

浏览器回归使用 `playwright-core` 启动独立 headless Chrome，默认 Chrome 路径为 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可由 `KB_CHROME_PATH` 覆盖。默认通过本仓 CLI 创建临时数据，不调用外部 PPC；显式设置 `KB_BROWSER_USE_PPC=1` 可恢复 PPC knowledge 转发回归，`PPC_CLI_PATH` 可覆盖其入口。`KB_BROWSER_EVIDENCE` 可覆盖截图输出路径，版本验证请显式选择对应新证据目录。

回归导入 Markdown、TXT、PNG、二进制、创建标签并提交人工归属、编排体系，再通过核心补充到 33 份真实资源。先验证独立 Vite 单端口页面/API，不为开发启动第二个 API 服务，再检验 CLI 构建页面预览：分页、无结果、正文/关键词/标签/体系组合和解析状态筛选、详情、安全 Markdown、UUID 图片解码与重复资源导航、失效引用诊断、无法解析二进制、组织节点、当前全部插件状态、级联停用后的筛选与面板，以及 390px 布局。测试最终停止自己创建的预览、关闭 Chrome 并清理临时数据；不操作用户现有服务。

截图和结构化结果默认生成在 `artifacts/preview/`。2026-11-10 本机 Chrome 回归已通过；`resources-markdown.png`、`resources-mobile.png`、`broken-reference.png`、`empty-results.png`、`unsupported-resource.png`、`organizations.png`、`plugins-enabled.png`、`plugins-disabled.png` 供视觉复核。浏览器连接插件不可用时，此回归仍可运行，不访问用户既有页签。

## v0.0.4组织阅读

组织与体系页签按方式、条目、关联文档、正文浏览；标签可多选任意/全部，关键词按完整归一化词组选取，体系支持目录递归汇总，项目记录读取固定历史版本。普通页30/最大200，项目页20；URL的#browse参数恢复选择与阅读。新增GET /api/browse/collections、/api/browse/documents与/api/project-tracking/:projectId/entries/:entryId；列表不返回全文。真实资料验收脚本web/tests/organization-browser.mjs需显式KB_BROWSER_DATA_DIR，全程只读。

## v0.0.5 实例配置

组织与体系中选择 Session 转录，在实例列表新建实例或查看详情。概览、关联记录、实例配置三个页签支持 URL 恢复。表单可保存、取消及预览草稿，profile 显示模型与凭证可用性。冲突时保留草稿，刷新修订后合并其他字段。

配置接口由开发和构建预览共用，短写会话复用CLI验证和事务。读取、配置保存及草稿预览的模型调用次数为零。补充验收见 doc/新增需求/v0.0.5/acceptance.md。
