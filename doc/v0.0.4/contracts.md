# v0.0.4 公共契约

## 查询语义

organize query新增tagMatch:any|all，默认any，保留旧调用行为。同条件内原有OR与不同条件间AND不变，仅标签维度可显式选all；CLI参数--tag-match。标签只依据已接受关联；关键词只读取与当前contentVersion一致的数据。浏览选择具体关键词采用NFKC/小写/空白归一化后的精确成员判断；左侧名称搜索仍为模糊匹配。

## 共享只读HTTP

开发与正式预览复用同一处理器，业务只允许GET/HEAD并执行本地同源校验。响应沿用{ok:true,data}或{ok:false,error}。

- GET /api/browse/collections：type为组织方式ID，q搜索名称，offset/limit分页，返回items及total/offset/limit；每项包含id/name/description/count。关键词条目ID为完整词组，其余为组织UUID。
- GET /api/browse/documents：type、重复id参数选择条目；tagMatch为any/all；q搜索普通文档标题与160字符摘要，项目视图按历史关键词查询；nodeId限定体系子树；offset/limit分页，返回文档摘要或项目条目元数据。普通页默认30，最大200；项目默认及最大20。
- GET /api/project-tracking/:projectId/entries/:entryId：读取固定历史全文，支持可选asOfVersion。历史不存在、损坏或不在范围内明确报错，不回退当前原文。

普通列表只返回资源身份、类型、内容版本等摘要字段，不内嵌plugins或全文；正文选中后从现有资源详情接口读取。项目列表保留entry/replacement/matchReasons，另返回baselineEntryId及不在当前分页的基线上下文；额外基线不计total，保持003排序与阶段语义。

体系目录按父子关系和同级order呈现，选中目录包含后代文档；汇总按UUID去重，保留资源全部目录位置。软删除及失效资源不进入普通成员列表，缺失引用单独提示。项目历史按003规则仍可读取已固定的回收资源。插件不可用明确报错，未知专门视图的已登记组织方式提供通用引用预览。

## 页面导航

保留原#resource/UUID链接；#browse参数记录type、重复id、q、tagMatch、offset、nodeId，以及resource或entry阅读目标，cq/co记录左栏搜索及分页。刷新与前进/后退恢复阅读上下文；旧请求不能覆盖新选择。历史概览以entry ID判定选中，普通文档以resource UUID判定。
