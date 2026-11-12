# Knowledge Base

[v0.0.12 候选](doc/新增需求/v0.0.12/readme.md)：Agent 接入服务器 Codex CLI 订阅登录，支持模型配置及 Session 选择；独立分支待验收。

v0.0.11 待验证版本提供语义关键词与标签：页面新增标签后后台自动匹配，支持增量更新、失败重试及原文片元浏览。[使用与契约](doc/新增需求/v0.0.11/contracts.md) · [验证记录](doc/新增需求/v0.0.11/verification.md)。

[v0.0.10候选实现](doc/新增需求/v0.0.10/readme.md)：已修复Session压缩与向量片元召回链路，补齐CLI帮助、范围与完成状态、固定版本续读及项目Agent提示词。[验证报告](doc/新增需求/v0.0.10/verification.md) · `npm run demo:agent` 生成隔离接入实例。待用户验收，未正式发布。

开发路线：[项目架构原则](doc/architecture-principles.md) · [v0.0.6 本地服务与 cron](doc/新增需求/v0.0.6/readme.md) · [v0.0.7 插件详情](doc/新增需求/v0.0.7/readme.md) · [v0.0.8 Agent召回候选](doc/新增需求/v0.0.8/readme.md)。下方命令用于当前主分支，发布版本的命令见相应归档。

v0.0.8 独立候选提供本地 `recall` CLI；`npm run demo:recall` 创建合成演示库并打印完整验收命令。[Agent说明](doc/新增需求/v0.0.8/agent-guide.md) · [实测报告与适用限制](doc/新增需求/v0.0.8/verification.md)。已测门槛通过，其中开发负载结论限定为显式 `recall workload` 保护模式；2026-11-12用户验收通过，未正式发布。

最近已发布版本 **v0.0.5**，2026-11-12用户验收通过。新增自由记录、Codex session增量转录、主动执行与周期检查CLI，以及组织实例详情中的可视化配置和草稿预览。[005归档](doc/v0.0.5/readme.md) · [运行说明](doc/v0.0.5/running.md) · [版本历史](doc/version-history.md)。

`note add/list/get` 管理自由记录，`transcript create/list/get/configure/preview/run/tick/records/retry/backfill` 管理会话转录。`node examples/create-records-demo.mjs` 创建独立临时库和合成session，打印可复制验收命令。

v0.0.9转录输入预处理与压缩模式页面配置于2026-11-12用户验收通过，支持off/conservative/aggressive及全模式载荷路径替换。页面入口为插件→project-tracking→配置，按Session实例保存。[需求、契约与验证记录](doc/新增需求/v0.0.9/readme.md)

要求 Node.js 24+、npm。首次运行：

```powershell
npm ci
npm run build
.\cli.bat help --json
.\cli.bat service start --json
.\cli.bat resource import --file "D:\notes\图像压缩.md" --json
.\cli.bat resource list --json
.\cli.bat service status --json
.\cli.bat service stop --json
```

可运行 `node examples/create-demo.mjs` 创建独立的演示库。脚本在系统临时目录生成并保留样例库，结束时停止为该库启动的服务，打印下次启动和停止的命令。[演示说明](./examples/README.md)

业务命令连接同一数据目录的服务后执行。服务绑定 `127.0.0.1`，默认自动选端口，可用 `service start --port 12345` 固定端口。状态与控制信息位于数据目录 `.runtime`。打开启动结果中的 URL 使用网页。`preview start/status/stop` 兼容旧入口，`preview stop` 同时停止该库的服务与调度。

开发时先构建并启动服务，再运行 `npm run dev`。Vite 在 `http://127.0.0.1:5183` 提供页面和热更新，并代理 `/api/` 到同一数据目录的服务。开发端口可用 `npm run dev -- --port 5184` 指定；使用其他库时，让 `KB_DATA_DIR` 与启动服务的 `--data-dir` 指向同一路径。停止 Vite 后，使用 `service stop` 单独停止服务。[页面开发说明](./web/README.md)

所有命令支持 `--data-dir "D:\知识库数据"`，默认位置是本仓库 `.data`，与启动时工作目录无关。所有成功与失败均输出单个 JSON 对象，日志写 stderr；退出码成功 0，执行失败 1，参数错误 2。`--json` 明确声明结构化调用意图，输出保持一致。复杂参数放 UTF8 JSON 文件或用 `--input -` 读取 stdin，命令行参数覆盖同名输入字段。

标签创建和查询：

