# Codex CLI 运行说明

## 服务器前提

知识库服务运行的机器需要安装 Codex CLI（本版实测 0.167.2，下限为 0.167.2），并由运行服务的同一系统账号完成 `codex login`。浏览器所在机器的登录不能代替服务器登录。API Key 登录会被此 provider 拒绝。

服务继承的 PATH 中应能定位 CLI。Windows 支持 PATH 下的原生 codex.exe，以及 npm 全局 @openai/codex 的原生程序；也可在启动服务前设置环境变量 `KB_CODEX_CLI_PATH` 为原生程序或官方 codex.js 的绝对路径。不要填写 cmd/bat/ps1 包装脚本。服务不通过 shell 拼接执行命令。

服务账号仍需能够访问其原有 Codex 登录存储和网络。改动服务器环境变量后需自行重启对应知识库服务，使新进程继承环境。

## 页面操作

1. 插件 → Agent → 配置 → 新增 Codex 配置。
2. 输入独立配置 ID（如 codex-session）和账号可用的模型 ID。本机实测使用 gpt-6-astra，其他账号须自行验证可用性。
3. 保存后选择“检查登录状态”，确认服务器就绪；此操作不推理。
4. 选择“测试连接（消耗额度）”，验证指定模型及结构化输出。
5. 插件 → project-tracking → 配置，选择 Session 实例，再选择摘要模型配置。组织里的 Session 详情也可选择同一 profile。

原有 DeepSeek profile 和默认行为保留，不自动切换已有 Session。推荐新增独立 Codex profile，避免修改其他功能共用的 profile。

## CLI 示例

先从当前构建启动指定数据目录的服务，再执行下列命令。MODEL_ID 替换为实际可用模型 ID，DATA_DIR 替换为测试库目录。

```powershell
node dist/cli/main.js agent profile set --id codex-session --provider-id codex-cli --model MODEL_ID --reasoning-effort low --timeout-ms 120000 --max-tokens 4096 --data-dir DATA_DIR --json
node dist/cli/main.js agent check --profile codex-session --data-dir DATA_DIR --json
node dist/cli/main.js agent test --profile codex-session --data-dir DATA_DIR --json
node dist/cli/main.js agent generate text --profile codex-session --prompt "用一句话解释增量摘要" --data-dir DATA_DIR --json
node dist/cli/main.js transcript configure --id SESSION_INSTANCE_ID --profile codex-session --data-dir DATA_DIR --json
```

## 参数及恢复

Codex reasoningEffort 支持 low/medium/high，默认 low；具体模型需支持对应值。通用 temperature 必须为 0、reasoning 必须为 off，表示不传这两个不兼容控制项；这不表示 Codex 关闭推理。页面隐藏这些通用控制项。

Codex maxTokens 只是完成后的结果接收上限，超限返回 AGENT_TRUNCATED，不会保存为成功结果，也不能限制已经消耗的额度。timeoutMs 覆盖本地检测及生成；Session 同时受实例剩余总时限约束。

未安装、未登录、不支持的版本、模型不可用、限流、非零退出、缺少完成事件、无效 JSON、schema 不匹配、超限、超时都不会回退 DeepSeek。修复后显式重试。任务冻结 profile，修改共享配置不会改变已排队任务；需要改模型处理旧材料时，应创建使用新 profile 的独立实例并明确选择材料范围。

CLI 自带上下文有固定开销，短摘要不等于少量输入 tokens。本机连接测试约 1 万输入 tokens，费用路径仍是订阅额度，可能与日常 Codex 使用共享限额。
