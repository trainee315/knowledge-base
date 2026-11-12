# knowledge-base 项目追踪演示

先构建项目，并保证本地存在已发布的 `v0.0.2` tag：

```powershell
node examples/project-tracking/create-demo.mjs
```

脚本只读取该 tag 的 commit、package.version 和提交时间，构造一份带真实发布事实的初始 baseline；其它变更、修正、计划与验证均为明确的合成示例。不会扫描全仓、聊天、笔记或凭证，不访问远端或 Agent，不创建系统任务。

每次在 `os.tmpdir()` 创建独立新库，生成期间启动本地服务，结束时停止该服务。演示数据和原件会保留。输出 `project-demo.json` 及 PPC query/read/preview start/stop 命令，`PPC_CLI_PATH` 可覆盖本机 PPC 入口。没有 PPC 时可运行清单中的 directReadPinned 命令，查询前先启动该库服务。

演示包含 6 个资源、7 条 entry：002 已发布基线、被明确替代的错误草稿、修正 decision、日期较早但版本更高的 0.0.10 planned、known-empty 标签的验证文档、固定cv1的历史全文、历史补录 tags unknown。最后会更新原件至cv2并修改当前标签别名，再验证 requestId 重放和旧快照仍保持原样。

查询先按三段数值版本，再按日期；planned 排在前面不代表它已完成或自动成为当前真相。替代只是显式范围/效果标注，不删除原文、不自动合并。全文默认 5 条、上限 20 条，不截断；baseline 另作上下文，不挤占匹配分页。

**历史全文必须用 `project-track read/query`。** 通用预览仅显示组织元数据，普通资源 UUID 链接读取当前版本，不能作为历史全文入口。同一资源跨格式更新不支持，Markdown 与 JSON 应分别导入新 UUID。

演示库不会由脚本删除，但系统临时目录可能被后续清理；长期保存请通过正式备份命令另存。
