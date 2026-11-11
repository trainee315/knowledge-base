# 0.0.2 正式发布前非付费回归

日期：2026-11-11。只使用 core 已完成的正式 `0.0.2` dist；本负责人未并发构建或修改生产实现。core 严格串行 typecheck、62/62 tests、build 均成功，新跨 kind 同 UUID 引用保护的三项回归包含在全集内。

## 实际命令与结果

```powershell
$env:KB_BROWSER_EVIDENCE = 'D:/project/knowledge-base/artifacts/verification/v0.0.2/release/browser'
node web/tests/browser.mjs
Remove-Item Env:KB_BROWSER_EVIDENCE

& 'C:/nvm4w/nodejs/node.exe' --test --test-reporter=tap 'C:/Users/mamar/Desktop/personalProjectCenter/cli/knowledge.test.mjs'
& 'C:/nvm4w/nodejs/node.exe' 'C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs' knowledge --help --json

$env:KB_PPC_VERIFY_OUTPUT = 'D:/project/knowledge-base/artifacts/verification/v0.0.2/release/ppc-patch.json'
node integrations/ppc/verify.mjs
Remove-Item Env:KB_PPC_VERIFY_OUTPUT

$env:KB_AGENT_AUDIT_OUTPUT = 'D:/project/knowledge-base/artifacts/verification/v0.0.2/release/secret-audit.json'
node tests/agent/audit-secrets.mjs --local-credential
Remove-Item Env:KB_AGENT_AUDIT_OUTPUT
```

所有命令 exit 0。浏览器 9 插件、33 资源通过，覆盖分页、组合查询、Markdown/UUID 图片与重复导航、体系、未知格式、坏引用、启停显示和移动布局。PPC 固定入口返回正式版本 `0.0.2`，含 agent 能力；原专属测试 2/2。补丁验证另在仅导出基线 CLI 文件的干净临时目录先 apply --check 再 apply，帮助转发及 2/2 测试通过，原始 PPC index/文件未变，临时目录已确认归属后清理。

离线真实凭证精确扫描 331 文件、匹配 0、匹配文件列表为空；包含源、文档、examples、dist、日志、正式 profile、备份 entry 解码及 CLI 错误 stdout/stderr。测试子进程的 fetch 被本机封锁，没有新增外部请求。真实 DeepSeek 账本仍为 closed/3，剩余 2 次额度未使用；未显示凭证文件内容或任何密钥/认证头。

全部新证据隔离在本目录。已核对 `artifacts/preview` 和 `integrations/ppc/verification.json` 无变更；未覆盖 v0.0.1 档案或先前 0.0.2 dev 证据。没有修改外部 PPC 源码、启动 PPC service、执行 pack 或创建系统任务。CIM 检查未发现本轮 preview/browser/live/audit/verifier Node 进程残留。

汇总见 [nonpaid-summary.json](./nonpaid-summary.json)；未开始任何 0.0.3 实现，等待 0.0.2 远端发布成功信号。
