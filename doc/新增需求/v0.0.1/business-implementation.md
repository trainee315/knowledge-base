# 首期业务插件实施与验证

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

2026-11-10 实施。实际 TypeScript 入口为 `src/plugins/<插件标识>/index.ts`；核心组合入口、CLI 和公共契约由核心负责。未创建真实操作系统定时任务，未调用付费模型，未唤起独立 Codex。

## 已实现的职责与依赖

- `content`：无业务依赖。Markdown、TXT、JSON 采用严格 UTF-8 解码；JSON 校验语法。正文状态为 `parsed`、`failed`、`unsupported`，尚未执行时查询显示 `pending`。未知格式及解析失败保留文件名，可继续提取文件名关键词。处理器v2通过markdown-it真实link/image token登记 `kb://resource/<UUID>` 正式引用，代码围栏与行内代码不算链接；资源事件刷新优先登记，避免任务积压期间漏保护。无效目标保留原文并标 `referenceStatus: broken`、列出diagnostics；替换正文只更新 `owner: content` 的引用，保留其它插件引用。
- `keywords` → `content`：NFKC、英文小写、空白归一，使用 `Intl.Segmenter('zh-CN')` 进行中英文词切分、停用词过滤、词频排序，最多保存100个关键词。结果仅保存在资源 meta 的 `plugins.keywords`。
- `tags`：无业务依赖。标签定义、说明和别名通过核心组织 API 保存，名称与别名共享归一化唯一命名空间。接受与拒绝同存 `plugins.tags.decisions`，记录来源、理由、资源内容版本及标签定义版本。`manual` 决定持续有效，Codex/自动提交只返回复核建议，不覆盖人工接受或拒绝。
- `relations` → `keywords`、`tags`：可替换 `ScoringProvider`；随工程提供 `offline-lexical` v1，明确 `kind: heuristic`。名称/别名精确匹配、包含、分词重合、字符二元片段 Dice 相似度产生0..1评分。此实现是离线文本启发式，不代表语义模型质量，也不直接建立标签归属。外部provider返回重复、缺失、越界或非有限分数会被拒绝。调用前捕获provider对象和身份快照，await期间实现改变则丢弃旧结果，不将P1分数标记为P2。
- `systems`：无业务依赖。有序层级节点、父节点、UUID资源引用、循环检测；体系组织的 references 由核心校验。增加节点不改变体系名称，修改资源内容不改变UUID引用。
- `tasks`：无业务依赖。单文件正式队列，输入版本与处理器版本共同去重；持久状态、尝试次数、错误、断点和结果。超时传递 AbortSignal，默认3次尝试、30秒处理器超时。达到单批任务/时间/模型调用/费用预算即停止，保存状态。`task retry` 为显式重置尝试次数；运行时才恢复上次进程的 running 状态，插件加载/只读预览不写队列。超时处理器尚未settle时，隔离新批次执行并拒绝retry，返回 `attempt-draining`/`TASK_DRAINING`，避免同进程旧处理器晚写覆盖重试结果；返回unfinished/draining计数。
- `organizer` → `content`、`keywords`、`tags`、`relations`、`tasks`、`systems`：按资源 `contentVersion`、全部标签UUID与revision指纹、处理链版本排队。处理链版本包括正文、关键词、评分provider身份及版本，因此算法版本变化重新排队。全量版本核对可补漏事件；默认一轮推进20个脚本任务。评分≥0.35仅产生候选，工作Codex读取材料后提交最终判断。相同输入已接受或拒绝不会再次要求判断，人工决定输入变化后仅产生复核候选。
- `scheduler` → `organizer`：默认每天 `03:00`、`Asia/Shanghai`。显式 `tick` 计算到期，只有队列无未完成/失败/未退出处理器时才保存成功日期，重启后同一天成功批次不重复触发。失败、超时、预算耗尽保存lastAttempt与lastAttemptComplete但不标当日成功，同日可续跑。`run` 可主动推进积压；模拟时钟使用ISO时间。默认100个任务、60秒、模型调用与费用预算均0。

核心在执行任何插件入口前收集依赖、检验并拓扑排序；业务不跨插件读取内部文件，不写其它插件的meta分区。`organizer` 通过 `tags.decide` 提交判断。正文、关键词和标签提交都检查资源revision与contentVersion；标签提交另外检查标签revision。旧资源、旧标签定义或旧处理器的候选不能覆盖新数据。

