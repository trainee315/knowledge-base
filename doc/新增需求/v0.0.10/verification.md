# v0.0.10 全链路验证报告

日期：2026-11-12。状态：候选实现与已测门槛通过，按用户要求先行提交，待用户验收且不阻塞后续需求加入；未推送、发布或打包，正式版本仍为 0.0.5。本轮没有实现 MCP。

工作树基于 `31737ef`。依赖保持现有锁文件；Node 24.11.0，Transformers.js 3.8.1。所有新增场景使用隔离合成库，没有读取或上传私人 session。

[机器汇总与源码哈希](../../../artifacts/verification/v0.0.10/summary.json) · [隔离服务已停止](../../../artifacts/verification/v0.0.10/service-cleanup.json)

## 交付结果

压缩链路已修复 alias 双定位、preview/run 覆盖不一致和单 session 过滤；新增安全 status、结构化部分失败结果、本次写入资源及明确完成状态。冻结输入恢复、成功覆盖去重、原子写入与源版本检查继续生效。完整轮次后仍有活跃轮次时，不再误报全部完成。

召回链路已修复裁剪后跳片元，提供 read/list/多文档证据各自可执行的续取入口，绑定范围、版本、正文 hash 和切分身份。混合语言 tokenizer 修复错误码、中文标点、版本和 Windows 路径边界；相似错误码不因子词重合而冒充精确命中。旧索引显式迁移，保持原始记录不变。

CLI 帮助与字段校验同源，帮助不触发 workload/model/service 操作；提供 recall config get、配置合并示例和项目提示词。最后补充 transport 参数校验，缺失 data-dir 不会回落到另一知识库。[公共契约与迁移](contracts.md)记录兼容变化。

内部压缩 prompt 已有硬约束、否决理由、纠正、数值和实施/验证区分，本轮真实语义检查符合要求，因此保留文本；工作 Agent 提示词增加准确字段、触发时机、预算、续取及失败恢复规则。

## 自动回归与复现证据

- 基线原有 136/136 通过：[baseline.tap](../../../artifacts/verification/v0.0.10/baseline.tap)。
- 四项缺陷修复前均失败：[regressions-before.tap](../../../artifacts/verification/v0.0.10/regressions-before.tap)。覆盖 alias、preview 预算、六片元续读、中文与标识符边界。
- 核心、网页构建通过；全量串行回归 149/149：[final.tap](../../../artifacts/verification/v0.0.10/final.tap)。包括原有 136 项、3 项召回扩展、10 项真实 CLI 子进程→服务链路。
- 最后 transport 参数补充后，核心重新构建、10/10 CLI 链路再次通过：[final-cli.tap](../../../artifacts/verification/v0.0.10/final-cli.tap)。这是复测，不额外计入唯一用例数。
- 原有测试继续覆盖并发、租约、源改写、错误 evidence、超时/失败、缓存模型结果恢复、固定旧版本、BOM/CRLF/emoji、删除恢复、映射冲突、模型缺失及开发负载让出。新用例补齐单 session、零预算、部分成功、冻结请求 hash、活跃轮次、列表快照、切分变更、多文档遗漏和旧 tokenizer。

保留了中间失败：全量并行时全局 workload 保护使独立索引测试返回 DEVELOPMENT_BUSY；改串行后该干扰消失。新增路径测试暴露连续 `:/` 分隔符未保留，修复后通过。此前小预算测试期待“空证据但成功”，现按无进展错误契约明确断言 OUTPUT_BUDGET。这些记录分别在 final-tests.tap、final-sequential.tap 和 targeted*.tap，未删除失败样本。

本机已有开发进程锁住 esbuild，npm ci 无法替换文件；使用 `npm install --ignore-scripts --no-audit --no-fund` 恢复现有锁文件依赖，未修改锁文件，构建通过。沙箱临时目录原子 rename 曾出现 EPERM，隔离测试经本机权限执行；没有终止用户开发服务。

## 真实压缩、写入与向量召回

[live.json](../../../artifacts/verification/v0.0.10/live.json)记录了实际 CLI→本地服务→DeepSeek→写入→项目映射→直接读取→向量构建→调查返回的联合链路：

1. 压缩包含普通攻击命中、300ms、闪避/受击清零、禁止500ms、全部帧缓存否决理由、最近60帧、E_COMBO_8192 失败及未证实推测的合成 session。逐项核对正文，未把实施写成验证通过。
2. 纯语义改述实际运行 embedding；hybrid 实际执行 RRF，启用重排时实际执行 reranker，核对 stages 和模型用量。
3. 追加用户纠正为280ms、60帧不变且尚未重跑测试。再次压缩后新证据可见；增量构建编码2片元、复用94片元；重复构建复用96片元、零编码/零模型调用。
4. 重复压缩零新增写入；按续读拼接与完整正文一致；删除立即排除证据，恢复后可重新索引。

本机模型从此前合成验收的公开缓存复制到新库，逐文件校验，不下载新模型：embedding 为 `Xenova/bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781`，重排为 `Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101`；编码身份 `6cf47aee644c477e707d490c24bb21fe16219d01aaa005f8cb4af39b783dce88`。仍使用 q8/CPU、512维、单模型并发和单计算线程。

## 最终源码的冻结召回集

