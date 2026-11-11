# 精选验证证据

本目录保留可重复的QA工具、独立复核前后JSON、演示摘要、精选浏览器截图与冻结/发布检查日志。全部使用合成资源和临时测试库，不包含用户正式知识库、密钥、缓存或正在运行的进程状态。

- `business-review.mjs`：可重复独立业务反例；先构建后运行，输入数据由脚本在临时目录生成。before-fixes与result分别为修复前后证据。
- `preview-first-use-probe.mjs`：首次空目录与真实CLI/Chrome探针，关联preview目录结果和截图；不是生产入口。
- `preview/`：真实Chrome的桌面/移动/空库/组织/插件等精选截图及结构化结果，不是资源库原件。
- `verification/final-*.log`、`final-summary.json`：2026-11-10冻结实现检查及基准；`release-*.log`为2026-11-11发布时重新验证，二者分开保留。
- `demo-result.json`：演示脚本的一次合成结果摘要，实际演示使用 `node examples/create-demo.mjs` 新建独立目录。

历史输出可能含本机临时路径和生成UUID，属于证据上下文，不应直接当作另一台机器的有效目录。完整发布结论见doc/v0.0.1。
