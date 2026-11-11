# 首期预览与 PPC 接入

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

实现日期：2026-11-10。技术与验证细节见 [web/README.md](../../../web/README.md)。

## 临时只读预览

```powershell
./cli.bat preview start --data-dir "D:\资料\知识库 数据" --json
./cli.bat preview status --data-dir "D:\资料\知识库 数据" --json
./cli.bat preview stop --data-dir "D:\资料\知识库 数据" --json
```

正式预览使用构建产物，通过独立隐藏进程只监听 `127.0.0.1`，默认使用系统空闲端口并返回地址，也支持显式 `--port`。页面与只读 API 同源；业务 API 拒绝写入，管理器以 readOnly 打开。同一目录重复启动复用现有服务，随机控制令牌用于明确停止。运行记录位于 `.runtime`，没有持久化业务服务器，不注册系统任务。

页面浏览真实资源和插件数据：分页、文件名/正文/关键词/标签/体系/解析状态组合筛选、匹配原因、内容版本、Markdown、UUID 图片与链接、原件下载、完整 meta、通用组织和体系节点、插件启停及依赖状态。原始 HTML 转义、禁用脚本协议，图片只接受 `kb://resource/<uuid>`。SVG/HTML 原件作为附件下载；待重新提取的内容显示 pending，避免展示旧正文。插件面板随应用构建并按启用状态展示。

组织页同时读取通用组织方式定义，展示名称、描述、处理器、启停及配置，再浏览组织实例和体系节点。HTTP 与浏览器验证包含自行注册的 `review-reading` 方式，证明页面不依赖固定的标签/关键词/体系枚举。

## PPC knowledge 命令组

```powershell
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge resource list --data-dir "D:\资料\知识库 数据" --json
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge preview start --data-dir "D:\资料\知识库 数据" --json
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge preview stop --data-dir "D:\资料\知识库 数据" --json
```

`--knowledge-home <知识库仓库>` 优先于 `PPC_KNOWLEDGE_HOME`，本机默认 `D:/project/knowledge-base`。PPC 使用 `process.execPath` 与 `spawn` 参数数组启动知识库 `dist/cli/main.js`，`shell:false`，继承调用者工作目录。原样透传参数、JSON stdout、stderr 和退出码，不访问 PPC 后端，不改原有 `note` 行为。缺少构建时返回 `KNOWLEDGE_UNAVAILABLE`。PPC 改动仅限 `cli/knowledge.mjs`、`cli/ppc.mjs`、`cli/README.md`、`cli/knowledge.test.mjs`。

## 验证证据

- `npm run build`：核心与 Vue 生产构建通过。
- `node --test dist/preview/*.test.js`：5 项通过，覆盖安全 Markdown、UUID 解析、真实核心/插件 HTTP、查询与解析状态分页、跨源和写入拒绝、危险原件附件下载、旧正文屏蔽、中文空格目录、8 个真实 CLI 进程并发复用、大小写/junction 别名、stale PID 及 worker 崩溃恢复、明确停止。互斥使用与业务 writer 隔离的 OS IPC 命名空间，不根据磁盘 PID 记录抢锁。
- `C:/nvm4w/nodejs/node.exe --test C:/Users/mamar/Desktop/personalProjectCenter/cli/knowledge.test.mjs`：2 项通过，覆盖中文空格和 shell 特殊字符参数、环境变量/显式仓库路径、stdout/stderr/退出码透传、缺失构建错误。
- `npm run test:web`：独立 headless Chrome 使用 33 个真实资源，验证 PPC 导入、人工标签归属、体系编排、分页/无结果/标签与解析状态筛选、Markdown、UUID 图片解码与资源跳转、无法解析二进制、八插件及级联停用、移动布局。测试清理自己的预览进程、Chrome 和临时数据。
- `node artifacts/preview-first-use-probe.mjs`：真实 CLI 与 Chrome 验证数据目录尚不存在时 status/start/status/stop/status，空库 API 和页面正常；目录内仅 `.runtime`，没有创建正式业务资源、组织方式或插件状态。证据为 `artifacts/preview/first-use-result.json` 和 `empty-library.png`。

