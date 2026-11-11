# 通用 Agent 的两个用途

先完成构建，然后运行无需凭证、不产生费用的示例：

```powershell
node examples/agent/generic.mjs
```

同一个 `AgentService` 分别执行文本摘要 `generateText` 和结构化提取 `generateObject`。示例只注入本地 mock provider；替换 transport provider 时，调用方、消息格式、JSON Schema 和结果接口保持相同，不需要将业务提示词写入 DeepSeek 适配器。

`text.input.json` 和 `object.input.json` 是只含合成材料的公开输入样例。DeepSeek profile 仅保存 `credentialEnv: "DEEPSEEK_API_KEY"` 引用；真实凭证应由本机环境提供，不能写进输入、profile、笔记库、仓库或备份。显式运行真实 provider 会产生请求及可能的费用，普通示例和默认测试均不会这样做。

JSON 输出需要模式请求和提示词共同要求 json；返回内容还会经过空白、截断、JSON 语法及 schema 校验，评分等业务另行验证自己的值域和覆盖范围。适配器默认非思考模式，有明确 token/超时上限，不隐式重试。
