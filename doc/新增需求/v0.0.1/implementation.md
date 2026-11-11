# v0.0.1 实施与验收

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

实施日期：2026-11-10。状态：功能已实现、交叉独立复核问题已关闭、源码冻结后的最终验证通过，待用户验收；不表示发布。技术环境Node24.11.0/npm11.6.1，测试使用node:test；最终准确结果与原始日志见 [execution.md](./execution.md)。

## 最终架构

CLI/预览复用 `openApplication`，内部由 CoreManager 与 PluginHost 组成。核心只解释资源、通用 JSON meta、通用组织、引用、事务与插件，不理解任何标签/关键词/内容插件的数据 schema。核心基础查询提供文件名匹配；业务组合查询由 organizer 实现。页面使用 Vue 3/TypeScript/Vite，普通 CSS，Markdown 渲染禁用 HTML。

核心文件：`src/contracts/index.ts` 公共接口、`src/core/manager.ts` 正式数据入口、`storage.ts` 持久化、`plugins.ts` 宿主、`src/cli/main.ts` CLI。业务插件八个：content、keywords、tags、relations、tasks、systems、organizer、scheduler。预览和页面分别位于 `src/preview`、`web`。

资源 UUID 为稳定身份，原件按扩展名存于 `resources/<ext>/<uuid>.<ext>`，扩展名缺失或不安全时归 unknown。`metadata/<uuid>.meta` 与 resources 同级，JSON schemaVersion=1。SHA256 去重默认只在未回收资源中返回已有身份，显式副本不去重。内容更新保留 UUID，递增 contentVersion 并将旧原件放 history。revision 在任何 meta 更新后递增，写插件结果可校验 revision/contentVersion。软删除保留文件与引用，purge 必须先回收并通过入站引用检查。

组织统一身份、type、name、data、references、revision，可扩展任意类型。资源 references 带可选 owner，插件更新只替换自己的引用集合。插件只能通过宿主上下文更新自身 meta 与自己拥有的组织，不能伪造组织 pluginId；组织更新仅白名单修改 name/data/references，额外字段不能篡改身份/归属/schema。未知插件分区和停用插件数据原样保留。内部预览链接采用 `kb://resource/<uuid>`；content 插件解析有效 Markdown link/image 并登记 owner=content 的正式引用，移除后只解除自己的引用，代码示例忽略。失效 URI/UUID 保存 broken 诊断，资源原件保留。

组织方式定义独立保存 `organization-types/<id>.json`。`organization-type register/list/get/update/enable/disable/delete` 对应通用CoreApi，可登记generic或绑定已有静态插件handler，保存name/description/config/enabled/revision。停用阻止新增该type组织，旧实例仍可读取维护；仍有实例时delete拒绝，须先清理/迁移。未知历史type兼容。PluginManifest.organizationTypes声明默认描述，首次可写初始化登记并保存marker；只读load零写，显式delete不因下次load或备份恢复重建。tags/keywords/systems通过同一声明登记tag/keyword/system，核心无业务枚举；方式启停不等于插件停用。

写者独占由 OS IPC 名称保证：Windows 命名管道、Linux abstract socket；名称取数据根 realpath（Windows归一大小写）SHA256。OS 在进程退出时释放互斥，`.writer.lock` PID/token 只作诊断，不通过删除失效文件抢锁，避免双写竞态。每个多文件事务先将完整重做 journal 持久化，再按临时文件+sync+rename 顺序写各文件，最后更新 generation 并移除 journal。下次写会话启动会重做未完成 journal；幂等恢复不依赖索引。Windows 下目标被读取句柄短暂占用时，原子 rename 有界重试。写失败后当前 manager 阻止继续写，要求重新打开恢复。只读操作比较 journal 与 generation，在事务期间重试，避免读取混合版本。该协议验证的是进程中断恢复，尚未开展断电/磁盘故障测试。其他平台使用普通 IPC socket，崩溃残留 socket 采取保守拒绝，尚未验收自动恢复。

