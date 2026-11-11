# 首期核心独立复核

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

复核日期：2026-11-10。范围：`src/core/**`、`src/contracts`、`src/cli`，以及这些公开接口对应的备份恢复、依赖生命周期、正式引用、单写者和读取一致性。复核未修改核心作者源文件或测试；所有反例仅使用新建临时目录，未使用用户数据。

结论：独立反证共发现六类核心问题（刷新失败问题包括重启初始化消费子问题），已由核心作者修复，原反例逐项复验关闭。另发现的业务已知meta版本覆盖问题在业务范围修复；Markdown引用登记由content插件补齐。初轮 `npm test` 28/28通过，组织方式CRUD增量独立验收后完整回归34/34通过。

## 覆盖依据

按 `codebase-memory` 技能先执行 `list_projects`，返回5个项目且无当前仓库；`check_index_coverage(project='D:/project/knowledge-base', paths=[本次核心、契约、CLI和测试], scopes=[src/core,src/contracts,src/cli])` 明确返回未索引。没有用图中缺失作为无问题依据，随后完整读取相应源码和原有 `core.test.ts`、`cli.test.ts`，对关键边界另写独立脚本反证。

复现脚本位于本机临时目录：

```text
C:/Users/mamar/AppData/Local/Temp/kb-core-independent-b8e17d6d-be18-427d-ab3e-a823f61a4b0d/
  repro.mjs                  修复前最初四个反例
  lock-processes.mjs         新IPC锁的真实多进程复验
  retest.mjs                 schema/恢复/刷新/owner的修复后复验
  boundaries.mjs             journal间隙/真实junction/依赖生命周期反证
  business-schema-before.mjs 已知业务分区未来版本修复前反例
```

脚本从仓库工作目录导入当前 `dist`，先 `npm run build:core`。旧 `repro.mjs` 的unlink锁实验仅适用于修复前实现；新实现不再依赖unlink抢占，锁验证已替换为 `lock-processes.mjs`，不应对新实现等待旧unlink hook。

## 发现与修复复验

### 1. P1：过期磁盘锁抢占可产生两个写者，已关闭

原位置：`src/core/storage.ts` 的 `FileStorage.init`，原EEXIST分支在确认旧PID退出后直接 `unlink(lock)` 并重新init，未确认unlink时仍是原来的锁。

反例：临时目录预置失效PID2147483647的锁，两实例均读取旧锁；延迟第二次unlink，等第一个实例已建立新锁后放行。两个init均成功，两次transaction也均成功，破坏单写者约束。

修复：作者采用OS持有的独占IPC身份；Windows命名管道由数据目录realpath及大小写归一后hash确定，磁盘锁仅用于诊断。进程退出由OS释放互斥，不再尝试删除别人的新锁。

独立复验：8个真实Node子进程同时竞争，结果1个获取、7个 `WRITER_LOCKED`；相同目录junction别名及全大写路径均拒绝第二写者；SIGKILL持锁进程后新进程可立即打开，旧诊断lock不阻塞。持锁期间另一个CLI的只读 `organize query` exit0，lock内容不变，原空目录仍仅有诊断lock，未生成正式插件状态。

### 2. P1：备份相对路径规范化后可覆盖活锁，已关闭

原位置：`src/core/manager.ts` 的 `restore` 路径预检，只检查原始字符串以正式目录名开头及词法resolve仍在root内。

反例：合法SHA256及base64条目使用 `file: resources/../.writer.lock`。恢复返回成功，当前writer token被覆盖，close不能清掉错误token的锁。

修复：新增 `src/core/schema.ts::validateFormalPath`，要求路径原样规范、无反斜杠/冒号/点段/隐藏段、符合正式文件白名单；全部条目及规范身份重复检查均在journal之前完成。

独立复验：同条目返回 `INVALID_BACKUP_PATH`，metadata写入数0；坏hash返回 `INVALID_BACKUP`，写入数0。Windows大小写/非法路径变体同样在写前拒绝。

### 3. P1：未来核心schema可恢复并被旧代码写回，已关闭

原位置：`src/core/manager.ts::allMetas/getOrganization/restore/updatePluginMeta`；恢复仅检查备份外层schema及内容hash，读取缺少核心数据schema校验。

