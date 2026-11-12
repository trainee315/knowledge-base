# v0.0.9 aggressive补充验证

后续[页面配置补充](visual-compression.md)已完成，插件→project-tracking→配置可按Session实例选择模式。本文保留此前真实对照的结果和CLI验收记录。

2026-11-12完成实现、同源DeepSeek对照与回归，用户验收通过。基线81387b5，默认conservative，aggressive可显式配置。全模式载荷清理已启用，包括off。实测结束时正式实例14篇记录、待处理0。本次补充对照写入独立验证库。

## 实现与统计口径

确定性脚本先处理二进制与编码，再由原有独立Agent服务调用DeepSeek进行语义压缩。来源适配器只解析本机会话，模型配置复用既有profile。原路径明确时只给路径。缺失或多个候选时标记“文件路径未知”。模型输入与生成正文都经过载荷剥离及凭证脱敏，原session继续供回查。

aggressive进一步展开工具文本容器，命令、补丁分别处理，优先保留条件、状态与诊断，输出带原消息位置的节选。用户与助手文字只做基础载荷剥离。输入请求保留position/role/content，时间与原始指纹继续进入正式来源元数据。预算按最终请求计算，包含上下文、提示词和schema。

沿用首轮冻结截止点2026-11-12T07:49:41.455Z，上海时间15:49:41.455。复用原3篇历史记录对应的相同消息范围与上下文，69、45、427条新增消息，按原始位置和指纹核验。9份最终输入均与当前处理器重新计算的输入指纹一致。三种模式使用同一deepseek-flash profile、提示词、schema与关注点。

字符按Unicode码点计数，包含空白换行。正文字符仅累计新增消息content，上下文及每次请求包装计入实际请求字符。请求字节为UTF-8。tokens来自供应商usage，结构与来源校验失败同样计费并计入总账。off在本轮已执行基础载荷清理，与补充前的off统计口径有变化。

## 三组同源结果

工具密集样本原文941,653字符。

- off正文200,344字符，请求262,614字符／294,635字节，输入85,915、输出1,579 tokens。
- conservative正文189,977字符，请求248,489字符／280,930字节，输入81,608、输出1,423 tokens。
- aggressive正文83,325字符，请求93,248字符／112,364字节，输入31,770、输出1,113 tokens。
- aggressive正文相对原文减少91.15%，相对conservative减少56.14%。输入tokens相对conservative减少61.07%。

需求纠正样本原文299,121字符。

- off正文299,121字符，请求322,201字符／363,793字节，输入102,066、输出2,926 tokens。
- conservative正文290,624字符，请求310,534字符／352,246字节，输入98,160、输出3,049 tokens。
- aggressive正文44,757字符，请求51,452字符／85,494字节，输入22,284、输出2,064 tokens。
- aggressive正文相对原文减少85.04%，相对conservative减少84.60%。输入tokens相对conservative减少77.30%。

失败与验证样本原文930,736字符。

- off正文232,620字符，请求326,448字符／403,000字节，输入125,011、输出2,658 tokens。
- conservative正文208,396字符，请求290,249字符／371,297字节，输入115,065、输出2,432 tokens。
- aggressive正文101,435字符，请求128,989字符／191,006字节，输入51,296、输出2,183 tokens。
- aggressive正文相对原文减少89.10%，相对conservative减少51.33%。输入tokens相对conservative减少55.42%。

三段原文合计2,171,510字符。off正文732,085，conservative为688,997，aggressive为229,517。aggressive相对原文减少89.43%，相对conservative减少66.69%。实际请求合计从conservative的849,272降至273,689字符，减少67.77%。UTF-8从1,004,473降至388,864字节。

最终选用的三次aggressive请求累计105,350输入、5,360输出tokens。conservative累计294,833输入、6,904输出tokens，输入减少64.27%。这三个来源范围对应历史记录段，尚未构成“正常大小整session”的费用分布测试。

## 质量抽查与修正

逐项阅读源材料中的关键要求、命令、补丁、测试诊断、原有记录及本次9份最终输出。结构/引用检查由程序完成，以下语义核对由本次工作Agent完成。

- 工具样本早期aggressive输出遗漏128KiB请求上限与JSON null清除规则，还把EACCES/RECOVERY_REQUIRED后重跑通过推断成并发缺陷已确诊。定位到同脚本中的exec命令掩盖apply_patch字面量、节选未保留执行权限说明。已增加字面补丁展开、硬条件优先、命令/补丁分开节选，并保留sandbox_permissions、justification和workdir。最终结果保留128KiB、null、省略字段沿用旧值、expectedRevision、发现边界、88/88与10/10、候选待用户验收、主动run与单次调用预算。仅陈述原报错及重跑结果，未经确认的因果断言已消除。相关混合脚本加入合成回归。
- 纠正样本最终保留开发机10%性能退化不可接受、撤回本地BGE-M3建议及理由、部署边界再收敛到本地CLI、v0.0.4已验收而v0.0.5仍属方案、requestId幂等与逐session增量规则。提交ID与原来源一致。原有记录的提交ID抄写问题继续作为旧摘要问题保留，本次记录未沿用该差错。
- 验证样本最终区分v0.0.1已发布和v0.0.2实现完成待验收，保留Agent基础设施、零分已评分状态与版本升级重评方案、真实3次调用/462 tokens/重复请求0调用、59项测试、PPC转发及仓库维护建议的计划身份。原范围中多个事务分别组织，提议与实施状态可辨。

