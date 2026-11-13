# v0.0.13 关键词契约

## 持久缓存和索引

复用 `cache/semantic/index.sqlite`，`PRAGMA user_version=2`。写路径从 v1 增加下列派生结构，保留兼容向量、片元、标签匹配和任务；只读 GET 不执行磁盘迁移，未知未来版本拒绝访问。

- `keyword_terms(id, normalized, name)`：归一化键唯一；ID 为 `k-` 加归一化关键词的 SHA-256。统一使用既有 NFKC、大小写、空白归一化。
- `keyword_documents(resource, signature, version, payload, searchText)`：每个资源当前发布记录。签名包含内容版本、hash、文件名、片元及关键词算法版本、模型身份；模型身份也保存在 settings 中。payload 只含必要资源字段、标题和前 160 个字符的摘要。
- `keyword_links(keyword, resource, fragment, value, start, end, count, score)`：规范关联表。主键 `(keyword,resource,fragment)` 支持反查，附加 `(resource,keyword,fragment)` 和 `(fragment,keyword)` 支持正查。文档关联从关系表按资源去重，不复制另一套可独立修改的关系。
- settings 中的 `keyword-revision` 是发布代次；`keyword-source-generation` 是已核对的正式变更标记；`keyword-rebuild` 取 `running/complete`。进度和失败沿用持久 jobs 表。

完整词表来自所有已发布片元的关键词并集。文档元数据仍写前 100 个聚合关键词作为兼容摘要；完整查询不受此限制。关键词位置是解析后的正文 UTF-16 偏移，`start/end` 指向代表出现位置，`count` 为片元内次数，不代表返回全部出现位置。

## HTTP 浏览

以下 GET 均带 `type=keyword`，默认 `limit=30`，上限 200，`offset` 为非负整数。搜索先于分页执行。响应在既有 `{ok:true,data:...}` 内返回 `items,total,offset,limit,generation,status`。

- `/api/browse/collections?q=...`：只读词表，items 仅 `{id,name}`。按归一化键、ID 排序。包含搜索可以扫描词表，不扫描正文、不逐词遍历文档。
- `/api/browse/documents?id=...&q=...`：按所选关键词查文档，先去重、匹配标题和索引摘要，再分页和解码当前页轻量投影。兼容重复 id 参数的并集，最多 200 个。兼容旧的归一化词语 ID；新页面使用稳定 ID。
- `/api/browse/fragments?id=...&resourceId=UUID&version=N`：恰好一个关键词；按资源查询命中片元，分页返回既有片元结构及 `evidence:{value,start,end,count,score}`。version 可选；不匹配时返回 `KEYWORD_GENERATION_CHANGED`。

后续查询可传 `generation`。不匹配时返回 `KEYWORD_GENERATION_CHANGED`，页面清空旧选择和分页并提示刷新。未知词条返回 `missing:true`；无匹配是正常空列表。失败保留结构化错误，不冒充空结果。

`status={state,pending,failed}` 中 pending/failed 是资源任务计数。state 为 `ready/partial/pending/rebuilding/failed`。缺失缓存、尚未迁移或正式数据待同步时返回 pending；全量重建期间返回 rebuilding，隐藏混合代次。失败重建保留 failed 计数。普通增量处理可以返回 partial/failed 及已完成的有效资源。

GET 不加载模型、不隐式重建。生产服务在轻量路由处理关键词请求，避免每次初始化整套应用；核心读快照加 SQLite 读事务覆盖标记检查、计数和分页。原关键词 CLI list 仍返回名称数组；语义模式的组合关键词筛选改查完整索引，未就绪明确报错。

## 发布与恢复

每次 `resource.*` 正式事务同时更新 `state/keyword-generation.json`。索引读取只比较此标记；后台既有 reconcile 扫描负责失效、缺口修复及设置已处理标记。使用全库标记是保守失效方案：后台核对前可能短暂显示待同步，不在 GET 执行核对。

关键词算法版本为 `semantic-keywords-2`，与向量身份分离。后台写元数据前再次检查源签名，并在同一 SQLite 事务替换片元、关键词关联、文档发布记录及任务状态。核心事务先提交的中断通过持久任务和源标记检测、重放；SQLite 失败会回滚整套关联。删除清理资源关系，仅回收无引用词条；恢复重新排队。

`semantic rebuild` 清除关键词派生缓存、排队全部当前资源、标记 rebuilding，保留本地向量和正式标签。重复调用正在执行的 rebuild 返回 `resumed:true`，不会重新清空。`semantic run` 每批处理至多 4 个任务；中断后继续运行即可。全量任务完成前禁止自动新增标签；完成后恢复原后台策略。`semantic retry-all` 重排失败任务。兼容的标签匹配可复用，不为重建无意义地重复编码或比较。

本次未引入额外内存缓存；SQLite 的持久词表、SQL 索引及分页已满足实测目标。标签页面关键词聚合读取规范关系表；其他标签浏览的既有全量聚合链路不属于本次性能改造范围。
