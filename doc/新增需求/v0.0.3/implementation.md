# v0.0.3 实现记录

003开发候选已实现并冻结源码，自动验证与独立复核完成，待用户验收。本文件只记录真实落地部分，阶段状态见 [执行记录](./execution.md)。当前已发布版本仍为002，本轮未提交或发布003。

已创建独立开发分支，目标包/CLI为0.0.3-dev。ContentApi.readVersion新增固定原件版本读取、历史后缀解析、SHA256核验、严格UTF8原文与历史名称未知标记。KeywordsApi.fromText/normalize新增纯派生，不调用当前meta提取流程。原get/extract行为保持。CLI已接入project-track只读动作分类，组合入口注册projectTrackingPlugin，内置插件共10个。

项目插件以Organization.data保存schema1的唯一条目清单，固定UUID/cv/hash、标签与关键词快照及算法版本。首条baseline，之后只追加，replacement仅声明，不合并或隐藏历史。数值版本优先日期，planned高版可作baseline上下文，返回仍明确planned。asOfVersion先限定范围，再按快照标签确定匹配/关键词模糊匹配进行分页，正文limit默认5/max20，额外baseline独立去重。详见[插件作者记录](./project-tracking-implementation.md)。

requestId先查显式输入指纹，再解析当前版本/时间/标签，内容更新后的重试仍回放原entry；同项目串行并用expectedRevision保护原子追加。所有历史resource refs保持永久删除保护。旧cv缺少历史标签时unknown，显式[]表示known空。read/query直接读固定bytes并对照登记hash，不消费最新派生缓存；future当前content分区不影响既有pin读取。未来项目schema拒绝读写，原件损坏明确错误，不能回退当前正文。

作者执行typecheck、build:core成功；`node --test dist/plugins/content/version.test.js`3/3通过。读取测试比较数据目录全部文件hash，确认writer会话和readOnly会话的助手调用均无写；未知content分区schema拒绝。当前核心不支持改变资源格式，改格式需重新导入新UUID，历史后缀由已有schema约束，测试用当前名称变化验证不能误选解析器。

独立项目反证7组通过，发现并由作者修复新CLI参数转换exit1问题，原反例复验exit2/INVALID_ARGUMENT，见[独立复核](./project-independent-review.md)。最终严格串行typecheck→npm test→build均exit0，70/70测试（002既有62+helpers3+project5），原始log在artifacts/verification/v0.0.3。首轮旧默认组织方式断言需适配新增第四方式，保留test-first.log；作者补齐默认处理器与备份断言后重新全过。

最终独立项目JS9/9、Chrome10插件/33资源/8截图、PPC2/2及help0.0.3-dev通过，保留演示6资源7条目实跑query/read/asOf/固定pin。全部证据见[总验证JSON](../../../artifacts/verification/v0.0.3/summary.json)及[验证作者记录](./project-tracking-verification.md)。没有新增真实模型请求，002活动保持closed/3。

不支持同UUID跨格式演进、项目条目edit/delete、自动合并、自动裁决生效事实或专用项目UI。通用预览可浏览组织元数据；UUID普通链接指向当前资源，历史全文须用project-track read/query。本轮不扩大CoreApi，不引入Agent调用，不自动发布。