正文、关键词、标签三个已知meta分区明确只支持结构 `schemaVersion: 1`，共同经过 `readPluginMeta` 读取边界；更高或其它版本以 `UNSUPPORTED_PLUGIN_SCHEMA` 拒读拒写，等待显式迁移，不静默降级。content处理器算法v2不表示meta结构v2。未知插件分区继续由核心原样保留，业务不按自己的版本解释它们。

## 正式数据与可重建信息

- 资源meta：`metadata/<uuid>.meta` 的 `plugins.content`、`plugins.keywords`、`plugins.tags`。资源关键词、最终接受和拒绝以此为唯一权威。
- 标签和体系：`organizations/<uuid>.json`；类型分别为 `tag`、`system`。体系节点在 `data.nodes`，通过UUID引用资源。
- 关系评分：`plugins/relations/data/<tag-uuid>.json`，按标签revision/provider版本区分，保存provider身份、kind与每个关键词理由。
- 队列：`plugins/tasks/data/queue.json`；候选：`plugins/organizer/data/candidates.json`；调度：`plugins/scheduler/data/schedule.json`。这些为正式状态，进入核心备份恢复。
- 不保存第二份资源—标签最终归属；索引可由meta与组织重建。插件失效不删除其正式数据。

## 通用组织方式声明与管理

tags、keywords、systems的manifest分别静态声明 `tag/标签`、`keyword/关键词`、`system/体系`，config初始为空。宿主绑定各自handlerPluginId，仅在首次可写初始化时登记，记录初始化marker；业务load不执行每次注册。用户修改名称、config或enabled后重启不覆盖，显式删除后重开和备份恢复均不自动重建。

核心 `organization-type register/list/get/update/enable/disable/delete` 管理通用方式定义；定义保存于 `organization-types/<id>.json`，进入正式备份恢复与check。register对同一处理器幂等保留原记录，修改须用update并可传expectedRevision。已有组织实例的方式禁止删除，需先迁移或清理实例。enabled=false只阻止新增对应type组织，旧实例仍可读取及维护；此属性不等同于停用整个业务插件，关键词提取等算法仍由plugin启停管理。config为该方式的通用配置记录，不宣称任意自定义键会自动改变关键词/评分算法。

独立增量测试 `src/plugins/organization-types.test.ts` 三项全部通过：默认三方式首次登记与所有权、自定义名称/config/disabled跨重启保留；fresh只读不创建数据目录、既有目录全部文件hash不变；删除keyword定义跨重开及恢复不重建；通用CRUD/幂等/版本冲突/使用中阻删/disabled禁新增与旧读维护；类型完整配置及实例备份恢复；独立CLI调用和持writer锁期间只读查询。

```powershell
node --test dist/plugins/organization-types.test.js
```

组织方式增量接入后，2026-11-10 本机 `npm test`（含核心及网页构建）34/34通过。

## CLI 与工作Codex调用

先执行 `npm install`、`npm run build`。统一入口 `cli.bat`，所有示例均可附加 `--data-dir D:\kb-data --json`；PPC只负责转发该CLI。结构化JSON通过 `--input UTF8文件` 或 `--input -` 输入，布尔值、数组和复杂节点建议使用JSON。

```powershell
./cli.bat resource import --file D:\notes\compression.md --data-dir D:\kb-data --json
./cli.bat tag create --name compression --data-dir D:\kb-data --json
./cli.bat organize candidates --data-dir D:\kb-data --json
./cli.bat organize material --id <candidate-id> --data-dir D:\kb-data --json
./cli.bat organize submit --input D:\decision.json --data-dir D:\kb-data --json
./cli.bat organize query --input D:\query.json --data-dir D:\kb-data --json
./cli.bat schedule tick --now 2026-11-10T19:00:00Z --data-dir D:\kb-data --json
```

`decision.json`：

```json
{"candidateId":"候选返回的id","accepted":true,"source":"codex","reason":"已阅读材料，正文讨论PNG压缩及其应用。"}
```

`query.json`：

```json
{"filename":["compression","压缩"],"keywords":["png"],"tags":["图像压缩"],"parseStatus":["parsed"],"offset":0,"limit":50}
```

查询支持 `filename/body/keywords/tags/systems/parseStatus` 数组，条件之间AND、同一数组内OR。关键词使用归一化包含匹配，标签采用名称/别名/UUID确定匹配。返回 `{items:[{resource,reasons,matchReasons,parseStatus}],total,offset,limit}`；筛选先于分页。未知格式可用文件名和关键词检索，正文条件不会命中未解析内容。

其余命令：

