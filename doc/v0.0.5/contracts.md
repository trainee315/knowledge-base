# v0.0.5 公共契约

所有命令支持 `--data-dir`、`--json`；复杂参数用 `--input UTF8.json` 或 `--input -`。显式参数覆盖 JSON 同名字段。stdout 单 JSON，stderr 日志，退出码0成功、1执行失败、2参数错误。

## 自由记录

`note add --text 正文|--file 文件|--stdin` 三选一。`--stdin` 是正文原始字节，不能和 `--input -` 同时使用。文件/stdin 必须严格 UTF-8，BOM、CRLF、空白原样保存；空白正文拒绝。可指定 title、source、projectDir、recordedAt、tags、requestId；recordedAt 默认当前时间，指定值须带时区，tags 接受现有标签 ID、名称或别名，不自动创建。

标题取显式值、首 Markdown 标题或首非空行。每次独立提交创建资源，相同 requestId 同参数返回原 resourceId/replayed:true，异参 REQUEST_CONFLICT。账本独立于资源删除状态，不会因删除而重建。`note list` 默认排除删除记录，`--include-deleted` 包含；`note get --id UUID` 返回登记版本1的原文。没有 note update。底层 resource get/history/update/delete/restore/purge 仍保留；note 固定原文不随底层更新变化。

## 转录配置

`transcript create --input config.json`；`list`；`get/configure/preview/run/records/retry/backfill --id UUID|--alias 别名`。改名使用 `configure --id UUID --alias 新别名`。别名 NFKC/trim/小写判重，组织 UUID 和历史进度不变。复杂字段使用 JSON。

配置字段：

```json
{
  "alias": "knowledge-base",
  "source": "codex",
  "sourceRoot": "C:/Users/your-user/.codex",
  "projectDir": "D:/project/knowledge-base",
  "additionalDirectories": [],
  "includeSubdirectories": false,
  "startDate": "2026-11-01",
  "timezone": "Asia/Shanghai",
  "include": {"sessionIds": [], "titleKeywords": [], "bodyKeywords": []},
  "exclude": {"sessionIds": [], "titleKeywords": [], "bodyKeywords": []},
  "enabled": false,
  "focus": "",
  "profile": "deepseek-default",
  "maxSessions": 10,
  "maxInputBytes": 200000,
  "maxChunkBytes": 40000,
  "maxCalls": 0,
  "maxDurationMs": 120000
}
```

alias、startDate 必填；sourceRoot 默认当前用户 `.codex`，仅 source=codex。时区默认上海；日期按本时区零点，带时区 ISO 按绝对时间。intervalMinutes 可选正整数；enabled=true 必须有 projectDir 和 intervalMinutes。maxDurationMs 上限300000；模型预算默认0。`run/retry/backfill` 可覆盖 maxCalls/maxSessions/maxInputBytes/maxDurationMs。profile 复用现有 Agent 配置，只保存凭证环境变量引用。

目录按平台路径规则归一化，默认精确匹配，可显式包含子目录，路径段边界避免前缀误匹配。include 不同非空字段 AND，字段内 OR；exclude 任一字段命中即排除。session ID 精确匹配，标题/正文 NFKC/小写子串匹配。正文筛选仅本次新增材料。来源、目录、起始日期、时区、包含/排除范围修改在保存时建立新发现边界，较早材料用 backfill。别名、关注点、profile、预算及周期修改保留边界。已有冻结任务与成功覆盖保留。可选 projectDir/intervalMinutes 用 JSON null 显式清除，省略沿用旧值。

## 来源与执行

适配器识别 rollout JSONL 的 session_meta、turn_context、response_item 和 task_started/task_complete/task_aborted。读取 sessions/archived_sessions；未找到这两个目录时将 sourceRoot 视作夹具/rollout目录。session_index.jsonl 可选，识别 id/thread_name/updated_at，仅提供标题；无标题索引时取 session_meta.title 或首用户行。SQLite 不参与正文读取。

适配器 codex-rollout-2 支持续存检查点文件，用全局 ordinal 定位消息，按 history_base 声明的继承前缀组织同ID片段。检查点之后的旧尾部不纳入新快照，跨片段的同一轮次按turn ID恢复。缺少续存依据或存在分叉的同ID来源明确失败。子会话首先识别并排除，内嵌父会话元数据不会误判成第二个主会话。目录和日期之外的会话不参与当前范围的片段组合。