CUA 浏览器连接与本机 native pipe 当前不可用，真实浏览器验收使用已安装 Chrome 和 `playwright-core` 独立测试进程，不操作用户现有浏览器。

截图位于仓库 `artifacts/preview/`：[Markdown 资源详情](../../../artifacts/preview/resources-markdown.png)、[移动布局](../../../artifacts/preview/resources-mobile.png)、[失效引用诊断](../../../artifacts/preview/broken-reference.png)、[无结果](../../../artifacts/preview/empty-results.png)、[二进制解析状态](../../../artifacts/preview/unsupported-resource.png)、[体系节点](../../../artifacts/preview/organizations.png)、[启用插件](../../../artifacts/preview/plugins-enabled.png)、[停用插件](../../../artifacts/preview/plugins-disabled.png)。结构化记录为 `artifacts/preview/browser-result.json`。

首期页面为只读预览，新增专属插件组件需要重新构建；不提供热加载或远端插件分发。开发可用 Vite 的 `/api` 代理指向按需启动的预览服务，见 web 文档。

插件依赖图在预览进程启动时载入；CLI 调整插件启停后需 stop/start 预览以加载新状态。

## 最终作者交付状态

2026-11-10 完成 UI、临时预览生命周期和 PPC knowledge 转发。最新核心组织方式接口落地后，生产构建、5 项 preview 测试、真实 Chrome 主回归、2 项 PPC 转发测试及首次空目录 CLI/Chrome 探针均通过。主回归包含 33 个真实资源、正文/关键词/标签/体系组合筛选、开发 Vite 代理、失效 UUID 诊断和通用组织方式浏览；8 张主回归截图加 1 张首次空库截图均已生成，测试最终关闭自己的预览、Vite、Chrome 并清理临时数据。交付时进程检查未发现本轮测试残留。

并发/别名缺陷已修：生命周期使用 canonical realpath 和独立的 OS IPC 操作/实例互斥；8 个 CLI 进程全部复用唯一服务，大小写与 junction 路径共用状态，worker 崩溃后可重新启动，不再依赖磁盘 PID 文件抢锁。PPC 未修改现有 note 行为，未启停任何 PPC 服务，未触碰压图业务文件。

追加的[业务插件独立复核](./business-independent-review.md)发现四类问题，作者修复后同一独立脚本 8 场景全部通过断言，四项均关闭。修复前后 JSON 分别保留在 `artifacts/business-review-before-fixes.json` 与 `artifacts/business-review-result.json`；本复核没有改写业务作者文件。任务隔离的扩展处理器约束和预览插件快照需重启的边界均已明确记录。

## 可保留的演示库

```powershell
node examples/create-demo.mjs
```

[演示说明](../../../examples/README.md)和四格式样例随仓库提供。脚本使用真实 `dist/cli/main.js`，每次在系统临时目录创建独立新库，不覆盖现有数据，不删除演示库，默认不启动服务。输出包括数据路径、`demo-manifest.json`、可直接复制到 PowerShell 的预览 start/stop 命令。Markdown 中的 UUID 链接在生成时替换为真实身份，示例保留人工接受、人工拒绝和待判断候选。

2026-11-10 已运行验证，保留的数据目录为 `C:/Users/mamar/AppData/Local/Temp/knowledge-base-demo-rKDlDB/演示知识库`；说明文件位于其上级 `demo-manifest.json`。核心 check 有效，4 个资源、3 个组织，确定标签查询命中 1 项、未知格式 1 项、待判断候选 3 项、已判定候选 2 项；指南 UUID 引用状态为 valid。按脚本输出的原始命令成功启动预览，页面 HTTP 200、资源 API 正常，验证后已明确 stop，演示数据继续保留。结构化结果为 `artifacts/demo-result.json`。系统临时目录可能被操作系统后续清理，长期留存请另做正式备份。
