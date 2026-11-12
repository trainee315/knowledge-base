# v0.0.6 验证记录

候选实施与内部验证已完成，最终交验随 v0.0.7 一并进行。

- `npm test` 完整构建和核心测试通过，96/96，包含 2 项新增 cron 测试。
- `node --test tests/project-tracking/independent.test.mjs`，9 项通过。包含服务通过 CLI 读取固定历史正文、文件库已有写者时的只读操作、BOM/CRLF 保真，以及外部模型请求计数为零。
- `node --test web/tests/dev.integration.mjs`，1 项通过并正常退出。覆盖 Vite 与应用服务之间的 API 代理、来源校验、附件响应、静态文件边界、端口冲突及独立启停。
- `node web/tests/browser.mjs`，构建页面和 Vite 回归通过。验证 33 份样例资源、12 个插件卡片、桌面与 390px 布局。完整检查名见 [浏览器结果](../../../artifacts/verification/v0.0.6/browser/browser-result.json)。保留资源页、窄屏和插件停用三张代表截图。
- `node examples/create-demo.mjs` 与 `node examples/project-tracking/create-demo.mjs` 均成功。脚本退出前停止各自的临时服务。项目追踪演示验证 7 条记录、6 个资源和零外部请求。

- `node web/tests/transcript-configuration.mjs`，修复转录实例按 ID 改名兼容后通过。包括浏览器保存、CLI 并发冲突保留草稿、历史记录、筛选预览、开发代理与空库首次配置。两次模型替身调用，零真实模型调用。[Session 回归结果](../../../artifacts/verification/v0.0.6/transcript-browser/result.json)
