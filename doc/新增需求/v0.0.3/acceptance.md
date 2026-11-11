# v0.0.3 最终验收

当前状态：自动核验完成，等待用户验收。003尚未提交、推送、打标签或发布；004尚未开始开发。

## 已完成核验

类型检查与构建通过，完整回归70/70、独立项目验证9/9、开发预览集成1/1及真实Chrome浏览器回归通过。此次结果来自当前工作区，原有验证证据保留。详见[最终核验](../../../artifacts/verification/v0.0.3/final-acceptance/summary.json)。

## 请核对这五项

1. [项目查询结果](../../../artifacts/verification/v0.0.3/final-acceptance/query.json)：版本0.0.10优先于0.0.3，即使日期较早；planned明确为计划，不解释为已完成。
2. [限定0.0.3的结果](../../../artifacts/verification/v0.0.3/final-acceptance/as-of.json)：不混入后续版本记录。
3. 对照[固定历史原文](../../../artifacts/verification/v0.0.3/final-acceptance/pinned-history.json)与[当前资源](../../../artifacts/verification/v0.0.3/final-acceptance/current-resource.json)：原件当前为cv2，项目记录仍读取cv1。
4. [被替代记录](../../../artifacts/verification/v0.0.3/final-acceptance/replaced-record.json)：旧记录和原文仍保留，替代关系仅作声明。
5. [浏览器验收截图](../../../artifacts/verification/v0.0.3/final-acceptance/browser/)：当前003通用资源预览可用；按组织形式阅读和项目历史正文的专门网页属于004。

独立演示库位于：`C:\Users\mamar\AppData\Local\Temp\knowledge-base-project-demo-wbs3hb\项目演示库`，项目ID：`b86290fa-f7bd-425d-9999-964c7e0018dc`。可以在仓库根目录重跑以下只读命令：

```powershell
node dist/cli/main.js project-track query --project-id b86290fa-f7bd-425d-9999-964c7e0018dc --data-dir "C:\Users\mamar\AppData\Local\Temp\knowledge-base-project-demo-wbs3hb\项目演示库" --json
node dist/cli/main.js project-track read --project-id b86290fa-f7bd-425d-9999-964c7e0018dc --entry-id 11adc557-119c-46a6-bea0-648b109147ec --data-dir "C:\Users\mamar\AppData\Local\Temp\knowledge-base-project-demo-wbs3hb\项目演示库" --json
```

演示库保留在系统临时目录，真实知识库未被替换。确认上述行为符合预期后，回复“0.0.3验收通过”；随后按已确认计划归档发布003，再实施004。
