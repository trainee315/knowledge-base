# Knowledge Base

由工作Agent通过CLI管理的单人本地文件知识库。当前版本 **v0.0.1**（2026-11-11），已完成自动验证和独立复核，按用户指令归档发布；提供资源入库、文件事务、插件管理、知识整理、持久任务和只读预览。[版本归档](./doc/v0.0.1/readme.md) · [文档入口](./doc/readme.md) · [版本历史](./doc/version-history.md)。

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

普通命令执行后退出。预览显式启动独立临时进程，绑定 `127.0.0.1`，默认自动选择端口；`preview start --port 12345` 可固定端口。开发页面使用 `npm run dev`。预览状态存在数据目录 `.runtime`，不属于正式数据。

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

整理默认使用离线词汇相关评分，分数只召回候选，最终标签归属由工作 Codex/人工提交。付费模型调用、OCR、复杂格式正文解析、向量检索、远程插件和实际操作系统定时任务尚未实现。`schedule configure/get/tick/run` 保存夜间策略并响应显式调用；如需定时触发，由外部工具调用 `schedule tick`。默认夜间配置 03:00、Asia/Shanghai、100 任务、60 秒、付费调用/费用预算均为 0。

验证使用 `npm test`、`npm run build`、`npm run test:web`；规模基准使用 `node dist/core/benchmark.js`。已发布能力见 [安装运行](./doc/v0.0.1/running.md)、[公共契约](./doc/v0.0.1/contracts.md)、[验证与局限](./doc/v0.0.1/verification.md)。[开发历史](./doc/新增需求/v0.0.1/readme.md)保留需求和独立复核证据；PPC独立转发不依赖PPC后台，跨仓库接入见 [integrations/ppc](./integrations/ppc/README.md)。

最终冻结验证：typecheck、构建、34/34测试、真实Chrome与PPC2/2测试全部通过。核心六类、业务四类及预览别名问题经交叉独立复核修复并关闭；完整原始日志保存在 `artifacts/verification`。1000资源最终实测导入21.35秒、全部一致性检查通过，属于本机合成基准。
