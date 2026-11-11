# v0.0.2 运行说明

要求Node.js24+及npm。先运行 `npm ci`、`npm run build`；Windows统一入口为 `cli.bat`，其它Node环境可直接运行 `node dist/cli/main.js`。资源/组织/预览/备份基本操作见 [v0.0.1运行说明](../v0.0.1/running.md)。所有命令支持data-dir和JSON对象输出，退出码0成功、1执行失败、2参数错误。

## 无网络检查与配置

```powershell
.\cli.bat agent status --json
.\cli.bat agent profile list --json
.\cli.bat agent profile get --id deepseek-default --json
.\cli.bat agent config get --json
.\cli.bat agent profile set --id deepseek-default --model deepseek-flash --max-tokens 512 --reasoning off --json
.\cli.bat relation get-config --json
```

status/profile list/get/config get和relation get-config是只读，缺key也能检查且不联网；profile/config set只保存非秘密配置。默认profile的credentialEnv为DEEPSEEK_API_KEY。生产从进程环境读取凭证，不读取仓库外测试凭证文件；请安全设置环境变量，不把密钥写进CLI参数、JSON输入、资源、profile、备份或Git。

## 显式调用

以下命令会请求真实provider并可能收费；它们不是默认测试步骤。当前版本验收的真实请求账本已关闭，不应为重复验证再调用：

```powershell
.\cli.bat agent generate text --profile deepseek-default --input examples/agent/text.input.json --json
.\cli.bat agent generate object --profile deepseek-default --input examples/agent/object.input.json --json
.\cli.bat relation configure --mode agent --agent-profile deepseek-default --json
.\cli.bat relation score --id 标签UUID --max-calls 1 --input keywords.json --json
```

`keywords.json`例如 `{"keywords":["纹理","压缩"]}`。无需凭证、不会付费的通用示例为 `node examples/agent/generic.mjs`，详见 [示例](../../examples/agent/README.md)。

自动整理默认maxCalls0；配置agent模式不等于自动获得调用预算。直接score是显式调用，应传max-calls；organize/task/schedule的批次预算按任务预留控制，score另有maxRequests硬次数保护。maxCost只按任务声明估算，不是供应商实时费用硬界，0估算不代表免费。

## 缓存与重评

已覆盖词对重复0新请求，0分只保存coverage；只有未覆盖项需要补评。标签定义或资源内容变化会产生新的整理输入，但不自动使已有评分词对失效，返回原评分的定义追踪与warning。确需重评可显式设置新的scoringLogicVersion；provider版本、请求model、真正生成参数或prompt/schema版本改变也进入新scope。profileId/revision、timeout、凭证引用不使缓存失效。

```powershell
.\cli.bat relation configure --scoring-logic-version 2 --json
.\cli.bat relation configure --mode offline --json
```

新scope保留旧scope，最终标签归属仍由工作Agent/人工提交，人工接受/拒绝不被自动结果覆盖。JSON schema是明确子集，不支持的关键字在网络前拒绝，详见 [契约](./contracts.md)。

## 升级与预览

已知v001离线lexical评分可复用，零值迁移为coverage；不确定旧模型规则保存独立legacy scope，future结构拒绝覆盖。正式数据与凭证保持分离，备份不包含密钥；不修改原有用户数据目录或001归档。

本版预览动态显示9个插件，页面仍只读；插件启停后stop/start刷新状态。PPC适配仍是不经shell的独立CLI转发，不依赖PPC后台；[可分发补丁和验证工具](../../integrations/ppc/README.md)随本仓库提供，外部PPC仓库不在本次提交推送范围。
