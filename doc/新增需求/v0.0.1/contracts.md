# v0.0.1 实施契约

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

2026-11-10 起实施，公共 TypeScript 权威定义在 `src/contracts/index.ts`。Node 24、TS、Vue 3、Vite、npm。接口需要调整时由核心负责人维护，业务与 UI 负责人先发消息协调，避免各自修改公共契约。

## 目录与所有权

- 核心：package/lock/tsconfig、src/core、src/contracts、src/cli、src/plugins/index.ts、src/index.ts、cli.bat。
- 业务：src/plugins 下各插件目录（组合入口除外）。
- UI/预览/PPC：web、src/preview、src/integrations，UI 负责人维护。
- 依赖统一由核心负责人安装。业务插件使用 Node 内置能力；UI 使用 Vue/Vite。

## CLI

`cli.bat <命令> [子命令] [--input UTF8-JSON文件|-] [--data-dir 目录] [--json]`。
默认数据目录仓库根 `.data`。`--input -` 读 stdin；JSON 必须是对象；也支持 `--key value` 参数。`--json` stdout 恰好一个 `{ok:true,data:...}` 或 `{ok:false,error:{code,message,details?}}`；诊断写 stderr。退出码成功 0、运行失败 1、参数错误 2；执行失败（含版本冲突/数据校验）1。

核心命令：resource import/list/get/update/delete/restore/purge/history、meta get/set、organization create/list/get/update/delete、plugin list/enable/disable/refresh、backup、restore、check、reindex。业务命令用插件 registerCommand 注册完整命令名，如 `keyword extract`。预览命令交 UI 负责人提供处理器挂接。

组织方式命令：`organization-type register/list/get/update/enable/disable/delete`，对应CoreApi的list/get/register/update/deleteOrganizationType。定义保存 `organization-types/<id>.json`，含schemaVersion/id/name/description/handlerPluginId?/config/enabled/revision/时间。register幂等但不得把已有定义绑定到不同handler；update只修改name/description/config/enabled。disabled拒绝新增该type组织但不影响旧实例读取维护；仍有organization.type引用时delete拒绝。未知历史type继续兼容。方式定义生命周期不等同插件启停，也不动态安装算法。

## 核心数据

资源 UUID，SHA256 哈希去重；显式 copy 创建副本；update 保留 UUID、旧原件及历史版本。resources/<扩展名或unknown>/<uuid>.<ext> 与 resources 同级的 metadata/<uuid>.meta。meta schemaVersion=1，revision 防并发覆盖，contentVersion 识别内容输入。未知插件分区原样保留。组织保存在 organizations/<uuid>.json，统一 references 校验资源/组织引用；资源软删除不破坏引用，彻底删除被引用对象被阻止。内部 Markdown 引用采用 `kb://resource/<uuid>`。

正式数据：resources、metadata、organizations、organization-types、plugins/<id>/data、state；缓存：cache；操作 journal、锁不属正式数据。写入进程持有按realpath标识的OS IPC单写者互斥，磁盘锁仅作诊断，多文件变更先持久化 journal 后按计划原子替换，启动恢复；一致读取通过状态快照版本及活跃 journal 重试保证。备份仅正式数据，可恢复至空数据目录，写前全量校验规范路径白名单、哈希、核心schema及引用完整性；未知核心schema拒读写，未知插件分区保留。

## 插件

`PluginDefinition` 静态 manifest 显式声明直接 dependencies，apiVersion=1，语义版本支持精确、^、~、*。宿主预检重复/缺失/停用/版本/循环，再稳定拓扑排序；load/migrate/refresh 顺序均依赖优先。任一失败停止整轮，后续插件不运行，保留已提交数据。停用先检查依赖或显式 cascade，按逆拓扑 stop，保留全部数据。

context.core 提供共用资源组织 API；context.store 仅访问自身插件数据；getDependency 只能读取已声明直接依赖 API，禁止跨插件读文件。`registerCommand` 完整名字不可冲突。插件 API 通过 runtime.api 暴露；migrate 与 refresh 分离。各插件 dataVersion 独立，meta 扩展放 plugins[pluginId]={schemaVersion,data}，通过 updatePluginMeta 受控更新。

业务实现采用 id：content、keywords、tags、relations、tasks、organizer、scheduler、systems；具体依赖由业务负责人声明，组合入口静态汇总。无真实付费模型调用或操作系统定时任务。正式数据插件不因停用删除。组织 type 由插件自由定义。

PluginManifest.organizationTypes静态声明默认描述；宿主按plugin:type持久初始化marker，仅首次可写载入时通用register，readOnly零写。用户显式删除定义后marker保留，不会下次load重建。新增handler代码仍随工程构建；业务tags/keywords/systems分别声明tag/keyword/system，核心没有业务枚举。
