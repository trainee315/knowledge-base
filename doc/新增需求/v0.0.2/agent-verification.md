# v0.0.2 Agent 独立验证

状态：独立验证完成，全部通过，当前无待修发现；未提交、推送或发布 v0.0.2。验证负责人没有修改 agent/core/contracts/relations 生产实现。

## 验证边界

codebase-memory 的项目列表、index_status 与 check_index_coverage 均确认当前知识库未索引；针对 `src/agent`、relations、tasks、组合入口和 CLI 使用目标源文件回退，不将图覆盖缺口描述为完整结构审计。

测试使用本地 loopback mock HTTP，覆盖请求映射、明确非思考/token 上限、JSON 空白与截断、语法/schema 错误、401/429/5xx 脱敏、无隐式重试、传输错误 cause 隔离、排队与请求取消/超时、队列上限、无 key 与只读配置零网络、通用多用途和 provider 替换。另检查关系缓存、预算阻止付费、备份及工作树不含秘密。

公开示例位于 `examples/agent`，默认只用 mock，无自动收费。真实烟测只允许显式 opt-in，并由一个 runner 统一计数，含可选 models 请求在内最多 5 次；仅发送合成数据，单次输出限 256/512 tokens，默认非思考，不隐式重试。凭证从仓库外读取到内存，只输出脱敏状态、模型、usage 与耗时，不输出请求头、密钥、reasoning_content 或原始完整响应。

## 官方行为核对

- 当前 Chat Completions 支持 `deepseek-flash`；thinking 默认开启，需显式发送 `thinking:{type:"disabled"}`。见 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。
- JSON 模式需要 response_format 与提示词要求 JSON；即使 finish_reason 为 stop，也可能返回全空格，length 则可能截断。应用应明确失败且不隐式重试。见 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

## 独立 infra 审查结论

当前无待修发现。新增的 `src/agent/provider.integration.test.ts` 13 项独立测试已通过，使用真实 loopback HTTP、公开 AgentService 与 createAgentPlugin/PluginHost；不读取私有 runtimes，不改业务源码来替换 provider。核心作者自己的契约/强校验测试另行保留，此处不冒充独立测试数量。

- 请求映射与通用性：text、JSON 两个非评分用途共用接口；DeepSeek DTO 只在 adapter。max_tokens、messages、json_object、非流式和 thinking.disabled 通过真实 HTTP 观察，凭证只进入内存中的认证头，不进入请求正文或状态。
- 失败边界：空白 stop、length、非法 JSON、类型/值域/额外字段/schema 缺项都明确拒绝；401、429、500、503及 transport cause 只留下固定错误，单次请求不隐式重试。未知 schema 规则在 transport 前拒绝。
- 取消与队列：总时限覆盖排队和实际请求；队列取消/超时/满额不会调用额外请求。核心非合作 provider 的实际 slot 保持与 profile/schema 快照测试也已核对，不将“取消等待”当作强制杀死任意 JavaScript。
- 状态与写入：load/status/profile 查询没有网络；只读 profile 更新被 READ_ONLY 拒绝，正式 profile 字节保持不变；使用合成凭证完成请求后，正式数据及备份逐项 base64 解码均没有该值。
- 身份与缓存：配置 hash 不因 timeout、credentialEnv 或纯 revision 变化而失效，生成语义参数变化才换 scope。配置请求模型保留在 result.model，供应商别名单列 actualModel，避免旧请求或别名冒充新 profile。

协作审查中核对的反例均已修复并验证：provider.isConfigured 抛异常时 status 只返回 false；未知配置保存 callback 异常统一脱敏，同时 READ_ONLY 保留固定码；HTTP 实际模型名与请求配置身份分离；schema/profile 的未知字段及非 JSON 值在调用前拒绝。没有将读取到的实现中间态列为仍未解决的缺陷。

审查边界为本版非流式 text/JSON transport、profile/队列/脱敏及首个 relations 消费者；不声称覆盖未来供应商、流式协议或完整自主 Agent 工具循环。

## 关系与预算独立验证

独立 mock 验证了：词归一化去重、零分只保留 coverage、不保存零分条目；相同 scope 再查请求为零；标签定义变动保留原 coverage revision 并给升级评分逻辑版本提示；显式 scoringLogicVersion、模型或生成参数改变时新 scope 重新评分，纯 timeout 更改不重评。重复词输出被业务拒绝，整批没有留下部分覆盖。