反例：从合法备份修改resource meta的schemaVersion为999，重新计算合法hash。restore返回files4；getResource返回schema999；updatePluginMeta仍写成功且保留999，只有事后check报告不合法。

修复：通用资源/组织schema验证用于读、写及恢复预检，恢复另外检验原件/历史hash及size、资源与组织引用和原件覆盖；不认识的核心schema拒读拒写。

独立复验：未来meta备份返回 `UNSUPPORTED_SCHEMA` 且metadata写入数0；磁盘上已有schema999的meta也以同码拒读。未知插件分区 `schemaVersion:99` 和嵌套JSON在合法核心schema中成功备份恢复且原样保留，核心未加入业务schema判断。

### 4. P1：刷新失败后依赖方仍可消费部分状态，已关闭

原位置：`src/core/plugins.ts::refresh/execute/start/getDependency`。原实现虽不再调用后续refresh，但宿主仍active，API和命令仍可使用；重启start还会直接清除失败。

反例：alpha将公开值从1改为2后抛错，beta尚未刷新，但 `beta consume` 返回 `{upstream:2,dependent:1}`。初次修复命令后，重启beta.load仍会读取失败alpha的值2，属于初始化阶段的同一漏洞。

修复：失败插件及依赖闭包的命令/API被阻断，失败状态持久保存，ready=false；重启不load受阻插件。显式refresh按拓扑先恢复依赖，再加载和更新依赖方，成功后解除阻断；API生命周期以租约限制，不能通过保留旧API绕过。

独立复验：失败后的命令、缓存API、跨重启命令均返回 `PLUGIN_BLOCKED`，alpha/beta均ready=false。重启未调用beta.load，消费记录由修复前 `[1,2]` 变为 `[1,3]`：3只在成功retry后依赖更新完成时被读取。成功refresh后命令正常恢复。

### 5. P2：组织补丁可夹带owner伪造，已关闭

原位置：`src/core/manager.ts::updateOrganization` 的 `Object.assign(organization, patch)`，宿主只在调用前检查旧owner。

反例：alpha调用自己的组织更新，额外夹带 `{pluginId:'other'}`。类型声明以外的运行时键被原样赋值，正式组织最终归属other，绕过create时的owner伪造检查。

修复：核心逐个赋值允许的name/data/references，身份、类型、schema、owner不从补丁复制。

独立复验：相同额外补丁执行后正式组织仍为alpha；原有跨插件组织修改/删除及meta分区冒写测试继续通过。

### 6. P1：恢复经过内部Windows junction写出数据根目录，已关闭

位置：`src/core/storage.ts::resolve/atomic` 与 `manager.restore` 的路径使用。词法路径白名单不能识别现有目录重解析点。

反例：目标正式数据为空，但其中 `resources` 为指向同级outside空目录的Windows junction。恢复一份正常完整备份返回files4，原件实际写到dataDir之外 `outside/txt/<uuid>.txt`。无需恶意备份条目，也无需管理员权限。

修复：作者在存储层统一添加 `assertSafePath`：检查现存祖先的lstat，拒绝内部symlink/junction，校验根目录身份；事务所有路径在journal之前检查，atomic创建目录后及rename前重验，读取/枚举同样走受控边界。数据根目录自身的合法alias仍按realpath使用。

独立复验：原 `boundaries.mjs` 返回 `UNSAFE_PATH: 数据目录内部不允许符号链接或junction`，`wroteOutside:false`。正常引用、备份恢复、只读与全部回归仍通过。

## 其它已核验行为

- meta位于 `metadata/<uuid>.meta`，与resources目录同级，不混放原件目录。
- 重复内容返回原UUID；显式copy新UUID；内容更新保留UUID及旧原件历史；资源软删除仍保留引用，带引用purge被阻止。content真实Markdown链接/图片通过正式references登记，移除仅替换自己的owner引用。
- 缺失依赖在任何load前拒绝，独立计数为load0。共享依赖load和refresh各一次；真实trace为shared.refresh、left.refresh、right.refresh，stop为right、left、shared。
- 正常journal失败注入后毒化当前写者，重新打开完成redo且无残缺正式数据。另手动延迟第二个文件b.json的rename，制造a新/b旧的真实中间态；readonly snapshot在120ms观察期内不返回，放行后返回 `[1,1]`，未返回混合版本。
- 核心只负责通用资源/组织/meta及插件管理。首期所有业务插件停用时核心CRUD仍可用；未知分区及停用插件正式数据保留。
- CLI只读查询使用readOnly宿主且不刷新任务。持有活跃writer期间独立CLI仍可查询，队列及正式状态不因查询变化。

