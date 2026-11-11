# v0.0.3 项目开发跟踪

2026-11-11：用户已验收v0.0.3，正式包与CLI版本0.0.3；按计划归档发布。此前待验收描述与测试版本号保留为历史记录。归档入口：../../v0.0.3/readme.md。

已按推进至0.0.4的计划复核当前源码，提供[最终验收入口](./acceptance.md)：本轮类型检查、构建、70项回归、9项独立验证、开发预览集成与Chrome回归通过。等待用户验收003后归档发布，再进入004组织文档浏览开发。

状态：已实现并完成自动验证与独立复核，待用户验收。开发分支 `feat/v0.0.3-project-tracking`，包与CLI为 `0.0.3-dev`。已发布当前版本仍为 [v0.0.2](../../v0.0.2/readme.md)，其远端 main/tag 已核验；本轮不提交、推送或自动发布003。

项目以通用组织保存开发过程，条目追加后不可修改：固定资源UUID、contentVersion、原件hash、全文格式及解析器版本，保存关键词与标签快照。旧内容版本没有可信历史标签时记录unknown，不能拿当前标签冒充历史事实。首条目为baseline；replacement只记录替换关系，不自动合并或删改旧条目。

项目视图按数值版本从新到旧排序，同版本再按日期排序，版本优先于日期；支持asOfVersion查看当时累计状态。登记只接受解析成功的MD/TXT/JSON。每次追加保留所有历史条目的正式资源引用，因此已固定的旧原件不会因当前资源更新而漂移，也不能被永久删除。

重复requestId先按用户显式输入fingerprint查询原请求，再解析服务器日期、当前内容版本和标签；重试不会因依赖后来变化而重复追加。查询限于项目条目，全文返回默认limit5、最大20，支持项目筛选，不调用全库organizer或Agent。只读命令不迁移或初始化正式数据，允许与writer并行。

CLI：`project-track create/list/get/add/documents/read/query`。create/add写入；其余只读。具体参数与数据接口见 [契约](./contracts.md)，实现与验证见 [实现记录](./implementation.md)、[执行记录](./execution.md)。所有新验证证据位于 `artifacts/verification/v0.0.3`，历史发布证据冻结。

可运行`node examples/project-tracking/create-demo.mjs`创建保留在系统临时目录的独立演示库；说明见[项目跟踪演示](../../../examples/project-tracking/README.md)。演示以已发布版本事实为baseline，包含快照/版本/替代/幂等与全文读取，默认不启动服务，也不触碰真实资料。

最终证据：集中严格串行typecheck→npm test70/70→build全部成功；独立项目9/9、core反证7组、Chrome10插件/33资源及PPC2/2通过，演示6资源7条目已实际验证。见[总验证JSON](../../../artifacts/verification/v0.0.3/summary.json)、[独立验证记录](./project-tracking-verification.md)。本轮新增真实模型调用0次，002活动账本保持closed/3。

不包含：自动合并需求、自动改写文档、模型推断历史标签、完整项目管理UI、额外付费调用。DeepSeek002验证活动已closed，不再新增真实请求。
