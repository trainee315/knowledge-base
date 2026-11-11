# v0.0.2 关系评分业务接入记录

状态：已实现并通过本版本统一自动验证与独立复核，等待用户验收；未提交或推送。本文仅记录0.0.2，不改写0.0.1发布档案。

## 分层与调用

保留tags和keywords互不依赖；relations显式依赖tags、keywords、agent。通用agent提供文本/结构化生成和供应商transport，relations维护评分prompt、JSON Schema、完整词对覆盖和0..1语义校验。业务通过 `getDependency<AgentApi>('agent').generateObject` 调用，不读取agent内部文件、不接触真实密钥，也不包含DeepSeek请求DTO。

默认mode为offline，仍使用原offline-lexical v1；选择agent必须显式配置mode及profile，不因load、readonly查询或普通配置读取自动联网。agent失败不静默回退启发式算法。仅依赖通用JSON生成，未增加自主工具循环或独立Agent运行时。

实际入口：`src/plugins/relations/index.ts`、`agent-scorer.ts`、`cache.ts`；通用agent契约见同目录 [contracts.md](./contracts.md)。

## 词对覆盖与评分版本

正式scope按tag UUID、显式scoringLogicVersion及provider生成语义身份确定，内部关键词先NFKC/大小写/空白归一并去重。生成语义包括provider id/version、请求model、temperature/maxTokens/reasoning的configurationHash、业务prompt版本及输出schema版本。profile名称/revision、timeout、credentialEnv、密钥和密钥指纹不进入scope；maxBatchSize只决定缺失词如何分批，不使既有评分失效。

调用评分器之前先排除已覆盖关键词，只向provider发送missing词。每标签串行读取最新scope并提交，重叠请求不会把同版本已覆盖词重复发送；不同scope写同一个标签文件也不会相互覆盖。相同资源、不同资源、词表扩充、新标签回填均复用该词对覆盖；新词和新tag是新词对，需要评分。删除资源或关键词不自动删除历史评分覆盖。

按用户确认规则：标签定义修改不自动使已覆盖词对失效。每个coverage记录当时tagRevision、标签输入hash、时间及可选profile追踪信息；返回warnings提示“标签定义已变化，可显式升级scoringLogicVersion”。新词按当前定义评分，旧词沿用原评分版本。明确提升逻辑版本后使用新scope重评。候选/最终资源归属仍使用当前tagRevision检查，人工接受/拒绝仍在tags meta，绝不与词对评分复用混淆。

默认不保存或返回0分数值。正式 `scores` 只保留大于0的项，独立 `coverage` 表示已经评分，包括已评0分的关键词；因此不存在把“无记录”同时解释成“未评分”和“已评0分”的歧义。候选仍按原阈值召回，评分不直接确立资源标签归属。

## 完整提交与迁移

每次score请求的所有missing批次先完成、校验，再一次写入正式记录。缺项、重复、越界、空白/非法JSON、截断、transport失败、取消，以及请求期间标签/评分语义变化，都不提交这一轮新增coverage或修改旧有效scope。profile采用请求快照，不按响应actualModel别名误判缓存失效。

relations manifest dataVersion升级为2，正式文件仍为 `plugins/relations/data/<tagUUID>.json`，内部schemaVersion=2并保留多个scope。0.0.1无schemaVersion的记录迁移时：

- 保留provider id/version/kind、标签输入revision和评分时间；归一化关键词。
- 已存0分转为coverage，删除0分数值；只保留正分数。
- 原offline-lexical v1规则未改变，迁入逻辑版本1可直接复用；其它旧provider规则不可证明与新规则一致，保存在 `legacy-v0.0.1` scope，不冒充新agent/profile/业务版本。
- 归一化后同词分数冲突的旧项不标为已覆盖，留下迁移诊断，后续明确重新评分。
- 全量验证迁移输入后再写；未来记录schemaVersion或宿主dataVersion拒绝，不降级覆盖。已有meta/人工归属不迁移到另一份权威记录。

readonly读取可以返回兼容视图但不落盘迁移；正式迁移只发生在可写宿主迁移阶段或显式评分提交。备份恢复原样包含scope和coverage。