正式数据目录为resources、metadata、organizations、organization-types、plugins/*/data、state，备份采用SHA256+JSON/base64；cache、锁、journal、预览进程状态不备份。恢复要求空正式数据目录，日志前全量校验规范路径/白名单/大小写碰撞、base64/哈希、核心meta/组织/方式schema、引用与原件一致性。包含点段、反斜线、保留路径、未知核心schema或内部symlink/junction时零正式数据写入即拒绝。正式读写同样检查祖先与根身份。未知插件分区原样保留；已知content/keywords/tags由各插件拒绝未来meta覆盖；宿主在任何load前拒绝高于manifest的持久dataVersion，不隐式降级或激活依赖方。索引可删除后重建。

宿主在运行插件代码前预检重复标识、API版本、缺失/停用依赖、语义版本与循环路径，稳定拓扑排序。共享依赖单次处理，load/migrate/refresh 均按依赖优先；失败停止本轮，不声称已提交前置数据自动回滚。失败插件及依赖方命令和缓存API均阻断，状态持久保存；重启跳过这些插件的load，避免加载阶段消费部分结果。显式 `plugin refresh` 才按拓扑重新加载/刷新恢复，成功后解除阻断，核心 CRUD 仍可用。数据版本与插件代码/API版本独立，migrate 可升级插件数据。停用逆拓扑 stop，依赖方存在时需 cascade，保存正式数据。跨插件公开能力只能通过 getDependency 访问声明的直接依赖。此为协作式本地插件权限边界，不是对任意恶意 Node 代码的沙箱。

## 验收映射与证据

冻结后严格串行typecheck、npm test、npm build均exit0；**34/34测试通过**，包含14核心、1CLI、11业务、3独立组织方式、5预览。真实Chrome test:web通过（33资源/8插件/8截图），PPC测试2/2通过。Vite32模块、JS183.79kB/gzip74.82kB；原始日志位于artifacts/verification。

1. 多格式导入、UUID、类型目录、meta、重复/显式副本、历史原件、稳定身份：core.test 与 business.test。
2. 资源/meta/组织CRUD、独立组织方式CRUD/配置/启停/使用中保护、插件启停、CLI JSON/UTF8/退出码：core.test、cli.test、organization-types.test及业务独立CLI。方式delete未用plugin disable替代；PPC另见专属文档。
3. 内容解析、关键词、评分召回、工作 Codex 提交：business.test 实际导入→候选→提交；评分使用离线 provider，未验证付费/外部模型。
4. 持久任务、重试/断点、超时、预算、相同输入去重、处理器变化重排：business.test。夜间仅模拟时钟与显式 tick，无真实系统任务。
5. Markdown/资源链接/组织预览、请求写入拒绝、本地跨域限制、后台生命周期：preview 的 markdown/server 测试；真实浏览器证据由 UI 专属记录补充。
6. 关闭后仍保存文件、重启恢复：core 多文件失败注入和业务队列重新打开验证。
7. 人为指导体系、标签别名冲突、查询条件 AND/OR 和解析状态：business.test。
8. 人工拒绝保护、过期内容/标签/处理器结果阻断：business.test。
9. 删除恢复、引用阻止清理、未知分区保留：core.test。
10. 多文件写入第一步后失败注入，重新打开恢复原件+meta+事件，check通过；30轮真实并行读写验证不返回混合a/b值：core.test。
11. 备份恢复原件/历史/meta/组织、删除cache后重建、非法备份路径/哈希拒绝：core.test。
12. DAG循环完整路径、缺失/停用/版本依赖预检，共享依赖去重，前置刷新失败阻断依赖方、逆序stop、组织/meta权限隔离：core.test。
13. 关闭全部业务插件后资源/meta/任意类型组织 CRUD 仍可用，停用插件正式数据仍保留：core.test。

独立核心六类问题已关闭：失效锁竞争、恢复路径、未来核心schema、失败刷新/重启消费、owner注入、内部junction越界。业务四类（调度失败记成功、超时重试重叠、provider竞态、非法参数）及已知future meta覆盖已关闭。预览alias重复worker通过realpath+operation/instance IPC修复。见 [核心复核](./core-independent-review.md)、[业务复核](./business-independent-review.md)、[预览/PPC复核](./preview-ppc-independent-review.md)，均由非作者使用真实临时数据反例复验。

最后安全检查稳定后复跑 `node dist/core/benchmark.js`：1000真实原件完整事务，导入21346.48ms、热分页offset900/limit50为9.11ms、reindex13.55ms、check909.83ms、冷只读分页147.25ms，1000全部valid=true。逐祖先安全检查增加I/O成本，此值替代早期10.86秒实测。既有任务基准1000任务/10批/1重启/全完成/重复0，入队9231ms/总32166ms，早于最终安全祖先检查与方式补齐；保留为当时恢复/性能证据，不冒充最终性能。见 [执行日志](./execution.md)与 [业务记录](./business-implementation.md)，均非生产质量承诺。

## 尚未支持与边界

不包含 OCR、PDF/Office 正文解析、向量索引、付费模型远程执行、独立 Codex 运行时、远程插件分发和热加载。v0.0.1 仅初始化 schemaVersion=1，尚无旧版核心 meta 的实际迁移样本。关系评分可替换 provider 代码接口已实现，默认离线词汇相关分数不表示语义理解质量。预览只读，恢复要求空目标，不提供覆盖合并。单机单写者协议不用于网络共享盘/多主写入。未进行断电、磁盘满、损坏文件自动修复和长期压力测试。所有正式发布及 PPC 打包均未执行。