- `content get/extract`、`keyword get/extract/list`。
- `tag list/get/create/update/delete/decide/clear`；删除已使用标签前必须显式 `tag clear` 清理关联。拒绝也是正式关联记录，不会被删除标签默默丢弃。
- `relation get/score/providers`；默认provider无网络请求。
- `system list/get/create/update/delete/add-node`；add-node输入为 `{id:体系UUID,node:{title,order,resourceId?,parentId?,id?}}`，update可提交完整nodes列表实现编辑、删除和排序。
- `task list/run/retry`、`organize reconcile/run/candidates/material/submit/query`。
- `schedule get/configure/tick/run`；配置支持enabled/time/timezone及运行预算，tick/run支持now模拟时钟。

资源导入、显式内容更新、新标签和标签定义更新，在核心成功提交后刷新插件、真实排队并推进脚本阶段。核心存储成功与业务任务失败分别记录；失败状态和错误可经task list查看。没有候选仅表示本轮启发式未召回，不表示资源已被Codex完整检查。

## 实测

```powershell
npm run build:core
node --test dist/plugins/business.test.js
node dist/plugins/tasks/benchmark.js
```

2026-11-10 本机 Node 24 验证：业务11项测试全部通过。独立复核发现的超时、调度、provider切换、参数类型及已知meta未来版本覆盖问题已补回归，不只运行旧测试。

1. 严格UTF-8、JSON无效/编码无效、未知格式降级、中英文归一与heuristic评分。
2. 真实核心文件入库到提取/关键词/候选，新标签历史回填；刷新不反馈循环；人工拒绝保护、标签定义变化复核、旧内容候选阻断；有序体系UUID引用；AND/OR与解析状态分页。
3. 多个独立CLI进程，以stdin JSON完成自动链路、Codex提交、别名查询、重复导入；无效JSON入库标failed、仅文件名降级查询标unsupported、失效标签UUID拒绝写入。
4. provider版本变更自动新排队并产出新版本候选，旧处理器候选不能提交。
5. 定时03:00边界、模拟时钟、进程重启后同日不重复，次日可执行。
6. 真实磁盘队列去重、跨进程重启恢复断点、失败重试、超时/尝试上限、调用与费用预算停止、running任务恢复。
7. Markdown链接及图片阻止purge、目标更新仍维持UUID与历史、代码示例不登记、移除解除引用、其它owner不丢、坏目标明确诊断。
8. 故意忽略AbortSignal并延迟写入的处理器：超时及时返回，但未退出前retry/run不允许新attempt；旧处理器退出后新attempt写入最终结果，避免重叠覆盖。
9. 调度失败、TASK_TIMEOUT与预算未完成时均不标当日成功，同日再次tick可继续并完成。
10. 评分await期间切换provider拒绝旧结果；数组元素、布尔值、非法配置、浮点任务预算、负分页参数均明确处理或拒绝，不静默字符串化/忽略。
11. content/keywords/tags已知meta schema99拒读拒写且原样保留，整理任务明确失败不降级；未知插件schema99保留，content算法v2与meta结构v1独立。

1000任务基准入口会建立独立临时目录，经真实受控文件队列逐条入队、分10批执行，中间关闭宿主及核心后重开一次。验证1000完成、尝试次数全部1、无重复执行。首次实测入队9340ms、总计26199ms；最终路径规范化后复测入队9231ms、总计32166ms。处理器为轻量离线函数，不代表1000份资源正文处理速度。核心负责人另行记录1000真实资源导入、分页和重建索引性能。

## 当前实际边界

- 任务和候选采用文件数组，读取入内存后串行更新，适合首期单人单机规模；每次状态写回全队列，1000任务基准可复现其成本。
- Markdown提取保留原文，正文查询包含Markdown语法；不实现OCR、PDF/Office解析、向量或语义检索。
- 模型预算接口已有保存/停止语义，随工程仅提供离线启发式provider；未接入模型价格计费或外部服务密钥。自定义任务需在入队时声明estimatedCalls/estimatedCost，并在处理器中遵循AbortSignal、await全部异步工作。超时保留同进程隔离直到处理器退出；无法强制取消任意用户函数的外部副作用。完全忽略取消且永不退出的处理器会持续阻止新批次，需退出进程后恢复，避免并行重入。默认整理链路不付费调用。
- 未创建真实OS定时任务；CLI tick/run负责显式推进。最终标签判断保留给用户日常工作Codex，夜间只处理脚本任务和关联评分。
- 评分阈值及词表为首期确定实现，不承诺召回全部相关资源；候选材料明确保留解析状态与heuristic来源。
