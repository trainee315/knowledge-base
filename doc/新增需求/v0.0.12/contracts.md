# v0.0.12 配置与执行契约

## Agent

providerId 新增 codex-cli。profile 的 model 必填；reasoningEffort 可选 low/medium/high，省略按 low。credentialEnv 保留为兼容字段，在 Codex profile 中固定为空字符串，绝不填虚构环境变量或登录令牌；DeepSeek 仍是有效环境变量引用。

AgentProviderRequest 新增可选 schema，generateObject 传递冻结 schema；所有 provider 的结果继续经统一校验。Codex 严格输出要求对象 additionalProperties=false、所有声明属性必需、数组有 items；不兼容 schema 在调用前返回 AGENT_UNSUPPORTED_SCHEMA。原有通用 schema 及 DeepSeek 行为保持。

Codex 响应使用 JSONL：最后 agent_message 为结果；必须正常退出并有唯一 turn.completed 及合法 usage；错误事件、失败事件、截断或空白输出不能入库。CLI 未提供实际模型 ID 时，AgentResult 不返回 actualModel。请求模型保留在 model。

profileHash 包含 Codex 推理强度；已有 DeepSeek 身份哈希算法保持。修改模型/强度影响新请求身份。

## 检测和页面

agent check --profile：只运行版本和 login status 检测；ready/missing/not-logged-in/unsupported/error，不等同于远端模型权限通过。

agent test --profile：显式最小结构化推理，返回身份、用量和 elapsedMs。普通 agent status 的 Codex profile 标记 authentication=codex-login、readiness=unchecked；旧 credentialConfigured 布尔仅代表 API 凭证，不用它推断 Codex 登录。

新增 POST /api/plugins/agent/profiles、/check、/test。要求本地同源、application/json、有界请求体；check/test 使用保存的 configKey 和 expectedConfigVersion，不执行未保存草稿。新建只接收 id/model，拒绝覆盖同 ID profile。通用配置 PATCH 继续使用版本校验。

## Session

Task 新增 agentProfile（不含秘密的入队配置快照）与 elapsedMs。旧任务在首次执行时补存快照；新任务创建时冻结。执行使用冻结模型及预算；retry 不重新发现材料、不换模型。

transcripts 元数据增加 model.providerId、elapsedMs；actualModel 仅在供应商报告时存在。保留 v0.0.10 的 records、processedTasks、stopReason、范围过滤和预算返回。已有记录不重写。

## 进程边界

可执行路径仅由服务器环境或 PATH 提供。参数数组、shell=false、windowsHide=true；输入经 stdin 传递，schema 在受限临时目录写入，完成/失败后清理。--ephemeral 防止生成任务自身再次成为 Session 来源。--ignore-user-config 隔离用户工具/插件配置；保留 CODEX_HOME 供 CLI 自己使用原有登录，强制 chatgpt 认证并清除继承的 API key/敏感环境字段。

stdout/stderr 总缓冲上限 4 MiB；错误只映射固定错误码，不透传原始 stderr、输入和凭证。Windows 取消终止进程树，Unix 终止进程组。模型调用期间不持有文件库写锁；服务原有调度队列仍可能串行等待长请求。

官方依据：[非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