在显式选择 agent 后，默认 organizer 与 schedule run 的 maxCalls=0 实测 HTTP 计数仍为 0；放开一个调用预算后才产生 1 次 HTTP，请求不会自动确定资源标签归属。

## 真实 DeepSeek 烟测

仅使用仓库外本机凭证、合成文本和合成标签。实际共 **3 次请求**：文本 1 次、JSON 1 次、关系小批 1 次；GET/models 未调用，没有失败重试。总 usage 为输入 386、输出 76、合计 462 tokens。模型为 deepseek-flash，实际模型也为 deepseek-flash。text 和 JSON 均 maxTokens=256，关系 maxTokens=512，均明确禁用思考。

- text：13 输入 + 3 输出，683ms。
- JSON：104 输入 + 10 输出，430ms。
- relation：2 个合成词，269 输入 + 63 输出，1400ms；归一化同词第二次 maxCalls=0，实际 0 网络，reused=2、requests=0。正式数据和备份的真实密钥精确匹配扫描通过。

本机仓库外账本已标记 closed，剩余 2 次额度冻结不用，后续审计不再访问真实 API。runner 只有 `KB_AGENT_LIVE=1` 且 `--live` 双重 opt-in 才可能请求，默认运行输出 skipped/requests=0；关闭后的账本禁止新请求。公开示例只跑 mock，不默认收费。

脱敏证据为 `artifacts/verification/v0.0.2/live-core.json` 与 `live-relations.json`；只保存状态、模型、usage、耗时和计数，不保存请求头、正文、完整响应或 reasoning_content。

## 最终冻结后回归

core 冻结后严格串行 typecheck、npm test、npm build 均 exit 0，全集 **59/59**（包括原有 34 项及本轮新增验证）。其日志为 `artifacts/verification/v0.0.2/final-{typecheck,test,build}.log`。随后本负责人只使用当前 dist，未再次 build 或修改生产代码：

- 独立 HTTP/插件集成再次 13/13，通过输出保存在 `mock-http.tap`。
- 九插件真实 Chrome 回归通过：33 资源、Vite 同源代理、组合筛选、分页/无结果、Markdown/UUID 图片与重复导航、失效引用、体系、插件禁用及 390px 无横向溢出。显式指定 `KB_BROWSER_EVIDENCE=artifacts/verification/v0.0.2/browser`，结果及截图均在该目录，未覆盖已发布 v0.0.1 文档、`artifacts/preview` 或旧 final 日志。
- 外部 PPC 原 knowledge 两项测试通过；真实 `knowledge --help` 透传当前 `0.0.2-dev` 和通用 agent 命令成功。没有修改外部 PPC 源码，也没有调用其 service/pack。
- 离线实际密钥精确扫描 310 文件，匹配数 0、匹配文件列表为空。范围包含源/文档/examples/dist/产物/日志、正式 profile、备份 base64 解码及 CLI 错误 stdout/stderr；结果为 `secret-audit.json`。测试子进程一次 transport 意图由预加载器在本机拒绝，实际外部请求为 0；真实账本仍 closed/3。
- CIM 进程检查未发现本轮 preview/browser/live/audit Node 进程残留；Chrome、Vite、预览及临时数据均已按各验证器清理。

离线精确检查工具为 `tests/agent/audit-secrets.mjs --local-credential`：真实值仅存在本机进程及测试子进程环境；子进程预加载 fetch 封锁器，任何 transport 在本机拒绝。检查源/文档/examples/构建产物/日志、正式 profile、备份逐项解码和 CLI 错误 stdout/stderr，只报告匹配数量及文件名，不打印内容；排除 `.git`、`node_modules` 和符号链接，不声称扫描压缩 Git 历史。

无需真实凭证、不会收费的可复现检查：

```powershell
node --test dist/agent/provider.integration.test.js
node examples/agent/generic.mjs
node tests/agent/live-smoke.mjs
```

最后一条默认仅报告 skipped/requests=0。真实 campaign 已完成并关闭，不应再消耗剩余额度。独立汇总为 `artifacts/verification/v0.0.2/independent-summary.json`。
