# v0.0.12 Agent Codex CLI 适配

状态：开发中，待用户验收；验收通过后才合并主线。

固定起点：`31737efaef7b51e3d1e0fb2edda37b25bddae833`。分支：`codex/v0.0.12-codex-cli`。

目标：Agent 插件复用服务器运行账号已登录的 Codex CLI，支持指定模型、文本与结构化生成；Session 使用统一 Agent profile。

约束：保留 DeepSeek 兼容性；不自动回退付费 API；不读取或复制登录令牌；配置查询不调用模型；连接测试显式消耗订阅额度；临时会话避免递归采集。

实施顺序：基线检查 → 契约与适配器 → 配置页面和 Session 接入 → 自动测试及真实最小调用 → 验收材料。正式版本号保持不变。
