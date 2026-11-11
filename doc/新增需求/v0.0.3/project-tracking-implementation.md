# 项目开发状态跟踪实现记录

状态：0.0.3开发分支候选实现，尚未提交、发布。0.0.2已发布归档保持冻结。本记录只描述项目插件；公共helpers、注册及最终集中验证由core负责人记录。

## 权威与边界

插件`project-tracking`直接依赖`content`、`keywords`、`tags`，不依赖agent，不调用模型，不注册系统任务。manifest静态登记方式`project-development-tracking`，首次登记/只读零写沿用核心组织方式机制。项目是Organization UUID，name仅供阅读；`Organization.data={schemaVersion:1,description,entries}`为条目唯一权威，没有资源meta里的第二份项目清单。

第一条必须baseline。role支持baseline/state/change/decision/verification，stage支持planned/confirmed/implemented/verified。仅追加，没有项目业务edit/delete命令；纠正元数据、阶段或原文版本都追加新条目。后续baseline必须明确replaces已有baseline。replaces包含同项目已有entryIds及非空scope/effect；不自动隐藏历史、裁决阶段或合并全文。

每条固定resourceId、contentVersion、原件SHA256、标题、三段项目版本、带时区记录时间、阶段及标签/关键词快照。省略contentVersion时仅在首次登记取当时最新版本。省略recordedAt时取登记时间；不使用mtime。版本可带小写v前缀，保存为三段数字；排序先数值版本降序，再记录时间降序，最后entryId稳定排序。

当前核心不支持同UUID跨格式更新；改格式须导入新UUID。旧格式来自固定原件路径，不借用最新originalName；旧名称无法证明时snapshot保存version-N.ext及originalNameKnown=false。只登记严格UTF8、解析parsed的MD/Markdown/TXT/JSON，不登记损坏JSON或文件名降级文本。原文保留BOM、空白与换行，不截断。

## 快照、固定版本及幂等

登记使用`content.readVersion`验证原件hash与解析状态；以rawText调用`keywords.fromText`，不传中性历史文件名。保存parserVersion、keywordProcessorVersion、关键词、格式与名称可信状态，不写原资源meta、词表或任务。

省略tags且登记当前版本：复制资源meta已接受标签，固定id/name/aliases、定义revision及manual/codex/automatic来源。省略tags且登记历史版本：status=unknown、source=unavailable-history、items=[]，不复制最新标签。显式tags通过当前定义解析并固定；显式[]为known空集。显式选择不会改写资源最终归属。

`requestId`在项目内唯一。项目读取后先查请求及显式输入指纹，相同返回首次entry和replayed=true，不解析最新contentVersion、标签或当前时间；不同报PROJECT_REQUEST_CONFLICT。指纹固定受支持的用户显式字段，省略与显式提供不同，不包含服务端默认值/解析快照。无requestId每次追加。项目级串行合并同进程追加，并通过expectedRevision拒绝外部并发丢失更新；冲突不悄悄重算输入或覆盖。

写入前复读固定原件并校验hash，资源meta若在登记过程中变化则报CONFLICT。所有历史条目的resource UUID均保留在Organization.references中，包括被声明替代、旧版本和回收站原件；保护整个资源history。未知项目data.schemaVersion拒绝读取及追加，禁止降级覆盖。

`read/query`正文直接使用`core.readContent(resourceId,pinnedVersion)`，对照条目hash严格UTF8解码；不重新读取当前content/keywords/tags分区作为历史分类依据。当前派生分区升级或标签改名不影响已登记历史。原件损坏/hash不符明确失败，不截断、跳过或以最新版本替代。

## CLI/API

完整TypeScript契约见`src/plugins/project-tracking/types.ts`。以下命令均可用`node dist/cli/main.js`或cli.bat，所有项目身份传`--project-id <Organization UUID>`。复杂数组/替代声明使用`--input <JSON文件>`或`--input -`。

```powershell
node dist/cli/main.js project-track create --name "示例项目" --data-dir .runtime/project-demo --json
node dist/cli/main.js project-track list --data-dir .runtime/project-demo --json
node dist/cli/main.js project-track get --project-id <项目UUID> --data-dir .runtime/project-demo --json
node dist/cli/main.js project-track add --input entry.json --data-dir .runtime/project-demo --json
node dist/cli/main.js project-track documents --project-id <项目UUID> --data-dir .runtime/project-demo --json
node dist/cli/main.js project-track read --project-id <项目UUID> --entry-id <条目UUID> --data-dir .runtime/project-demo --json
node dist/cli/main.js project-track query --project-id <项目UUID> --as-of-version 1.0.0 --keywords knowledge --limit 5 --data-dir .runtime/project-demo --json
```

entry.json示例（替换为真实UUID）：

```json
{
  "projectId": "项目UUID",
  "resourceId": "原件资源UUID",
  "title": "首个项目基线",
  "role": "baseline",
  "projectVersion": "0.0.3",
  "stage": "confirmed",
  "requestId": "baseline-003",
  "tags": []
}
```

create返回Organization；list返回Organization[]；get使用projectId。add返回{projectId,entry,replayed}。read使用projectId+entryId，可加asOfVersion，返回{entry,text,matchReasons,replacement:{replacedBy}}。documents返回元数据分页，不含text。

query输入projectId必填；可选asOfVersion、tags:string[]、keywords:string[]、includeBaseline、offset、limit。API数组严格校验，CLI单一标签/词字符串可作为一个条件，多项用JSON数组。标签按快照id/name/alias归一化精确匹配，关键词按快照归一化子串匹配；条件类内OR、类间AND。

先在该项目内限定asOfVersion，再匹配、排序和分页。替代标注基于整个asOf eligible域，即使替代者不匹配查询条件也标注；未来版本的替代者不能污染历史视角。标注包含替代者entryId、stage及scope/effect，不声称条目已失效。

返回{projectId,items,total,offset,limit,hasMore,baseline,baselineEntryId}；items每项包含完整text与entry、matchReasons、replacement。默认limit=5，最大20，offset非负整数。total/hasMore仅计实际匹配集。没有tags/keywords条件默认带基线上下文，有条件默认不带，可显式覆盖includeBaseline。基线取asOf范围内排序最高baseline；stage不增加隐式优先级，因此planned高版本仍明确planned。baseline独立完整上下文不占分页，若已在items则baseline=null、baselineEntryId指向对应条目，避免正文重复。

create/add可写；list/get/documents/read/query由核心CLI只读打开，不刷新队列，不写初始化marker。参数失败exit2/INVALID_ARGUMENT，业务冲突或固定原件错误exit1，成功exit0。PPC通用命令转发可复用，不需要专门PPC实现。

## 作者实测

2026-11-11本地运行：

```powershell
npm run build:core
node --test dist/plugins/project-tracking/project-tracking.test.js
```

结果：5/5通过。覆盖原始JSON/BOM完整性、标签改名与别名冻结、关键词包含匹配、旧版本unknown/显式known-empty、当前future content分区不影响已pin读取、requestId跨资源更新重放/冲突、同请求并发去重与8项并发无丢失、版本优先日期、分页与基线去重/asOf范围、过滤未命中替代者仍标注、跨项目拒绝、损坏JSON/未知格式/非法日期与参数、回收站正文读取、purge引用保护、备份恢复和future项目schema拒绝。

真实子进程CLI还验证5只读命令在writer持锁时全数据目录文件hash+mtime不变；缺projectId、错误布尔值、非法offset、小数limit、对象关键词数组全部exit2。未调用任何模型、未读取真实凭证。独立复核与集中全套结果以本版本执行记录为准，不把局部测试冒充发布验收。
