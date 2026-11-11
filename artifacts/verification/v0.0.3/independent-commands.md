# v0.0.3 独立验证命令记录

以下命令均在 `D:/project/knowledge-base`、core 最终构建后执行；未再次 build。`node` 为 Node24，本机固定可执行文件 `C:/nvm4w/nodejs/node.exe`。

```powershell
$env:NODE_OPTIONS='--import=file:///D:/project/knowledge-base/tests/project-tracking/offline-fetch.mjs'
node --test --test-reporter=tap tests/project-tracking/independent.test.mjs
# 9/9，external request count 0，independent.tap

$env:KB_BROWSER_EVIDENCE='D:/project/knowledge-base/artifacts/verification/v0.0.3/browser'
node web/tests/browser.mjs
# 33资源 / 10插件卡片，desktop1440、mobile390，browser/browser-result.json

$env:KB_PROJECT_FENCE_SILENT='1'
node --test --test-reporter=tap C:/Users/mamar/Desktop/personalProjectCenter/cli/knowledge.test.mjs
# 2/2。仅为原fixture精确stderr断言静默退出计数标记，fetch封锁仍生效。

node examples/project-tracking/create-demo.mjs
# 6资源 / 7条，check有效，独立临时库保留；不启动服务。

& 'C:/nvm4w/nodejs/node.exe' 'C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs' knowledge --help --json
# version=0.0.3-dev

& 'C:/nvm4w/nodejs/node.exe' 'C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs' knowledge project-track query --project-id '4c1a288a-5f15-4e88-9811-90f1cf033fd0' --data-dir 'C:/Users/mamar/AppData/Local/Temp/knowledge-base-project-demo-AcROAI/项目演示库' --json
# total7 / items5 / baseline独立上下文 / 0.0.10先于0.0.3

& 'C:/nvm4w/nodejs/node.exe' 'C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs' knowledge project-track read --project-id '4c1a288a-5f15-4e88-9811-90f1cf033fd0' --entry-id 'e3e1609c-66d7-49fb-b602-4296447def64' --data-dir 'C:/Users/mamar/AppData/Local/Temp/knowledge-base-project-demo-AcROAI/项目演示库' --json
# 历史cv1原文/hash固定，当前资源cv2；摘要见demo-ppc.json
```

浏览器测试自动关闭其 Chrome、Vite 和独立临时 preview。最终 `Get-CimInstance Win32_Process` 按本轮 preview/browser/demo/独立测试命令匹配为0；演示库没有服务启动。读取 v002 外部账本仅核对 closed/3，未读取密钥，未发任何实际外部API请求。旧档案/证据路径 git diff 为空。

示例的完整可复制 query/asOf/read/preview 命令在保留库 `project-demo.json` 的 commands 字段；preview 命令只是打印，未执行。临时库如需长期保留请用正式 backup 另存。