细节覆盖存在下降。aggressive验证样本没有像conservative逐项展开scores/coverage的最终存储实现、offline默认值和历史用量386/76输入输出分项，早期技术选型讨论也更简略。关键用户硬约束、最终项目阶段及已核对的错误/验证状态保留。此结论覆盖本次三段抽样，尚无全库逐事实准确率。不能把结构校验或合成测试当作真实摘要准确率证明。

## 实际调用、数据与成本边界

本补充实际发起17次请求。最终选用9份有效对照，另有7次质量修正前的成功输出、1次结构失败。失败响应将evidence写成对象数组，已明确拒绝入库，冻结输入重试成功。所有17次均有本地请求、响应和usage快照。

累计输入1,068,823、输出35,923，合计1,104,746 tokens，包含失败和质量复测。首轮v0.0.9原16次账本另存。用户反馈此前16次实付约6元，平均0.375元/次。当前目标按单个完整session累计计算。本轮尚未接入供应商人民币账单，缓存命中与输出计价会影响费用，0.x元/整session的实付目标仍待账单及更多session样本验收。

9份最终输入的消息范围、原始指纹、同一提示词与schema已核验。实际请求与新正文的已识别载荷清理检查通过，2个已知凭证值精确扫描0匹配，输出中40位提交ID均能在来源找到。部分历史截图没有可确认的本机路径，保留“文件路径未知”。没有进行OCR、音视频转写或视觉理解。

正式库一致性检查valid=true。真实来源、原记录、冻结任务、逐次请求/响应与隔离库保存在本地忽略目录.data/.runtime/v0.0.9/aggressive。公开证据只包含匿名统计、合成测试及截图。当前正式实例采用conservative，新模式通过下列CLI配置选择。

## 自动化结果

- 类型检查与完整生产构建通过。
- 核心118/118通过，记录侧37/37通过。预处理专项19/19覆盖基础载荷清理、未知/截断包装、路径关联及歧义、分行Base64/Buffer/hex、短哈希与错误码、失败诊断、Unicode计数、预算、零调用预览、冻结指纹校验、截止点、旧任务迁移及缓存结果零调用恢复。
- 独立项目跟踪9项、开发集成1项通过。
- 既有Chrome浏览与Session配置两组通过。CLI配置aggressive后，网页冲突合并与保存继续透传。覆盖桌面、窄屏、草稿预览、历史记录及旧组织兼容。浏览器使用2次合成模型夹具，真实调用0次。

结构化字符、角色、规则、请求和tokens证据见[summary.json](../../../artifacts/verification/v0.0.9/aggressive/summary.json)。同目录包含core-tests.txt、records-tests.txt、independent-tests.txt、typecheck.txt、build.txt、browser/browser-result.json和transcript-browser/result.json。

## CLI验收

构建后在本地服务上执行，将instanceId换成list返回的目标稳定ID。预览可以重复执行，配置变更保留成功覆盖。run仅处理符合当前规则的新增内容。历史对照结果在隔离库中。

```powershell
npm run build
.\cli.bat transcript list --json
$instanceId = '<目标实例ID>'
.\cli.bat transcript configure --id $instanceId --preprocessing aggressive --json
.\cli.bat transcript get --id $instanceId --json
.\cli.bat transcript preview --id $instanceId --preprocessing off --json
.\cli.bat transcript preview --id $instanceId --preprocessing conservative --json
.\cli.bat transcript preview --id $instanceId --preprocessing aggressive --json
.\cli.bat transcript run --id $instanceId --preprocessing aggressive --max-calls 1 --json
.\cli.bat transcript records --id $instanceId --json
.\cli.bat check --json
```

固定范围时在preview/run中加同一个带时区ISO参数，例如`--to "2026-11-12T15:49:41.455+08:00"`。已有成功覆盖的范围应零新增、零调用。需要切回时使用`transcript configure --id $instanceId --preprocessing conservative --json`。新模式的选取入口是CLI，网页保存时继续透传。

匿名测试材料在src/records/aggressive.test.ts和preprocess.test.ts，包含合成音视频、图片、Buffer、Base64、十六进制与含关键约束的补丁。可以复制以下命令完成离线回归。

```powershell
npm run typecheck
npm run build
node --test dist/**/*.test.js
node --test tests/project-tracking/independent.test.mjs web/tests/dev.integration.mjs
$env:KB_BROWSER_USE_PPC = '0'
$env:KB_BROWSER_EVIDENCE = 'artifacts/verification/v0.0.9/aggressive/browser'
node web/tests/browser.mjs
$env:KB_TRANSCRIPT_BROWSER_EVIDENCE = 'artifacts/verification/v0.0.9/aggressive/transcript-browser'
node web/tests/transcript-configuration.mjs
```

复核现有真实对照可读取本地账本和公开统计。tests/agent/transcript-preprocess-live.mjs的`--experiment aggressive --stage history`复用已存结果。显式`--round N`才建立新一轮aggressive复测，并保留此前结果。创建新实测材料和实际收费调用需按用户已授权范围执行。