默认主 session，未知主/子身份明确 SOURCE_FORMAT；推理内容不读取，工具调用/结果用于执行证据；镜像 event_msg 不重复作正文。未知消息媒体格式明确失败。文件尾不完整行延后读取。显式开始但未完成轮次不会仅因静默而处理；无状态事件时静默十分钟。

`preview` 只读返回截止点、session、位置列表、源时间、字节数和跳过原因，不返回原始对话，不调用模型。`preview --from 日期 [--to 日期]` 预览补录范围。`run` 主动执行；`tick` 无定位参数，检查所有启用且到期配置，依次执行同一流水线。到期以执行起点加 intervalMinutes 推算，不安装系统任务、不常驻。`retry` 恢复未成功冻结任务；`backfill --from 日期 [--to 日期]` 补未成功历史，不清除成功覆盖，不重录。to 包含指定时点；日期值表示该日期零点，整日范围请用该日末尾的明确 ISO 时间。

每次执行固定 cutoff 和源读取边界；按完整轮次分段，单轮太大返回 oversized-turn，不截断假成功。必要前文最多前两条消息，计入输入预算，放不下可完全省略。无信息寒暄可跳过并保留原因。session/input/time预算未完成返回 complete:false；maxCalls=0 可冻结任务但不调用模型。

任务保存输入、配置、结果和状态；success消息以位置+内容指纹登记，独立于模型/提示词版本。源成功范围被修改或截断报 SOURCE_CHANGED，不自动改历史。记录正文不覆盖，续录保存 previousResourceId，补录标 backfill。metadata 含范围、指纹、源时间、转录时间、处理/提示词/适配器版本及模型身份。

任务租约330秒，短事务登记/保存结果/原子追加，模型期间释放正式库写者锁；失效令牌不能提交。进程崩溃后租约到期可 retry；已保存模型结果不再调用模型，响应未保存则可能再次调用，但正式记录只提交一次。原子追加包含资源、组织引用、成功范围和事件，重做日志恢复保持一致。失败任务不会被整体时间水位跳过。

转录结构为 title、sections(heading/body/evidence消息位置)；生成和恢复均校验结构/引用，不通过则失败，不使用模板替代。结构校验不能证明语义准确，质量证据单列。

处理器 transcript-2 在发送材料与落库正文边界识别常见凭证模式及当前profile的已知凭证值，并替换为 [REDACTED_CREDENTIAL]。源文件、消息位置和原始指纹继续用于追溯，脱敏不会触发成功历史重录。输出增加严格字段约束，失败保留重试状态。此过滤针对已识别模式，不构成任意敏感内容识别保证。

历史补录的to同时约束来源解析，截止点之后才结束的轮次和之后新建的会话留待后续。可用较大的单段预算处理完整长轮次，调用预算由每次CLI执行显式声明。

## 组织实例可视化配置

组织页的 Session 转录实例提供新建与查看详情，详情包含概览、关联记录和实例配置。配置表单覆盖 CLI 同一字段集合，编辑期间保留草稿。UUID、详情页签与阅读资源通过 #browse 的 instance/view/resource 参数恢复。

开发和构建页面共用以下本地接口。

- GET /api/transcripts 返回实例详情列表，GET /api/transcripts/:id 返回单实例的配置、修订和运行摘要。
- GET /api/transcripts/defaults 返回创建默认值，GET /api/transcripts/profiles 返回 profile ID、模型及凭证配置状态。
- POST /api/transcripts 接收 {config} 创建实例。
- PATCH /api/transcripts/:id 接收 {config,expectedRevision} 保存配置，修订冲突、忙碌、别名冲突或写者锁占用返回409。
- POST /api/transcripts/preview 接收 {id?,config,mode?,from?,to?}，mode 为 incremental 或 backfill。创建前和保存前均可预览，返回候选位置、源时间、规模、跳过原因及草稿/范围变化标识。

写入和草稿预览请求须携带匹配当前页面的 Origin 及 application/json，请求体最多128KiB。保存只在提交期间打开可写会话。草稿预览使用只读宿主，业务数据和模型调用次数均不增加。增量预览对范围修改使用拟保存时点，历史预览使用显式from/to。

详情和组织列表对转录数据使用摘要投影，冻结输入、模型临时结果和租约令牌保留在后端。模型/profile配置仍由已有Agent入口管理，页面选择现有profile。

发生并发修订冲突时页面保留草稿。刷新最新修订会合并未由用户修改的字段，用户实际修改的字段保留草稿值，核对后再次保存。执行状态可通过刷新更新。关联记录复用现有普通资源浏览。
