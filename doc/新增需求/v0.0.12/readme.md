# v0.0.12 Agent Codex CLI 适配

状态：开发和验证完成；待用户验收，验收通过后才合并 main。正式发布版本保持 v0.0.5。

分支：`codex/v0.0.12-codex-cli`。固定开发起点：`31737efaef7b51e3d1e0fb2edda37b25bddae833`。开发期间将已提交的 v0.0.10 主线 `7aeeb62` 同步到本分支，保留其 CLI 契约、执行范围及返回记录信息；未将本分支合入主线。

## 交付

- 通用 Agent provider `codex-cli`，支持文本和严格 JSON 对象生成。
- 复用服务器运行账号的 ChatGPT 订阅登录；不读取、保存、搬运登录令牌，不回退付费 API。
- 网页新增 Codex profile，选择调用方式，配置模型 ID、推理强度、超时和结果 token 接收上限。
- 模型输入可参考同 provider 已保存的模型，支持手动填写。没有伪造账号的可用模型列表，实际权限由显式连接测试验证。
- 本机登录状态检测与显式连接测试；状态/配置普通查询不启动 CLI 或请求模型。
- Session 引用 profile；排队任务保存非秘密配置快照，重试保持原模型。新任务使用新配置。
- 使用临时会话与独立目录，禁用业务无关工具和插件；完整退出校验、超时取消及资源清理。
- 记录 provider、请求模型、用量和耗时；仅当 CLI 报告实际模型时记录 actualModel，不把请求模型冒充实际型号。

[运行说明](running.md) · [配置契约](contracts.md) · [验证报告](verification.md) · [验收步骤](acceptance.md)
