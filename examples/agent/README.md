# 通用 Agent 的两个用途

先完成构建，然后运行无需凭证、不产生费用的示例：

```powershell
node examples/agent/generic.mjs
```

同一个 `AgentService` 分别执行文本摘要 `generateText` 和结构化提取 `generateObject`。示例只注入本地 mock provider；替换 transport provider 时，调用方、消息格式、JSON Schema 和结果接口保持相同，不需要将业务提示词写入 DeepSeek 适配器。

`text.input.json` 和 `object.input.json` 是只含合成材料的公开输入样例。DeepSeek profile 仅保存 `credentialEnv: "DEEPSEEK_API_KEY"` 引用；真实凭证应由本机环境提供，不能写进输入、profile、笔记库、仓库或备份。显式运行真实 provider 会产生请求及可能的费用，普通示例和默认测试均不会这样做。

JSON 输出需要模式请求和提示词共同要求 json；返回内容还会经过空白、截断、JSON 语法及 schema 校验，评分等业务另行验证自己的值域和覆盖范围。适配器默认非思考模式，有明确 token/超时上限，不隐式重试。
# 项目级 CLI 接入实例

运行 `npm run demo:agent`，生成独立知识库、两个含中文/空格目录的业务项目、多个合成 session，以及填写真实组织/资源 ID 的 `AGENT_PROMPT.md`、`project-config.json` 和请求 JSON。脚本实际执行 CLI，检查单 session 压缩、直接读取、同名术语跨项目隔离，最后停止演示服务并打印重启/查询/停止命令。

默认完全离线，摘要由 `offline-provider.mjs` 原样转录合成材料；不读取私人 session，不下载模型，不发生云端费用。普通调查使用 lexical；真实向量验证见 [v0.0.10 报告](../../doc/新增需求/v0.0.10/verification.md)。示例库放在 `.recall-local/v0.0.10/demo-*`，不会覆盖现有业务项目。

正式接入请替换项目路径、数据目录、profile 和授权预算，先读取并合并召回映射。完整规则见 [项目提示词](../../doc/新增需求/v0.0.10/agent-project-prompt.md) 和 [CLI 契约](../../doc/新增需求/v0.0.10/contracts.md)。上方通用 Agent API 示例仍可独立运行。

## Codex CLI 独立验收库（v0.0.12）

构建后设置 `KB_CODEX_DEMO_MODEL` 为账号可用模型 ID，执行 `node examples/agent/codex-demo.mjs`。脚本创建合成 Session 与 codex-session profile，检查服务器登录并打印页面地址，不发起推理。详见 [验收步骤](../../doc/新增需求/v0.0.12/acceptance.md)。
