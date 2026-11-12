# Knowledge Base

当前版本 **v0.0.5**，2026-11-12用户验收通过。新增自由记录、Codex session增量转录、主动执行与周期检查CLI，以及组织实例详情中的可视化配置和草稿预览。[005归档](doc/v0.0.5/readme.md) · [运行说明](doc/v0.0.5/running.md) · [版本历史](doc/version-history.md)。

`note add/list/get` 管理自由记录，`transcript create/list/get/configure/preview/run/tick/records/retry/backfill` 管理会话转录。`node examples/create-records-demo.mjs` 创建独立临时库和合成session，打印可复制验收命令。

保留文件知识库、资源与组织管理、Agent基础设施、项目跟踪和单端口开发预览；Git发布标识v0.0.5。

要求 Node.js 24+、npm。首次运行：

```powershell
npm ci
npm run build
.\cli.bat help --json
.\cli.bat resource import --file "D:\notes\图像压缩.md" --json
.\cli.bat resource list --json
.\cli.bat preview start --json
.\cli.bat preview status --json
.\cli.bat preview stop --json
```

可运行 `node examples/create-demo.mjs` 创建独立的演示库，查看 [演示说明](./examples/README.md)。脚本使用系统临时目录，保留4种格式资源、标签、体系、人工接受/拒绝与待判断候选，并打印预览启动/停止命令；默认不启动服务，不覆盖已有数据。

普通命令执行后退出。预览显式启动独立临时进程，绑定 `127.0.0.1`，默认自动选择端口；`preview start --port 12345` 可固定端口。预览状态存在数据目录 `.runtime`，不属于正式数据。

开发时 `npm ci` 后直接运行 `npm run dev`，无需预先构建或另启 API 服务：Vite 在同一进程的 `http://127.0.0.1:5183` 提供页面、HMR、资源浏览与 Session 实例配置 `/api`。端口占用会明确报错，不自动跳号；可用 `npm run dev -- --port 5184` 显式更换。默认读取本仓绝对路径 `.data`，可先设置 `$env:KB_DATA_DIR = 'D:\临时知识库'` 选择其它库，启动日志显示 URL 与实际 dataDir。目录不存在时显示空库，不创建正式业务数据。开发没有 `/_control` 接口，按 Ctrl+C 停止；CLI `preview start/stop` 仍独立管理构建页面预览。插件启停后需重启开发预览。详见 [页面开发说明](./web/README.md)。

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
.\cli.bat restore --file "D:\backups\knowledge-2026-11-10.backup.json" --data-dir "D:\恢复的数据" --json
```

备份路径位于数据目录外，不覆盖已有备份文件；恢复目标必须没有正式业务数据。正式数据位于 `resources`、同级 `metadata`、`organizations`、`organization-types`、`plugins/*/data`、`state`，缓存和索引位于 `cache`。每个写命令独占数据目录写者锁；只读查询可并行，跨文件事务使用重做日志并在下次写会话打开时恢复。数据目录内部拒绝符号链接/junction，数据根自身的别名按realpath统一身份。数据、密钥、构建产物不跟踪进 Git。

整理默认使用离线词汇相关评分，分数只召回候选，最终标签归属由工作Codex/人工提交。DeepSeek已支持显式generate或agent评分调用，可能产生费用；自动任务默认模型次数预算0。OCR、复杂格式正文解析、向量检索、远程插件和实际操作系统定时任务尚未实现。`schedule configure/get/tick/run`保存夜间策略并响应显式调用；如需定时触发，由外部工具调用schedule tick。默认03:00/Asia/Shanghai、100任务/60秒，费用参数按声明估算，不代表供应商实时账单硬限。

验证使用 `npm test`、`npm run build`、`npm run test:web`；规模基准使用 `node dist/core/benchmark.js`。当前能力见 [运行说明](./doc/v0.0.5/running.md)、[公共契约](./doc/v0.0.5/contracts.md)、[验证与局限](./doc/v0.0.5/verification.md)。[002开发历史](./doc/新增需求/v0.0.2/readme.md)与 [001归档](./doc/v0.0.1/readme.md)保留原始证据；PPC独立转发不依赖PPC后台，跨仓库接入见 [integrations/ppc](./integrations/ppc/README.md)。

005正式版复核通过类型检查、完整构建、93项核心测试、10项独立集成测试，以及资源浏览和实例配置两组Chrome回归。真实模型质量检查包含3段合成样本，后续真实会话转录由用户授权，生产细节保留在本地。摘要语义准确度与历史状态消解边界见[验证归档](./doc/v0.0.5/verification.md)，本次发布复核详见[验证汇总](./artifacts/verification/v0.0.5/release-validation.json)。001至004的原始验证证据保留在各自版本目录。
