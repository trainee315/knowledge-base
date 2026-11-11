# v0.0.3 公共契约

本次复用CoreApi的`readContent(id,version)`、通用组织/类型及正式references，不增加核心业务模型。具体项目组织数据、参数校验与CLI结果由project-tracking插件定义并在其专属实现记录解释。

## 固定原件读取

`ContentApi`从`src/plugins/content/index.ts`导出，新增：

```ts
readVersion(id: string, contentVersion: number): Promise<ContentVersionData>
```

ContentVersionData包含：resourceId、contentVersion、contentHash(SHA256 bytes)、extension(含点)、parserVersion、originalNameKnown、filename、format、status(parsed/failed/unsupported)、text、rawText(string或null)、markdownReferences及可选error。rawText是严格UTF8解码原文，保留BOM/CRLF/首尾空白；text沿用现有解析器语义（去BOM）。无效UTF8没有rawText；无效JSON返回failed，未知格式返回unsupported，均不改变原件。项目登记必须检查parsed。

传入版本须为正安全整数且存在。固定bytes实际hash必须匹配该版本记录，否则CONTENT_HASH_MISMATCH。历史解析格式取history.file后缀；历史名称未知时用`version-<cv>.<ext>`中性名称并originalNameKnown=false，不能用最新文件名推断旧格式。当前版本可返回当前原名。已知content分区future schema拒绝；核心future schema继续由CoreApi拒绝。该方法无meta、词表、引用、任务写入，不检查最新正文缓存是否齐全，不联网。

现有core不支持同UUID跨格式更新，所有历史路径仍受resource.extension校验约束。改为不同格式需重新导入新资源；修改originalName不会改变正式原件解析格式。不能构造非法extension/history组合并当成受支持升级；后缀为json而正文变成Markdown会failed，项目不得登记为成功正文。

## 纯关键词派生

`KeywordsApi`从`src/plugins/keywords/index.ts`导出：

```ts
fromText(text: string, title?: string): KeywordTextData
normalize(value: string): string
// KeywordTextData = { processorVersion: string; items: Keyword[] }
// Keyword = { value: string; count: number; weight: number }
```

fromText只使用调用方固定全文及显式标题；无标题时不猜历史名称。结果确定性归一化，算法版本独立于正文版本；不访问资源meta、词表、任务或Agent。normalize供查询采用一致的NFKC/小写/空白规范。原有get/extract/vocabulary保持行为。

## 项目与命令接线

插件id `project-tracking`，导出`projectTrackingPlugin`，默认组织方式`project-development-tracking`，直接依赖content/keywords/tags。组合入口由core负责人维护，不依赖agent。所有条目引用指向resource UUID，版本/hash由项目数据明确固定，core refs不扩展version字段；保留每个历史条目的引用。

命令组`project-track`：create/add可写；list/get/documents/read/query以readOnly宿主执行。保留通用JSON单对象stdout、日志stderr和退出码0/1/2。查询正文默认5、最大20；项目内筛选、asOfVersion和数值版本由业务插件校验。read必须从固定版本返回全文，不能用当前资源文件链接替代。

标签按归一化id/name/alias确定匹配；关键词为归一化后子串模糊匹配。基线上下文取asOf范围内数值版本最高、同版本日期最新的baseline，不为stage增加隐式优先级：planned高版可以成为上下文，返回仍明确planned，不能宣称已生效。旧verified条目继续计入正常匹配/total/分页。replaces只展示声明，asOf范围之外的替代不生效于该次展示，不自动裁决或拼接事实。

共享依赖/配置/注册入口仅core负责人修改；business维护项目插件及其tests；ui维护独立测试、示例与PPC验证。变更公共接口先通知同伴。不得修改002归档或旧验证证据。

## 项目插件API与输入

`ProjectTrackingApi`及完整类型从`src/plugins/project-tracking/index.ts`导出。create({name,description?})创建通用组织；list()/get(projectId)读取清单；add(input)返回{projectId,entry,replayed}；documents(input)分页返回条目元数据；read({projectId,entryId,asOfVersion?})返回一条全文；query(input)分页返回全文及可选baseline上下文。get/list保留组织结构，entries位于organization.data且为唯一权威，不建立另一份资源meta项目索引。

add必填projectId/resourceId/title/role/projectVersion/stage。role支持baseline/state/change/decision/verification；stage支持planned/confirmed/implemented/verified。projectVersion为三段安全整数，可带v前缀，存储规范三段数值；recordedAt可选，须带时区ISO时间；contentVersion可选，省略时固定本次读取的当前cv；tags可选数组，省略时当前cv取接受的标签决定，旧cv标unknown，显式空数组表示已知无标签。requestId可选。replaces为{entryIds,scope,effect}，目标须属同项目，后续baseline必须声明替代已有baseline，首条须baseline。

查询input含projectId，可选asOfVersion/tags/keywords/includeBaseline/offset/limit。同维度多个词OR，标签与关键词两维度AND，匹配只使用条目不可变快照。默认offset0/limit5，limit1..20；分页total只计正常匹配，不把额外baseline计入。没有筛选时默认包含baseline，有词筛选默认不额外带baseline，可includeBaseline显式控制；baseline已在items时baseline=null而baselineEntryId仍给出，避免重复全文。没有命中也不会返回项目外资源。

项目条目保存固定resourceId/contentVersion/contentHash、标题/role/projectVersion/stage/recordedAt、可选替代与幂等信息、snapshot(tags/keywords/parseStatus/parserVersion/keywordProcessorVersion/filename/format/originalNameKnown/capturedAt/sourceMetaRevision)。项目数据schemaVersion1；future版本明确拒绝读取或追加。单篇全文以固定原件bytes+登记hash读取，不依赖最新content/keywords分区，包含软删除资源的历史原文。原件受损或不存在明确报错，不回退当前版本。

最小CLI流程（先导入资源，使用返回的真实UUID替换占位）：

```powershell
.\cli.bat project-track create --name "演示项目" --json
.\cli.bat project-track add --input baseline.json --json
.\cli.bat project-track documents --project-id "<project UUID>" --json
.\cli.bat project-track query --project-id "<project UUID>" --as-of-version 1.0.0 --limit 5 --json
.\cli.bat project-track read --project-id "<project UUID>" --entry-id "<entry UUID>" --json
```

baseline.json示意：

```json
{"projectId":"<project UUID>","resourceId":"<resource UUID>","title":"最初基线","role":"baseline","projectVersion":"1.0.0","stage":"confirmed","requestId":"baseline-1"}
```