[final-recall.json](../../../artifacts/verification/v0.0.10/final-recall.json)按 v0.0.8 原13个验收问题、原文条件与原门槛复测六种模式，代码断言 casesHash 与首次联合活动相同。每次返回K=5、最多12000字节；只命中标题不算覆盖条件。

以下顺序为 Recall@5 / MRR / 完整条件覆盖率：

- literal：0.500 / 0.250 / 0.500。
- BM25：1.000 / 1.000 / 1.000。
- semantic：0.917 / 0.917 / 0.917。
- hybrid、hybrid+rerank、task：均为1.000 / 1.000 / 1.000。

六组范围泄漏、错误固定原文引用、该无答案样本的误召回均为0。语义及组合路径达到原 Recall/MRR≥0.75、条件覆盖≥0.90 门槛；没有使用新增容易样本替换冻结集。旧 tokenizer 指针迁移的真实向量复测命中107片元缓存、零重新编码。模型worker峰值RSS为923062272字节，低于原1.5GiB门槛；该值不是整机或父子进程总内存。

本轮 p95：scope 81ms、read 69ms、list 26ms、BM25 114ms、semantic 1220ms、hybrid 1048ms、重排3401ms、task 8687ms，均满足原对应门槛。检索使用13问各一次，元数据各5次，小样本p95接近最大值；未清空OS页缓存。字面基线p95为3206ms，原门槛未对该基线设置限制，不掩盖其耗时。

本轮没有改动模型线程、编码或 workload 调度实现，未重跑上一版六组各20对开发负载非劣试验。性能结论继续限于显式 `recall workload` 保护入口；本轮延迟结果不代表未保护的外部构建也满足3%退化门槛。

## 真实工作 Agent

[agent.json](../../../artifacts/verification/v0.0.10/agent.json)记录真实 deepseek-flash 自主选择 CLI 命令、输入参数及最终报告的六类任务，6/6通过：继续历史任务、精确ID读取、无答案、续读、指定session压缩、部分失败恢复。宿主只限制允许命令/范围，执行实际 CLI 并把结果返回模型；不代填业务参数或代写结论。只读帮助、scope/status 可由宿主预先提供实际 CLI 结果。

运行目录包含中文和空格，并与知识库程序目录不同；所有调用使用固定CLI/data-dir。断言检查280ms纠正与未验证状态、300ms固定历史版本、无答案不编造、两节续读不遗漏、沿用preview.cutoff、只写指定session、错误恢复只处理目标冻结任务。精确ID读取允许省略session过滤的前提是ID已来自本次、且session匹配的run返回；项目范围仍必须匹配。

部分失败种子由离线注入一次503和一次成功创建，后续重试由真实 Agent 决定、真实压缩模型完成；不声称供应商自然发生了该故障。CLI离线回归另行验证重试的冻结请求 hash 不变和成功项不重复写入。

调试过程保留了错误字段 retrieval、宿主初版未允许help/scope、宿主结构协议校验失败和精确读取范围断言过严的记录，见 agent-before-*.json。完成的调用轨迹被复用，没有抹掉失败或用全预排脚本替代 Agent 决策。初版结构校验失败未保存原始失败响应，不推断其具体字段；最终宿主按action区分CLI输入和最终回答，真实CLI参数校验仍严格。

整个活动实际26次云端请求，其中4次用于真实压缩、22次用于工作Agent（包含调试请求）；输入72045、输出3887、合计75932 tokens。初始上限24次，经明确说明追加一次8次，总上限32；每次输出不超过2048 tokens。账本记录追加原因、请求hash、实际模型及usage，不记录密钥。未查询供应商账单或换算货币费用，不宣称节省费用。所有云端材料均为合成样本。

## 可复制接入与复测

```powershell
npm run build
node --test --test-concurrency=1 dist/**/*.test.js tests/chains/chain.test.mjs
npm run demo:agent
```

[demo.json](../../../artifacts/verification/v0.0.10/demo.json)记录本次生成的双项目、多个session、真实组织/资源ID及可复制命令。默认离线模型仅证明流程，不能作为摘要质量证据。生成项目的 AGENT_PROMPT.md 配置完整，默认云端预算为0；正式接入参见 [项目级提示词](agent-project-prompt.md)。

需要重复真实模型活动时，`node tests/chains/live.mjs --live` 创建新合成库并设置24次共享预算；随后 `node tests/chains/agent.mjs --live` 执行Agent任务，`--resume` 续跑未完成场景。脚本要求环境中的 DEEPSEEK_API_KEY，只引用变量名。live.mjs 当前复用本机 v0.0.8 合成验收记录指向的公开模型缓存；换机器需先准备并核验缓存，不能把缺失模型的失败算作业务失败。

`node tests/chains/final-recall.mjs` 在 latest.json 指向的合成库复测最终召回，禁止网络，不产生云端请求。真实模型/Agent活动不属于默认 npm test；普通回归与实例均零云端请求。

## 结论边界

两条链路及写入到向量召回的衔接已实际执行并通过本报告中的检查。无答案验收仅1个冻结问题，真实Agent每类1个完成任务，压缩为小规模合成多事务材料；不外推为任意长会话或任意业务项目的无损压缩保证。没有接入用户的真实业务库、升级旧库索引、启动新常驻服务或执行发布。旧库迁移需按其已授权维护流程显式 `build --vectors`。
