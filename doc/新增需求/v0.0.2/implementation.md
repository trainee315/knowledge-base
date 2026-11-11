# v0.0.2 实施记录（已归档）

> 发布收尾：实现提交ca79363，CLI正式0.0.2，引用修复后完整62/62及独立干净检出通过。当前发布能力见 [002归档](../../v0.0.2/readme.md)；下文59项/待验收等为开发冻结阶段的历史证据。

通用AgentApi/provider边界在src/agent/types.ts。实现分层为通用service/schema/profiles、DeepSeek传输adapter、agent基础设施插件；不import任何tags/keywords业务代码。业务通过显式依赖使用公开API。

协议来源（2026-11-11核对）：[首次调用](https://api-docs.deepseek.com/en/)、[JSON mode](https://api-docs.deepseek.com/guides/json_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。使用deepseek-flash，API DTO只在adapter。JSON mode不是schema保证；空白、length截断及非法结构必须报错。

现已实现AgentService/profile/schema、DeepSeekProvider、agent插件及CLI，根package/lock目标0.0.2、help标为0.0.2-dev；既有归档未改，未提交/推送/打标签。

AgentService捕获profile/provider/messages/schema快照。configurationHash只含provider版本/model/生成参数，排除凭证引用、profileRevision和超时调度；model为请求身份，actualModel追踪供应商canonical名称，避免别名误判。排队/请求共用时限与AbortSignal，实际在途调用受并发限制；非合作provider取消后仍占slot直到返回，阻止超卖并发。无隐式重试，错误只带固定码/文案/安全HTTP状态，不透传原响应/cause；未知provider异常、status探测异常和配置保存异常也封边界。

JSON schema支持本目录contracts所列子集，网络前拒绝未知/不适用规则、循环或非JSON enum/const。JSON mode只是传输选项；成功要求完整stop、非空白、合法JSON且本地schema匹配。业务完整词对覆盖/唯一/0..1另校验。凭证仅env引用，profile白名单无密钥字段，load/readonly/status/config不联网不写正式数据。受控mock factory createAgentPlugin({service,providers})供测试复用计数transport，不暴露宿主内部runtimes。

冻结后严格串行typecheck→npm test→npm build均exit0，**59/59**通过（34项v0.0.1回归、19项agent/独立HTTP集成、6项关系/任务专项），测试9213.47ms。UI随后独立mock13/13、9插件/33资源真实Chrome、PPC2/2与真实help0.0.2-dev通过。所有新输出在artifacts/verification/v0.0.2，旧发布档案/证据无改动。

真实验证仅ui执行，总计3请求（文本/JSON/关系各1）成功，共462tokens=386输入+76输出；第二次关系评分0network。数据均synthetic，不保存模型正文或reasoning。账本已closed，未用余额度不得继续请求，本作者真实请求0。离线实际key精确扫描当时310文件0匹配、逐备份entry解码及5类CLI stdout/stderr无key，网络封锁探针外部0请求，见 [独立验证](./agent-verification.md)。

关系实现dataVersion2及缓存schema2：tag级串行保护共享文件所有scope；coverage记录全部成功评分词对，scores仅存正分；只补未覆盖对。scope包含显式logic/provider/model/生成语义/prompt/schema版本，不含tagRevision、profile修订/timeout/凭证。标签定义变化只提示/追踪，不自动旧对重评；新logic或生成语义使用新scope。v001已知lexical v1可复用，未知旧模型规则保留legacy scope，future缓存拒绝迁移；全量验证后再写，无半批覆盖。详见 [业务实现](./relations-implementation.md) 和 [独立复核](./relations-independent-review.md)。

任务新增可选prepare不改强制持久schema：预算前仅本地重估/obsolete，收费队首不阻后面的0费任务；prepare跨批次时限不dispatch，耗尽旧scope可本地淘汰且不额外尝试/付费，有效耗尽仍停留。实际调用前预留次数，score硬maxRequests防批量配置竞态；默认自动maxCalls0阻止模型。maxCost为声明估算，不承诺供应商实时美元硬界。

首版不是完整自主Agent：无tools自动执行、规划、记忆、流式、多真实provider或实时账单计量。schema为明确子集，未知规则拒绝；同进程取消无法强杀任意不合作第三方代码，仅保留slot/隔离等候。当前为开发完成待验收，不commit/push/tag或归档新正式版。
