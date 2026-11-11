# v0.0.4 按组织形式浏览文档

状态：2026-11-11用户验收通过，包含文章概览选中状态；正式版本0.0.4，Git标识v0.0.4，见[发布归档](../../v0.0.4/readme.md)。

组织方式→条目→文档→正文。标签支持any/all；关键词汇总有效元数据并精确选词；体系保留递归目录及去重汇总；项目跟踪显示版本、阶段、替代声明及固定历史正文。未知组织按资源引用回退。桌面三区、移动端逐级阅读，URL可恢复筛选与阅读目标。只读HTTP与开发/正式预览共用实现，不写正式数据。

接口：GET /api/browse/collections（type、q、offset、limit），GET /api/browse/documents（type、id多选、q、tagMatch、nodeId、offset、limit），GET /api/project-tracking/:projectId/entries/:entryId（asOfVersion可选）。组织元数据沿用现有接口。普通页30最大200，项目页最大20。正文摘要160字符，正文懒加载。organize query新增tagMatch，缺省any。

验收：PNG压缩4篇、游戏架构5篇、字段投影词组、跨标签访问；独立夹具验证多层体系、固定历史、异常与只读零写、URL恢复和窄屏。实现完成后用户验收再归档发布。

## 验收与状态

[验收入口](acceptance.md) · [验证总表](../../../artifacts/verification/v0.0.4/summary.json)

已实现共享只读接口、组织浏览页面与CLI标签all匹配。类型检查、构建、72/72测试、独立项目9/9、开发集成1/1、Chrome回归和真实资料核验通过；开发候选已获用户验收，按计划以0.0.4正式版本归档发布。
