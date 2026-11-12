# v0.0.7 验证记录

候选完成自动验证，待用户验收。[验收操作与命令](acceptance.md)

- `npm test` 完整构建与核心测试 99/99 通过，包含插件详情接口、恢复故障和静态文件边界检查。最终前端调整后重新构建网页。
- `node web/tests/plugin-detail.mjs` 通过。浏览了全部 12 个内置插件的简介，验证无配置和空集合、分页、详情跳转、刷新及前进后退、草稿导航保护、冲突比较与合并、CLI 配置互通、cron 计划增改启停删除和历史保留、停用和失败状态、390px 布局。外部请求 0，网页错误 0。[结果](../../../artifacts/verification/v0.0.7/browser/result.json) · [桌面计划](../../../artifacts/verification/v0.0.7/browser/cron-plans.png) · [窄屏配置](../../../artifacts/verification/v0.0.7/browser/mobile-config.png)
- `node --test web/tests/dev.integration.mjs` 通过。最终网页构建后重跑 `node web/tests/browser.mjs` 和 `node web/tests/transcript-configuration.mjs`，两者通过。

Agent 网页配置支持生成参数，供应商及凭证环境变量引用由 CLI 管理。验证使用临时库、合成数据和模型替身。真实模型、真实资料迁移及全面 OS 故障覆盖不在本次验证范围内。
