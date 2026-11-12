# v0.0.12 用户验收

候选在独立工作树分支 codex/v0.0.12-codex-cli；验收通过前不合入 main，不变更正式版本号，不推送发布标签。

1. 打开本次提供的隔离验收页面，进入 Agent → 配置，选择 codex-session。
2. 检查调用方式为 Codex CLI，模型可编辑，推理强度可选；确认说明使用服务器账号登录。
3. 点击“检查登录状态”，应显示就绪及 CLI 版本；点击“测试连接（消耗额度）”可验证所选模型。
4. 在 project-tracking → 配置中选择合成验收实例，确认可选择 codex-session，压缩模式仍可独立设置。
5. 修改模型或强度、保存并刷新，确认持久化；验收后可恢复到已验证的模型。
6. 查看验证报告和合成摘要，重点确认冻结模型重试、避免重复入库、失败不回退付费 API。

如果新建 profile：模型 ID 使用账号实际可用的型号，候选仅来自已保存配置，不是账号权限目录。不要将模型列表显示误认为权限已通过。

验收通过后，再检查 main 是否前进，必要时同步和补测，然后合并主线。当前主线上的其他工作及其他工作树均保留。

## 独立演示库

在候选工作树执行以下命令，创建只含合成数据的独立库并启动服务。脚本只检查登录，不调用模型；输出可直接打开的 Agent 与 Session 页面地址。

```powershell
$env:KB_CODEX_DEMO_MODEL = "gpt-6-astra"
node examples/agent/codex-demo.mjs
```

模型请替换为服务器账号可用值。最近一次启动信息保存在工作树忽略目录 `.data/v0.0.12-acceptance.json`。服务可按其中 dataDir 使用 `node dist/cli/main.js service stop --data-dir <dataDir> --json` 停止。
