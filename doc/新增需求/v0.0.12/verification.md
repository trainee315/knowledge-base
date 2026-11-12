# v0.0.12 验证报告

环境：Windows、Node.js 24.11.0、Codex CLI 0.167.2，ChatGPT 订阅登录。基线 31737ef 的 136 项测试全部通过。已同步主线 v0.0.10 的 7aeeb62，随后同步包含 v0.0.11 的 560c94d。

## 自动验证

最终类型检查及构建通过；整合 v0.0.10 与 v0.0.11 后完整测试 162/162，通过 v0.0.10 链路回归 10/10。新增页面、原插件页面及原 Session 页面浏览器回归均通过。证据为 artifacts/verification/v0.0.12 中的 integrated-tests.txt、chains.txt、browser/result.json、plugin-browser.txt 和 transcript-browser.txt。覆盖通用 Agent、DeepSeek 兼容、CLI 参数与配置、实际子进程正常退出/错误/取消/输出上限、严格 JSON、Session 配置及 v0.0.10 全链路。

第一次整合全量测试暴露超时测试的时序假设：并行负载可能在 CLI 探测阶段就超时，尚未生成 capture 文件。已将该用例限定到生成阶段，登录检测由独立用例覆盖，随后重新验证。未放宽生产超时。

网页使用独立合成库和隐藏 Chrome，验证新增 profile、模型和推理强度持久化、原 DeepSeek 保留、未安装诊断、显式连接失败、Session 选择、同源限制、GET 不得推理及移动端无横向溢出。截图已人工查看。网页夹具明确使用不存在的 CLI，模型调用数为零。

## 真实订阅调用

显式脚本 tests/agent/codex-cli-live.mjs 使用 KB_CODEX_LIVE_MODEL 指定模型；无此环境变量不会发起调用。素材为脚本中的合成对话，不读取私人 Session。证据 live-session.json。

已验证：本地登录检查；结构化连接测试；生成待执行任务后将共享 profile 改成无效模型，retry 仍使用冻结的原模型成功；摘要保留 /health、4317、HTTP 200 和尚未部署；入库后再次执行 calls=0/saved=0；provider、请求模型、用量和耗时可查。

## 验证边界

仅 Windows 和本机账号的 gpt-6-astra 做过真实验证，其他系统、账号或模型未宣称通过。跨平台分支有实现，但需要目标部署环境复核。CLI 未返回实际模型 ID，不宣称确认服务端具体版本。没有用私人长会话做质量基准，也没有消耗额度进行大批量性能测试。

Codex 自带上下文开销、额度窗口与 CLI 升级兼容性仍需在实际使用中观察；maxTokens 是结果接收上限。新增功能没有改变现有正式实例和默认供应商。

真实调用（同步 v0.0.10 后）：连接测试 10664 tokens，Session 摘要 11436 tokens、6634ms；结果来源为 CLI usage，不代表订阅额度单位。详细数值以 live-session.json 为准。同步 v0.0.11 未修改 provider，已重新验证完整自动回归、网页、链路和验收服务登录，不重复消耗模型额度。