## 任务和收费边界

organizer在本地提取关键词后排任务，用relations.plan只读预估missing批次数。通用tasks增加可选prepare：预算检查前仅本地核对输入/动态预估，不能请求模型或写业务结果；已覆盖任务估0、过期输入标obsolete，无模型调用。收费任务预算不足时继续检查后方零费用任务，不造成队首阻塞。prepare耗时后再次检查批次时间，不能在预算已经到期后派发处理器。尝试次数耗尽的旧scope仍可通过本地prepare标obsolete清理；仍有效的exhausted任务或其prepare失败不派发、不增加attempt或请求，避免突破重试限制，也避免旧过期失败永久阻塞调度完成。

默认organize/schedule的maxCalls=0会阻止所有missing模型请求；缓存命中仍可用0调用推进。显式允许请求后，任务按全部missing批次保守预留次数，失败请求也计尝试；保留原断点、超时隔离及重试约束。relations.score另接受maxRequests硬上限，CLI参数为maxCalls，防止处理器运行期间批量配置变化突破预留次数。预算不足时整项任务可留待更大预算的后续批次。

maxCalls/maxRequests是请求次数限制。maxCost仍按任务声明的estimatedCost预留，本版没有实时模型价格计量或美元扣费结算，不能把estimatedCost=0解释为请求免费或承诺货币硬上限。没有隐藏自动重试；失败/取消或进程在响应后、正式提交前退出时，未保存coverage的词对后续重试可能再次计费，不承诺供应商侧exactly-once。

## 公共业务接口与CLI

relations API保留score/get/setProvider/provider，新增getConfig/configure/plan。setProvider仍可注入本地模拟评分器；agent测试通过通用AgentProvider/factory注入，不改业务文件。

```powershell
# 先使用agent profile set配置非秘密profile；密钥只通过仓库外环境引用提供。
./cli.bat relation get-config --json
./cli.bat relation configure --input relation-config.json --json
./cli.bat relation score --input relation-score.json --json
./cli.bat relation get --id <tagUUID> --json
```

`relation-config.json`示例：

```json
{"mode":"agent","agentProfile":"deepseek-default","scoringLogicVersion":"1","maxBatchSize":32}
```

`relation-score.json`示例：

```json
{"id":"标签UUID","keywords":["knowledge","unrelated-marker"],"maxCalls":1}
```

返回scores仅正分、coverage含本次请求词的已评分状态，stats含requested/missing/reused/requests，warnings列出标签定义变化提示。再次同词且同scope请求可传maxCalls=0并得到requests=0。省略keywords时使用关键词插件当前词表。配置拒绝未知字段，不接受apiKey/token等秘密。

## 验证

本业务作者的全部单元/集成测试使用fake transport，未读取密钥或发真实DeepSeek请求。

```powershell
npm run build:core
node --test dist/plugins/relations/relations.test.js dist/plugins/tasks/prepare.test.js
npm test
```

本地新增专项6/6通过，既有业务与方式14/14通过；首次完整0.0.2回归59/59通过（含核心/web构建和独立agent HTTP测试）。之后只做评分字段白名单、prepare数组拒绝和exhausted旧scope淘汰的小收紧，重新构建并专项6/6通过。冻结后核心负责人统一串行typecheck、完整npm test与build均通过，最终59/59；独立负责人13项HTTP/mock集成也通过。生产源码已冻结，公共最终证据由主执行记录统一保存。

覆盖：同词/0分复用、新词补齐、重叠并发去重、标签定义改动保留旧revision并提示、显式逻辑版本/provider/model/生成参数失效、非生成参数不失效、全部错误/取消/多批半成品不落覆盖、默认模型预算0、动态缓存估0、manual不变、v001迁移/future拒绝、备份恢复、prepare时间与公平性。

真实API调用只由独立验证负责人集中执行。本业务收到其结果：关系首批2合成词仅1次HTTP，第二次归一化同词、maxCalls0为0网络；其通用文本/JSON与关系累计真实3次后停止，未超过总5次上限。原始证据和完整独立结论由 [agent-verification.md](./agent-verification.md) 维护。
