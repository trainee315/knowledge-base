# v0.0.5 用户验收

2026-11-12用户已验收v0.0.5。以下保留开发阶段的实际验收步骤。以下命令在仓库 PowerShell 执行，所有业务数据写入新建临时库。

```powershell
npm run build
$demo = node examples/create-records-demo.mjs | ConvertFrom-Json
$demo.commands
$data = $demo.data
$root = $demo.root
.\cli.bat note add --file "$root/note.md" --request-id demo-note --data-dir $data --json
.\cli.bat note add --file "$root/note.md" --request-id demo-note --data-dir $data --json
$notes = .\cli.bat note list --data-dir $data --json | ConvertFrom-Json
.\cli.bat note get --id $notes.data[0].id --data-dir $data --json
.\cli.bat transcript preview --alias v005-demo --data-dir $data --json
.\cli.bat transcript run --alias v005-demo --max-calls 1 --data-dir $data --json
.\cli.bat transcript run --alias v005-demo --max-calls 1 --data-dir $data --json
Get-Content -Raw -Encoding utf8 "$root/continuation.jsonl" | Add-Content -Encoding utf8 -NoNewline $demo.session
.\cli.bat transcript run --alias v005-demo --max-calls 1 --data-dir $data --json
.\cli.bat transcript records --alias v005-demo --data-dir $data --json
.\cli.bat transcript configure --id $demo.organizationId --alias renamed-demo --data-dir $data --json
.\cli.bat transcript backfill --alias renamed-demo --from 2026-01-01 --max-calls 1 --data-dir $data --json
.\cli.bat transcript retry --alias renamed-demo --max-calls 1 --data-dir $data --json
.\cli.bat transcript configure --id $demo.organizationId --enabled true --interval-minutes 60 --max-calls 0 --data-dir $data --json
.\cli.bat transcript tick --data-dir $data --json
.\cli.bat transcript tick --data-dir $data --json
.\cli.bat check --data-dir $data --json
```

模型命令需要所选 profile 对应环境变量已配置，正预算会调用模型。默认示例 profile 为 deepseek-default，不要求将密钥写入文件或命令。示例默认 maxCalls=0；脚本本身零模型调用、不启动服务。失败可修正凭证后 retry，不重复创建配置。

验收预期：

1. 同 requestId 第二次 replayed:true、resourceId 相同；回读含 BOM/CRLF/空白。独立不带 requestId 再添相同正文应是新资源。
2. 首预览一个候选，两条同时间戳消息；只读不改进度。首次转录仅为12次待批准计划，不能写已实施。
3. 无新增重复 run 的 calls=0；追加轮次后生成续录，前篇关联正确，保留12改8、测试错误 E_SYNTHETIC、尚未验证通过。
4. 改名组织ID不变；对已成功范围 backfill 不增加记录。tick 首次检查到期配置，紧接第二次 results为空，不安装任务。
5. `records` 得到 resourceId 后用 `resource get --id UUID --content` 阅读压缩正文，用 resource delete/restore 验证显式删除恢复；删除不触发重录。
6. 设置 `$env:KB_DATA_DIR=$data` 后 `npm run dev`，在组织浏览中选 Session转录→renamed-demo→记录，利用通用视图读文。Ctrl+C停止，恢复原环境变量值。
7. check 返回 valid:true。备份用数据目录外的新路径，restore 到另一个空目录，查看记录和 retry 无重复。

目录排除、活动轮次、分段、超大轮次、失败恢复与并发锁等由自动化夹具覆盖，见 verification。私人真实 session 请另建配置先 preview，摘要质量仍需你核对；其原文与私人产物不得提交。

2026-11-12验收通过后按项目既有流程统一正式版本0.0.5，归档版本文档、更新版本历史并提交主分支与版本标签。

## 可视化配置补充验收

使用上文 demo 临时库启动页面即可操作。终端保留原 KB_DATA_DIR 值，验收结束后恢复。

```powershell
$previousDataDir = $env:KB_DATA_DIR
$env:KB_DATA_DIR = $demo.data
npm run dev
# 浏览器打开终端显示的本地 URL，验收后 Ctrl+C
$env:KB_DATA_DIR = $previousDataDir
```

1. 组织与体系中选择 Session 转录。实例列表展示目录和周期状态，点查看详情，确认概览、关联记录、实例配置三个页签。浏览已有记录，刷新及浏览器返回恢复阅读目标。
2. 点实例配置、编辑配置。修改别名、关注点或预算后取消，确认恢复保存值。再次修改并保存，CLI transcript get 读取相同配置，UUID和既有发现边界保持一致。
3. 修改筛选条件，在增量/历史补录范围间切换并预览。候选显示位置、字节数及跳过原因。继续改字段，旧预览显示已过期。预览不会保存草稿或调用模型。
4. 新建实例，将来源目录设为 `Split-Path -Parent $demo.session` 得到的路径、项目目录与起始日期。保存前预览，然后保存，确认进入新实例详情。模型预算默认0。
5. 保持页面编辑状态，通过CLI修改另一字段，再从页面保存，应提示修订冲突并保留草稿。刷新状态与修订，核对合并内容后保存。
6. 将窗口调到约390px宽度，完成改名保存并返回实例列表。检查输入、按钮和错误提示可操作，页面无水平溢出。
7. 在构建预览中重复查看与保存，数据与开发页面及CLI一致。执行中的实例显示忙碌，完成后刷新状态可保存。已有文件和摘要正文仍按原流程查看。

自动浏览器回归命令为 `node web/tests/transcript-configuration.mjs`，使用独立合成临时库，覆盖开发服务和构建预览。截图及结果写入 artifacts/verification/v0.0.5/visual-configuration。
