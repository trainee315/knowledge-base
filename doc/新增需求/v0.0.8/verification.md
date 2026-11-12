# v0.0.8 实际验证报告

日期：2026-11-12。状态：候选实现与实测已交付，**已测门槛通过，2026-11-12用户验收通过**。开发负载3%门槛仅在显式 `recall workload` 保护模式下通过；未保护的持续并行仍不达标，不能声称对任意开发负载无影响。

## 实现和工作树

工作树 `C:\Users\mamar\.codex\worktrees\knowledge-base-v008\knowledge-base`，分支 `codex/v0.0.8-recall`，基线 `81387b56fa498c3897763546f0d5e23a99d3ab52`，包含需求 `ebeee44`。未改动主工作树的v0.0.9工作；正式版本保持0.0.5。没有PPC、npm发布、推送或版本归档。

实现入口为 `src/recall/`，接入现有CLI和本地服务。范围身份/元数据缓存、四层路由、固定版本原文片元、FTS5/BM25、独立本机embedding、允许集合内向量排序、RRF、交叉编码重排、任务模板/固定入口、邻接与预算均有执行路径。模型进程结束才释放并发槽位，模型计算不持有正式库写者锁。模型与索引均显式维护，普通读不触发文档编码。

`npm test`完成核心与网页构建，116项测试全部通过；`npm run typecheck`通过。`tests/recall/cli.mjs`实际启动隔离库服务，通过scope/read/index/BM25/list/删除撤回等8项检查；`demo.mjs`已实际运行。测试包含标题歧义、范围交集/路径边界、跨项目Top K、BOM/CRLF/emoji定位、历史原件、删除/恢复、预算、损坏代次恢复及模型清单降级。结构测试不作为模型准确度证明。

## 样本与口径

合成语料31篇：alpha/beta/gamma各10篇，另有1篇未知项目记录；三个项目包含同名模块，内容片元总计91。调优集9问（8有答案、1无答案），冻结验收集13问（12有答案、1无答案），按主题分离。正文及参数见 `tests/recall/fixture.mjs`。语料内容哈希为 `a134357655d19fc30638f7e36f8f5fc8f8bf0a8840f871a70051e5ad9c4bd99d`；实际资源快照及case哈希保存在评价JSON中。

六种模式使用同一资源快照、范围、K=5、12,000字节输出上限。相关性按原文条件片元标注：只命中正确文档的标题不算有效证据；正确资源且包含标注完整条件才计入Recall/MRR。引用另行检查固定version/hash及原文start/end。最初资源级指标保留在 `acceptance-initial-resource-metrics.json`，已由更严格的 `acceptance-models.json`替代，未据验收结果重新调参或放宽门槛。

现有字面基线先测：有答案验收查询命中6/12，构建中位1969ms、核心测试中位3145ms。随后冻结[门槛](thresholds.json)。语义阈值仅用调优集选0.40：正确Top1最低约0.420、无答案最高约0.375。默认片元目标900字符、超长块1400字符，候选20，RRF k=60，BM25标题权重2；默认混合不开重排。调优原始分数见 `tuning-scores.json`。

## 模型与依赖

Node.js 24、TypeScript现有核心，固定新增依赖 `@huggingface/transformers@3.8.1`，其Node执行依赖 `onnxruntime-node@1.21.0`。选择原因是可直接复用Node执行环境，提供独立embedding与成对分类接口，并可配置离线q8/CPU；不依赖本机旧Python环境，不使用文本生成模拟embedding。

- embedding：`Xenova/bge-small-zh-v1.5`，修订 `75c43b069aac4d136ba6bc1122f995fedcfd2781`，512维、CLS/L2、官方中文查询前缀。
- reranker：`Xenova/bge-reranker-base`，修订 `280bcc27a84e0b898c251e06fddb25171bd9b101`，query/document配对logits，不解释为真实性概率。
- q8，输入上限512 tokens，batch=8，ONNX intra/inter线程均为1，全局模型并发1、CPU运行；不代表Node进程只有一个OS线程。无常驻模型，无GPU执行。
- 最终编码身份 `6cf47aee644c477e707d490c24bb21fe16219d01aaa005f8cb4af39b783dce88`；完整文件SHA-256、输入配置见 `latency.json`。早期评测清单的身份为 `93336d…`，最终将既有512上限/维度/编码版本显式纳入身份，模型文件和算法未变，并已重新编码验证。

