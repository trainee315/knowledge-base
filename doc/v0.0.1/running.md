# v0.0.1 安装与使用

要求Node.js24+和npm。Windows/Node24为本版本实际验收环境。

```powershell
npm ci
npm run build
.\cli.bat help --json
.\cli.bat resource import --file "D:\notes\示例.md" --json
.\cli.bat resource list --json
```

其它支持Node的平台可直接运行 `node dist/cli/main.js`；OS IPC的Linux路径已实现，但没有将Windows验收扩大为跨平台完整验收。

## 输入与数据目录

所有命令支持 `--data-dir "D:\知识库数据"`，默认本仓库根 `.data`，不受启动工作目录影响。复杂输入用 `--input file.json`，或 `--input -` 读取stdin；顶层必须为JSON对象，显式命令行选项覆盖同名字段。

成功/失败均输出一个JSON对象；日志在stderr。成功退出0、执行失败1、参数错误2。`--json`用于明确结构化调用。CLI完整实现位于 [src/cli/main.ts](../../src/cli/main.ts)。

## 资源、组织与整理

```powershell
.\cli.bat resource import --file "D:\notes\示例.md" --json
.\cli.bat resource update --id UUID --file "D:\notes\更新.md" --expected-content-version 1 --json
.\cli.bat resource history --id UUID --json
.\cli.bat resource get --id UUID --content --version 1 --json
.\cli.bat resource delete --id UUID --json
.\cli.bat resource restore --id UUID --json
.\cli.bat tag create --name "图像压缩" --json
.\cli.bat organize query --input query.json --json
.\cli.bat organize candidates --json
.\cli.bat organize material --id 候选ID --json
.\cli.bat organize submit --input decision.json --json
```

`query.json`示例：`{"filename":["压缩"],"keywords":["纹理","PNG"],"offset":0,"limit":50}`。`decision.json`示例：`{"candidateId":"候选ID","accepted":true,"reason":"阅读材料后的依据","source":"codex"}`。人工来源为manual，已有人工接受/拒绝不会被自动结果覆盖。

重复导入返回未回收的已有资源，`--copy`创建新UUID。`resource purge`只清理已回收且无入站正式引用的资源；更新保留UUID及历史内容。Markdown内部链接/图片使用 `kb://resource/UUID`；content插件登记有效引用，代码示例不登记，坏目标保留诊断及原件。

`organization create/list/get/update/delete`管理通用实例。`organization-type register/list/get/update/enable/disable/delete`管理方式定义，例如：

```powershell
.\cli.bat organization-type register --id reading-list --name "阅读清单" --json
.\cli.bat organization-type update --id reading-list --input type-config.json --json
.\cli.bat organization-type disable --id reading-list --json
```

`type-config.json`可为 `{"config":{"order":"manual"},"description":"人为编排"}`。可用handler-plugin-id绑定已有插件；方式停用阻止新增实例，旧实例仍可维护；使用中的方式须先清理/迁移实例才能删除。方式管理不安装代码，也不等价插件启停。`plugin list/enable/disable/refresh`管理插件，存在依赖方时停用需cascade；失败分支需成功refresh恢复。

## 预览和演示

```powershell
.\cli.bat preview start --json
.\cli.bat preview status --json
.\cli.bat preview stop --json
node examples/create-demo.mjs
```

预览监听127.0.0.1，默认自动分配端口，start可传port；正式预览使用dist/web，开发使用npm run dev。插件状态为启动时快照，启停后stop/start加载新状态。演示脚本在系统临时目录创建并保留独立样例库，默认不启动服务、不覆盖现有数据，打印实际预览命令，详见 [examples](../../examples/README.md)。

## 维护与备份

```powershell
.\cli.bat check --json
.\cli.bat reindex --json
.\cli.bat backup --file "D:\backups\knowledge.backup.json" --json
.\cli.bat restore --file "D:\backups\knowledge.backup.json" --data-dir "D:\恢复的数据" --json
.\cli.bat schedule get --json
.\cli.bat schedule tick --json
```

备份置于数据目录外且不覆盖已有文件，恢复要求目标无正式业务数据。正式目录为resources、metadata、organizations、organization-types、plugins/*/data、state；cache可重建，.runtime仅预览状态。数据根可用合法alias，内部symlink/junction不允许。若写入失败，关闭并重新打开写会话以恢复journal。

夜间策略默认03:00/Asia/Shanghai、100任务/60秒，模型次数/费用预算0。显式tick仅在到期时推进，同日未完成可继续；实际系统定时触发和工作Agent唤起由后续集成决定。本版本没有注册真实系统任务。

PPC独立转发通过固定入口 `C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge ...`，不依赖PPC后台。跨仓库接入说明及可分发材料见 [integrations/ppc](../../integrations/ppc/README.md)；开发历史证据见 [预览/PPC记录](../新增需求/v0.0.1/preview-ppc.md)。外部PPC仓库未在本次提交推送，其原有工作区改动保留。
