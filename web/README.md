# 本地页面与开发代理

当前开发分支的构建页面由本地应用服务承载。先在仓库根运行 `npm ci`、`npm run build`。

```powershell
./cli.bat service start --data-dir "D:\资料\知识库 数据" --json
./cli.bat service status --data-dir "D:\资料\知识库 数据" --json
./cli.bat service stop --data-dir "D:\资料\知识库 数据" --json
```

`start` 启动隐藏的独立 Node 进程，监听 `127.0.0.1`，返回网页 URL、端口和 PID。可用 `--port 4174` 指定端口。同一数据目录重复启动返回已有服务，实际路径相同的别名复用同一实例。操作锁与实例锁由 OS 维护。`stop` 请求服务排空在途工作后停止，服务状态和控制令牌位于数据目录 `.runtime/`。`preview start/status/stop` 兼容旧入口并操作同一服务。

页面及 `/api/` 共用一个 origin。资源浏览使用 GET/HEAD，Session 实例配置通过专用 POST/PATCH 接口保存。拒绝外部 Host/Origin；控制接口需要启动时生成的令牌。页面提供分页资源查询、匹配原因、解析状态、资源详情和完整 meta、通用组织及体系节点、插件状态。筛选条件间 AND，同一条件逗号分隔的多个值 OR；解析状态在分页前筛选。插件停用后相应筛选和插件面板隐藏或禁用，通用资源查询继续工作。

组织页分别展示组织方式与实例：通用方式的名称、描述、处理器、启停和配置来自 `/api/organization-types`，不需要核心枚举业务类型；组织实例与体系节点仍通过 UUID 连接资源。

`status` 可查询尚未创建的数据目录。`start` 会准备服务与 SQLite 所需目录，空库可直接浏览。通过 CLI 修改插件启停后，刷新页面查看状态。

Markdown 原始 HTML 作为文字显示；脚本协议和任意文件路径不能成为可点击链接。内部链接统一使用 `kb://resource/<uuid>`，图片也通过此协议解析。外链只允许 HTTP(S)，图片仅允许知识库 UUID 引用。核心识别为 PNG/JPEG/GIF 等被动图片格式时可内联，SVG/HTML 等原件始终作为附件下载。内容版本变化而提取尚未完成时展示待解析，不会展示旧版本正文。失效或非法 UUID 引用通过 referenceStatus/diagnostics 显式警示，原始 meta/API 保留机器值。

开发时先启动同一数据目录的应用服务，再运行 Vite。

```powershell
$env:KB_DATA_DIR = 'D:\临时知识库'
./cli.bat service start --data-dir "$env:KB_DATA_DIR" --json
npm run dev -- --port 5184
```

默认页面地址为 `http://127.0.0.1:5183`。Vite 端口占用时报错；通过 `--port` 选择其他端口。Vite 提供源码和 HMR，将 `/api/` 代理到同一数据目录的服务。默认数据目录为仓库下的 `.data`，`KB_DATA_DIR` 可选择其他库。Vite 停止后服务仍运行，使用 `service stop` 停止。

开发代理校验 Host 和 Origin。Session 配置 POST/PATCH 使用 application/json 和修订号校验。原件只通过 `/api/resources/<uuid>/file` 下载，Vite 的静态文件范围限制在页面、依赖和共享 Markdown 渲染器。开发端只代理浏览器 API，服务控制与命令执行走独立入口。

`web/src/panels.ts` 提供随构建注册的 `registerPreviewPanel({pluginId,title,component})` 扩展点；自定义 Vue 面板接收 `resource` 和对应插件 meta 的 `data`。只有启用插件且资源有相应分区时展示。未知 meta 分区始终能通过完整元数据浏览。

## 验证

```powershell
npm run build
node --test dist/preview/*.test.js
node --test web/tests/dev.integration.mjs
npm run test:web
node web/tests/transcript-configuration.mjs
```

浏览器回归使用 `playwright-core` 启动独立 headless Chrome，默认 Chrome 路径为 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可由 `KB_CHROME_PATH` 覆盖。默认通过本仓 CLI 创建临时数据，不调用外部 PPC；显式设置 `KB_BROWSER_USE_PPC=1` 可恢复 PPC knowledge 转发回归，`PPC_CLI_PATH` 可覆盖其入口。`KB_BROWSER_EVIDENCE` 可覆盖截图输出路径，版本验证请显式选择对应新证据目录。

回归在临时库导入 Markdown、TXT、PNG 和二进制样例，验证 Vite 与构建页面连接同一服务。覆盖分页、组合筛选、UUID 链接与图片、Markdown 安全、组织节点、插件状态及 390px 布局。Session 配置脚本另验网页与 CLI 互通、并发冲突和草稿预览，使用合成模型输出。测试结束后关闭其临时服务和浏览器。

截图和结构化结果默认保存在脚本打印的临时证据目录，可分别用 `KB_BROWSER_EVIDENCE` 和 `KB_TRANSCRIPT_BROWSER_EVIDENCE` 指定路径。

## v0.0.4组织阅读

组织与体系页签按方式、条目、关联文档、正文浏览；标签可多选任意/全部，关键词按完整归一化词组选取，体系支持目录递归汇总，项目记录读取固定历史版本。普通页30/最大200，项目页20；URL的#browse参数恢复选择与阅读。新增GET /api/browse/collections、/api/browse/documents与/api/project-tracking/:projectId/entries/:entryId；列表不返回全文。真实资料验收脚本web/tests/organization-browser.mjs需显式KB_BROWSER_DATA_DIR，全程只读。

## v0.0.5 实例配置

组织与体系中选择 Session 转录，在实例列表新建实例或查看详情。概览、关联记录、实例配置三个页签支持 URL 恢复。表单可保存、取消及预览草稿，profile 显示模型与凭证可用性。冲突时保留草稿，刷新修订后合并其他字段。

配置接口由开发和构建预览共用，短写会话复用CLI验证和事务。读取、配置保存及草稿预览的模型调用次数为零。补充验收见 doc/新增需求/v0.0.5/acceptance.md。

## 组织入口调整

组织方式选择器撤下“项目开发状态跟踪”，项目记录入口统一使用Session转录。旧的project-development-tracking页面链接进入Session转录列表，并清除原条目定位和筛选参数。历史条目仍可通过project-track命令和固定原文读取接口回查。需求及验收见[v0.0.5补充需求](../doc/新增需求/v0.0.5/organization-browser-followup.md)。