业务已知future meta版本问题也已闭环：独立修复前脚本证实content/keywords/tags各自schema99被extract/decide降为1并丢futureField；随后业务统一readPluginMeta边界以 `UNSUPPORTED_PLUGIN_SCHEMA` 拒读拒写。正式回归确认三个已知分区99原样保留，organize任务明确失败不覆盖；未知插件分区99继续正常保留。content算法processorVersion2与meta结构schemaVersion1明确分离，不用manifest版本猜测meta兼容性。该问题在业务作者范围修复，核心仍不解释业务schema。

## 最终验证与边界

```powershell
npm test
node "$env:TEMP/kb-core-independent-b8e17d6d-be18-427d-ab3e-a823f61a4b0d/lock-processes.mjs"
node "$env:TEMP/kb-core-independent-b8e17d6d-be18-427d-ab3e-a823f61a4b0d/retest.mjs"
node "$env:TEMP/kb-core-independent-b8e17d6d-be18-427d-ab3e-a823f61a4b0d/boundaries.mjs"
```

初轮本机 `npm test` 28项全部通过，其中包括核心作者根据本次反例新增的多进程锁、schema/恢复、失败生命周期、owner及junction回归；独立脚本额外验证相同问题的实际前后行为。

## 组织方式CRUD增量独立验收

原需求的通用组织方式管理补齐后，业务负责人只修改自己范围的三个manifest静态声明，并新增独立测试 `src/plugins/organization-types.test.ts`，未改核心作者实现。CoreApi的OrganizationType方法与 `organization-type` CLI均经真实临时文件数据验证，三项独立测试全部通过，未发现新增缺陷。

- generic register/get/list/update/delete：稳定id、name/description/config、enabled、revision；register幂等不覆盖，修改使用update，旧expectedRevision冲突明确拒绝。
- 方式被组织实例使用时delete拒绝；enabled=false阻止新增实例，但旧实例仍可get/list/update/delete，允许有控制地清理后删除方式。
- tags/keywords/systems静态默认方式只在首次可写启动时登记，handlerPluginId分别为tags/keywords/systems。自定义名称、config、停用状态不被下次初始化覆盖；显式删除keyword后可写重开也不重建。
- fresh只读启动没有创建data目录；已有数据只读启动前后整棵目录文件hash完全相同；活跃writer期间独立CLI组织方式list成功且未写正式状态。
- 备份包含organization-types正式定义，恢复保留config/disabled/revision及旧组织实例；默认方式删除marker同样恢复，因此恢复后的可写宿主不会补回已删除方式。
- 独立CLI进程完成register/get/list/update/delete；禁用默认tag后，业务tag create被拒绝，旧tag get可用，使用中的tag方式删除被阻止。

边界按核心与主负责人确认：组织方式enabled控制新增对应type的组织实例，不等价于插件停用；关键词meta提取仍由plugin生命周期控制。未登记的历史/通用组织type保持兼容，不因引入registry自动登记；本轮未扩展这一既定行为。

```powershell
npm run build:core
node --test dist/plugins/organization-types.test.js
npm test
```

增量实际结果：独立3/3通过；完整 `npm test` 已包含core和web构建，34/34通过。随后遵循源码冻结停止新源码修改和全局构建，集中最终检查由核心负责人顺序执行。

本次运行环境为Windows、Node24、临时文件持久化与真实子进程。进程终止、可控文件写入失败和读写交错已验证；未进行物理掉电、磁盘硬件故障或第三方文件系统测试。首期保护边界仍是单人单机、管理器独占写入；本报告不将这些用例扩大为任意外部进程同时篡改文件系统的安全证明。
