# v0.0.14 启动与 CLI 易用性优化

状态：用户验收通过；未正式发布。实施及验收日期：2026-11-13。用户确认“验收完成”。

本版提供一键启动、完整内置命令帮助、统一错误建议、可读文本输出、诊断和常用操作交互，保留默认单 JSON 对象及退出码契约。包版本及 CLI 帮助版本统一为 0.0.14。

- 双击根目录 `start.bat`，或执行 `cli.bat up --format text`，完成环境准备、启动和打开页面。
- `cli.bat interactive` 进入常用操作菜单。
- `cli.bat resource import --help --format text` 查看具体命令说明。
- `cli.bat doctor --format text` 检查环境，`cli.bat service logs --format text` 查看服务日志。

[实施计划](plan.md) · [公共契约](contracts.md) · [运行与恢复](running.md) · [验证记录](verification.md)

本版不包含安装包、自动升级、全局安装引导及 shell 自动补全；不迁移现有知识库数据。