```powershell
.\cli.bat tag create --name "图像压缩" --json
.\cli.bat organize query --input .\query.json --json
.\cli.bat organize candidates --json
.\cli.bat organize material --id "候选ID" --json
.\cli.bat organize submit --input .\decision.json --json
```

`query.json` 示例：`{"filename":["压缩"],"keywords":["纹理","PNG"],"offset":0,"limit":50}`。每类条件内取并集，文件名/正文/关键词/标签/体系等不同条件取交集。`decision.json` 使用 `{"candidateId":"候选ID","accepted":true,"reason":"阅读材料后的依据","source":"codex"}`；人工来源 `manual` 的既有决定受到保护。

内容更新使用 `resource update --id UUID --file 新文件 --expected-content-version 1`；保留 UUID 和历史原件。`resource history --id UUID` 查看历史，`resource get --id UUID --content --version 1` 读取旧正文。重复导入默认返回现有资源，`--copy` 创建独立副本。删除使用 `resource delete`，恢复使用 `resource restore`，显式 `resource purge` 仅清理已回收且没有入站引用的资源。Markdown 内部引用使用 `kb://resource/UUID`。

`organization create/list/get/update/delete` 管理任意类型的通用组织，`system` 插件管理有人为指导和排序的体系。`meta get/set` 管理资源插件分区；未知或停用插件分区保留。`plugin list/enable/disable/refresh` 管理内置插件，停用存在依赖的插件需 `--cascade`；重新启用须先启用其依赖。新组织算法或新插件需要新增代码并构建。

组织方式定义独立管理：`organization-type register --id reading-list --name "阅读清单"` 登记通用方式；`list/get/update/enable/disable/delete` 管理描述、配置和状态，可用 `--handler-plugin-id` 绑定已有插件处理器。停用只阻止新增该类型组织，旧组织仍可读和维护；删除使用中的方式会失败，须先清理或迁移其组织实例。默认标签/关键词/体系定义只在首次可写初始化登记一次，显式删除后不会在下次load悄悄重建。方式定义与插件启停互相独立，方式登记不安装代码。

备份与维护：

```powershell
.\cli.bat check --json
.\cli.bat reindex --json
.\cli.bat backup --file "D:\backups\knowledge-2026-11-10.backup.json" --json
.\cli.bat service start --data-dir "D:\恢复的数据" --json
.\cli.bat restore --file "D:\backups\knowledge-2026-11-10.backup.json" --data-dir "D:\恢复的数据" --json
.\cli.bat service stop --data-dir "D:\恢复的数据" --json
```

备份路径位于数据目录外，恢复目标须为空库。备份包含正式文件和 SQLite 服务与调度状态。恢复后的计划默认停用。正式业务文件位于 `resources`、同级 `metadata`、`organizations`、`organization-types`、`plugins/*/data` 和 `state`。写会话使用数据目录写者锁，跨文件事务使用重做日志恢复。数据目录内部拒绝符号链接和 junction，数据根的别名按实际路径统一识别。

整理默认使用离线词汇相关评分，最终标签归属由工作 Codex 或人工提交。DeepSeek 的显式生成与 Agent 评分可能产生费用，自动任务默认模型次数预算为 0。cron 由本地服务运行，支持五字段表达式及分钟间隔。旧 `schedule configure/get/tick/run` 及转录周期入口由服务适配；启用的计划在服务运行时触发。[调度契约](doc/新增需求/v0.0.6/contracts.md)

验证使用 `npm test`、`npm run build`、`npm run test:web`；规模基准使用 `node dist/core/benchmark.js`。0.0.5 归档见 [运行说明](./doc/v0.0.5/running.md)、[公共契约](./doc/v0.0.5/contracts.md)、[验证与局限](./doc/v0.0.5/verification.md)。[002开发历史](./doc/新增需求/v0.0.2/readme.md)与 [001归档](./doc/v0.0.1/readme.md)保留原始证据；PPC独立转发不依赖PPC后台，跨仓库接入见 [integrations/ppc](./integrations/ppc/README.md)。

005正式版复核通过类型检查、完整构建、93项核心测试、10项独立集成测试，以及资源浏览和实例配置两组Chrome回归。真实模型质量检查包含3段合成样本，后续真实会话转录由用户授权，生产细节保留在本地。摘要语义准确度与历史状态消解边界见[验证归档](./doc/v0.0.5/verification.md)，本次发布复核详见[验证汇总](./artifacts/verification/v0.0.5/release-validation.json)。001至004的原始验证证据保留在各自版本目录。