依据：[Transformers.js Node文档](https://huggingface.co/docs/transformers.js/v3.8.1/en/tutorials/node)、[embedding转换模型](https://huggingface.co/Xenova/bge-small-zh-v1.5)、[原模型说明](https://huggingface.co/BAAI/bge-small-zh-v1.5)、[reranker转换模型](https://huggingface.co/Xenova/bge-reranker-base)、[FTS5](https://www.sqlite.org/fts5.html)。官方资料确认接口与模型用途，质量结论来自下列本机实测。

## 冻结验收集结果

以下顺序均为Recall@5 / MRR / nDCG@5 / 完整条件覆盖率：

- 字面查询：0.500 / 0.250 / 0.315 / 0.500。
- BM25：0.917 / 0.917 / 0.917 / 0.917。
- 纯向量：0.917 / 0.917 / 0.917 / 0.917。
- 混合：1.000 / 0.958 / 0.969 / 1.000。
- 混合＋重排：1.000 / 1.000 / 1.000 / 1.000。
- 完整任务组装：1.000 / 1.000 / 1.000 / 1.000。

六组的范围泄漏、错误原文定位、该无答案样本的误召回均为0；模型路径均实际执行、未用降级结果冒充。样本只有1个验收无答案问题，不能外推通用拒答能力。短合成资料中的条件完整也不证明长session多事务完整性。

## 延迟、索引与用量

最终资源修复后的独立延迟脚本每模式5次，p95在该样本中等于最大值：scope 26ms、read 31ms、list 12ms、BM25 41ms、纯向量401ms、混合381ms、重排2006ms、任务1780ms。混合后四次平均374ms，重排1848ms，任务1770ms。每次模型调用都包含新子进程启动和模型加载；同进程元数据/系统文件页会变热，未清空OS页缓存，不代表机器重启后的磁盘冷启动。

最终资源修复后首次构建1663ms，编码91片元、3442 tokens、3次模型调用；随后增量构建155ms，91缓存命中、0次模型调用。此前对应测量为1589/142ms，保存在 `latency-before-resource-fix.json`；质量评测前构建403ms也为91命中、0次模型调用。包含不同阶段的真实时间，未只挑最快结果。中断恢复测试真实启动重排进程，被开发负载取消并返回DEVELOPMENT_BUSY，之后embedding重试成功。

本机embedding/重排API费用为0，额外摘要/拆解生成tokens为0；模型CPU时间、峰值RSS及可用I/O计数逐次记录。Windows的fsRead/fsWrite为0时不能解释成无磁盘I/O。未换算电力、硬件折旧或开发时间成本。

模型进程峰值RSS为923,291,648字节（约881MiB），小于冻结1.5GiB门槛；这不是整机或父子进程总内存。验证结束后观察到0个模型worker进程，见 `idle-models.json`。

## 真实工作Agent任务

使用现有AgentService与真实 `deepseek-flash`，temperature=0、reasoning=off、单次输出上限768 tokens，最多4轮。Agent自主决定查询及查询词，提交的函数在隔离JS上下文执行断言，并核验所引用resourceId包含所需原文条件。3种任务（连击规则、旧计划/后续决定、无需历史的double函数）×6模式×2重复，共36个执行。初次活动和最终复测均保留，合计72个执行，均为合成任务；没有用模型评分替代函数测试。

最终复测中，字面路径成功且证据正确为2/6，其他各模式为6/6。依赖历史任务的查询中位数从字面3轮降为其他各模式1轮；一次重排任务实际用了2轮，未剔除。无需历史的12次执行均为0次查询。未观测到漏查、相同查询重复或无谓查询。新路径在历史决定任务中均返回最近60帧并通过检查；字面路径的历史任务失败不自动解释成“模型作出错误历史断言”。

每模式6任务的工作Agent输入/输出tokens总计：

- 字面：5809 / 781。
- BM25：5836 / 858。
- 纯向量：13938 / 862。
- 混合：14049 / 847。
- 混合＋重排：19863 / 967。
- 任务组装：9068 / 854。

同期召回用量另计：纯向量4次embedding、165 tokens；混合4次、162 tokens；混合＋重排5次、209 tokens，54对重排、2413 tokens；任务组装4次、164 tokens，42对重排、1842 tokens。字面/BM25不调用召回模型。工作Agent上下文token通常增加，因此不声称总体费用下降。

最终活动68次真实生成请求，缓存命中输入13312 tokens、非命中55251 tokens。按[DeepSeek官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)记录的峰时非缓存输入$0.30/百万、输出$1.20/百万计算，费用上界$0.0267717；这是忽略缓存折扣的估算上界，不是账户账单。初次活动上界$0.0269271，两次合计$0.0536988。完整逐次用量见 `agent-ledger-final.json`，任务结果见 `agent-tasks-final.json`，不包含密钥、原始对话或模型生成的代码。

自动汇总 `summary.json`对已测质量、引用/隔离、Agent任务、延迟、模型RSS及显式保护下的开发负载判通过，measuredGatesPassed=true、userAcceptance=pending。测试规模和保护入口条件仍适用；未保护的并行执行不在通过结论内。

## 开发负载硬门槛

机器：Intel i7-13700、系统报告16逻辑CPU、32GB内存；RTX4060未参与推理。真实负载为TypeScript构建和核心测试，配对交错先后顺序。第一轮每场景5对，不保护时平均退化约6.6%–26.2%，所有场景均未通过；因此改变执行策略，新增显式 `recall workload`让出机制，并保留失败数据。

第一版保护模式先测5对仍有不确定性，再按预先允许的上限扩至每场景20对。以下是保留的修复前结果，单侧95% t上界与冻结3%比较：

- 缓存索引＋构建：均值5.22%，上界9.00%，**失败**。
- 缓存索引＋测试：均值1.04%，上界2.77%，通过。
- 冷编码索引＋构建：均值1.78%，上界2.49%，通过。
- 冷编码索引＋测试：均值1.00%，上界1.73%，通过。
- 查询＋构建：均值1.80%，上界2.40%，通过。
- 查询＋测试：均值1.46%，上界2.28%，通过。

异常/噪声样本全部保留，没有排除后宣布达标。这轮失败促成进一步修复：模型文件改为1MiB分块校验并在块间让出；模型退出后才释放互斥；开发负载租约改为原子发布，Windows删除中的EPERM/EBUSY保守视为忙并在下次重查。普通低优先级、CPU单线程或后台执行均不作为通过依据。

修复后的 `developer-load-guarded-extended-stream-atomic-v2.json`重新测量全部六组，每组20对，无失败/中断；均值 / 单侧95%上界为：

- 缓存索引＋构建：0.096% / 0.680%，通过。
- 缓存索引＋测试：0.511% / 1.297%，通过。
- 冷编码索引＋构建：0.469% / 2.958%，通过，接近3%边界。
- 冷编码索引＋测试：0.666% / 2.099%，通过。
- 查询＋构建：0.788% / 2.410%，通过。
- 查询＋测试：1.010% / 1.886%，通过。

这轮包含约正负20%的配对波动，全部保留。保护入口用推迟/取消召回换取开发优先，不能把“未同时计算”称为免费并行；未包裹的外部构建不受自动保护。模型、质量阈值和3%性能门槛均未调整。

原始失败结果仍保存为 `developer-load.json`、`developer-load-guarded.json`、`developer-load-guarded-extended.json`。中间的stream-check/stream-atomic活动因测试暴露的租约竞态中断或主动停止，保存partial数据和 `performance-interruption.json`，不算通过样本。旧轮次均未与最终轮次混合。此结论只适用于当前机器、样本与显式保护入口，未证明全局无干扰。

## 可重复命令

在独立工作树运行，所有数据由脚本创建于系统临时目录；公开artifact只含合成样本、数值与元数据。不要将实际私人库路径用于这些压力脚本。

```powershell
npm ci
npm run typecheck
npm test
npm run test:recall
npm run demo:recall
```

demo会打印带实际临时路径的服务启动、scope、prepare、read、model prepare、index build、eval和停止命令。按打印命令可直接验收本地CLI。重新运行完整实验会覆盖本地实验结果，需先保留本次artifact目录：

```powershell
node tests/recall/baseline.mjs
node tests/recall/benchmark.mjs --prepare
node tests/recall/evaluate.mjs --models
node tests/recall/evaluate.mjs --models --acceptance
node tests/recall/performance.mjs
node tests/recall/performance.mjs --guarded --extended
node tests/recall/performance.mjs --guarded --extended --variant=stream-atomic-v2
```

真实工作Agent活动需要本机已配置的 `DEEPSEEK_API_KEY`；不要写入仓库。每次活动使用新的campaign名字，既有活动关闭后不能重置预算继续调用。脚本最多120次请求、0.25美元估算上限；本机召回不使用此生成接口。

```powershell
$env:KB_RECALL_AGENT_LIVE='1'
node tests/recall/agent.mjs --live --campaign=another-run
node tests/recall/report.mjs --campaign=another-run
```

`report.mjs`不传campaign时汇总本次 `final` 活动和stream-atomic-v2性能活动；任一已测门槛失败时退出1，通过时退出0。它不是发布脚本，用户验收状态始终独立。

## 未验证边界

尚未验证真实私人session转录的证据丢失、长篇多事务资料、大规模库、其他OS或硬件、机器刚启动的磁盘冷缓存、任意外部开发进程自动让出、长期稳定性。故障覆盖并非所有操作系统故障的穷举；真实模型取消/恢复和派生文件损坏已有验证，但不能推断所有崩溃组合均已测。

范围选择的结构规则已测试；真实Agent任务的项目范围由测试工具固定，因此不证明Agent在自由环境能自主正确选项目。没有为真实生产仓库提交修复，端到端任务仅为实际模型自主查询并编写、执行合成函数测试。2026-11-12用户验收通过，见[独立验收记录](user-acceptance.md)，开发负载保护条件继续有效；不接受该条件时不能引用本报告声称性能验收通过。
