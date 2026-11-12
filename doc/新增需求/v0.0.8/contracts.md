# v0.0.8 公共契约（实施稿）

沿用 `--data-dir`、`--input JSON`、单 JSON 输出及退出码 0/1/2。命令经过现有服务。版本号暂不改变。

## 命令

- `recall configure --input config.json`：带 expectedRevision 的显式范围/切分/排名配置更新。
- `recall scope`：解析范围和精简覆盖说明。
- `recall prepare --input request.json`：统一路由。
- `recall read --id resourceId|fragmentId|精确标题`：无模型读取，可指定 version、相邻片元数或 section。精确标题重名返回 ambiguous 和范围内候选，不猜测对象。
- `recall list`：结构化分页，默认 recordedAt 降序；只支持显式白名单排序字段。
- `recall search`：显式检索。
- `recall index status|build`：状态或增量构建；`--rebuild` 重切分/重建，未改变编码身份的缓存仍可复用；`--vectors` 显式文档编码。
- `recall model prepare|status`：显式下载/核验固定版本模型；普通查询离线使用准备好的模型。
- `recall eval --input suite.json`：固定快照的六种模式及定位/范围指标，模型缺失标为未验证，不伪造分数。
- `recall workload --input workload.json`：本地CLI显式包裹开发命令，无需连接服务。输入 `{"command":"npm","args":["run","build"]}` 或 command=node；不会通过shell解释。负载期间新检索/索引返回 DEVELOPMENT_BUSY，在途模型取消；退出后恢复。返回子命令退出码，子命令日志写stderr。

## 配置与请求

配置包含 projects（id、aliases、directories、modules、固定入口 resource IDs）、resources（resourceId 对应 projectId/modules/sourcePaths）、organizations（组织 ID 到 projectId/modules）。配置通过核心正式存储保存，不改变记录正文。范围说明按完整范围、元数据修订、索引状态和输出预算缓存；省略的元数据数量单列，不以缓存覆盖代替现场更新。

实现配置中，模型身份由 `model prepare` 的锁定清单管理；configure不接受任意模型URL。可选chunking={targetChars,maxBlockChars}及ranking={semanticMinScore,rrfK,bm25TitleWeight}。默认900/1400字符、0.40/60/2。切分配置参与片元身份；排名配置变化参与范围配置修订，不重复生成未变化的文档向量。

请求字段：`mode: auto|read|list|question|task`，`id`、`version`、`query`/`task`、`needs`、`scope`、`contextProjectId`、`cwd`、`retrievalMode: lexical|semantic|hybrid`、`rerank`、`budgetTokens`、`maxBytes`、`maxFragments`、`debug`。默认 hybrid、不开重排；task 默认模板组装。CLI 自动传调用目录。明确 read/list 不升级模型路径。

scope 字段：projectId 或显式 crossProject/projectIds，modules、organizationIds、sourcePaths、recordType、sessionId、time（field: sourceTime|recordedAt，from/to 带时区，半开区间）。不同维度 AND，同维度多个值 OR。显式项目与任务项目冲突报错；目录匹配多个项目返回歧义。sourceTime 为区间相交，缺少源时间不借用入库时间。跨项目必须显式。

返回包含 requestId、route/reason、scope、status、stages、index generation、evidence、needs/gaps、warnings、usage、timings、budget。片元含固定版本原文和定位、项目/组织/模块/来源时间、命中方式和展开入口。默认不暴露插件分区、原始 session 或调试候选。检索材料不是执行指令。

title是当前资源名称；底层历史元数据不保证保存过去的文件名，因此历史原件必须以resourceId/contentVersion/contentHash和偏移定位。headings来自该固定版本原文，不能把当前显示名称当成历史标题证据。

错误包括参数无效、范围歧义/冲突、索引缺失/滞后、固定版本不可用、模型未准备/执行失败、预算不足。范围无答案不扩大范围；混合降级显式列出缺失阶段。极小的响应预算返回最小错误，不执行模型。

read 的 offset 为资源内片元序号（从0开始），list 的 offset 为列表位置；返回 read/continue 对象可原样用于下一次read。全文读取仍受预算，必要时分次取完。
