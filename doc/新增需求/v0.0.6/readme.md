# v0.0.6 本地服务与 cron

状态：候选已实现并通过内部验证。基于 v0.0.5 候选快照 `0dd2615`，后续在同一开发分支推进 v0.0.7。

[项目架构原则](../../architecture-principles.md) · [公共契约](contracts.md) · [验收清单与命令](acceptance.md) · [已验证结果](verification.md)

- 建立应用基础服务，统一承载 CLI 业务调用、网页及 API。
- 引入 SQLite，持久化服务配置、定时任务与运行记录。
- 提供可停用的 cron 插件。通过配置调度知识库整理和指定实例的 Session 转录。
- 从旧周期配置迁移，保留已有资源、组织与转录记录。
