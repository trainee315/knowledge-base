# v0.0.1 公共契约

本档案记录0.0.1已实现协议。TypeScript权威定义在 [src/contracts/index.ts](../../src/contracts/index.ts)。开发期协作历史保留在 [原始契约](../新增需求/v0.0.1/contracts.md)。

## CLI

`cli.bat <group> <action> [--input UTF8-JSON文件|-] [--data-dir 目录] [--json]`。成功为`{ok:true,data:...}`，失败为`{ok:false,error:{code,message,details?}}`，stdout单对象、日志stderr，退出码0成功/1执行失败/2参数错误。

核心命令组resource、meta、organization、organization-type、plugin、backup、restore、check、reindex、preview；业务组content、keyword、tag、relation、system、task、organize、schedule。业务通过registerCommand注册完整命令名。预览接口只读；结构化示例见 [运行说明](./running.md)。

## 正式数据

资源meta schemaVersion=1。UUID为身份，hash为SHA256，contentVersion为内容输入版本，revision为meta修订。原件位于resources/<扩展名或unknown>/<UUID>.<扩展名>，同级metadata/<UUID>.meta；历史原件位于resources/history。普通导入哈希去重，副本显式创建；内容更新保留身份，回收态可恢复，永久清理受正式引用约束。

meta的plugins[pluginId]={schemaVersion,data}保存插件命名分区；核心保留未知分区，插件只更新自身分区，可校验expectedRevision/expectedContentVersion。references使用resource/organization kind与id，可标owner；插件更新只替换自身owner引用。

organizations/<UUID>.json保存通用type/name/data/references/revision。organization-types/<id>.json保存schemaVersion、id、name、description、handlerPluginId?、config、enabled、revision及时间。register幂等，不覆盖已有配置或换handler；update只修改name/description/config/enabled；disabled阻止新增该type实例，used type删除被拒绝；未知历史type兼容。

正式备份涵盖resources、metadata、organizations、organization-types、plugins/*/data、state；不包含cache、journal、锁、.runtime或密钥。恢复先全量校验规范路径白名单、大小写重复、base64/hash、核心schema、原件与引用，验证前零正式数据写入。未知核心schema拒读写；宿主在load前拒绝未来dataVersion；未知插件分区保留，已知插件自行检查meta兼容性。

## 插件与组织方式

PluginDefinition为静态manifest与load；manifest含id、三段version、apiVersion=1、独立dataVersion、直接dependencies，可声明organizationTypes默认描述。依赖版本支持精确、^、~、*，运行前检查重复、缺失/停用、版本及循环，固定拓扑顺序。

context.core提供受控核心API，context.store仅访问自身data/cache；getDependency只访问声明的直接依赖公开runtime.api。load、migrate、refresh分离；每轮共享依赖仅执行一次，前置失败停止本轮并持久阻断其依赖闭包，重启不load阻断插件，成功refresh后恢复；停用逆序stop并保留数据。

静态默认方式按plugin:type持久初始化marker，仅首次可写载入登记；readOnly零写，显式删除不重建。新算法仍要增代码构建；登记方式不安装代码、不改变插件算法。

这是单人单机、受控管理器的协作式本地插件协议，不是对恶意Node代码或外部进程同时篡改文件系统的沙箱。
