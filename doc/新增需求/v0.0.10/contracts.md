# v0.0.10 CLI 与链路契约

适用当前候选实现，正式版本号仍为 0.0.5。本版不增加 MCP。

## 调用与帮助

```powershell
node "D:/project/knowledge-base/dist/cli/main.js" transcript run --help --json
node "D:/project/knowledge-base/dist/cli/main.js" recall prepare --help --json
node "D:/project/knowledge-base/dist/cli/main.js" recall config get --data-dir "D:/knowledge-data/example" --json
```

复杂输入使用 UTF-8 JSON 文件或 `--input -` 标准输入；命令行覆盖 JSON，执行预算覆盖实例配置。`dataDir` 可以随 JSON 输入，显式 `--data-dir` 优先；Agent 接入建议始终显式指定。缺失目录值、非法数字/布尔值、未知 transcript/recall 字段和额外位置参数返回 `INVALID_ARGUMENT`，退出 2，不连接业务服务执行。`--help` 在读取输入文件、等待 stdin、连接服务及执行 workload 之前返回，不要求模型或服务在线。

输出为单个 JSON；成功 `{ok:true,data:...}`，错误 `{ok:false,error:{code,message,details?}}`。退出 0 表示调用成功，1 表示执行失败，2 表示参数错误。业务完整性仍需检查下面字段。

## 压缩到写入

- `id` 或 `alias` 定位转录组织；`sessionId` 定位源会话。run/retry/backfill 解析 alias 后仅转发已解析 ID；同时传 id/alias 仍拒绝。configure 使用 id 定位，alias 表示改名。
- preview/run/backfill 支持一次性 sessionId、preprocessing、maxCalls、maxSessions、maxInputBytes、maxChunkBytes、maxDurationMs、to；preview 可提供 from 预览回填，backfill 必须提供 from。这些覆盖不改持久配置。
- 单 session 与实例目录、include/exclude 取交集。未知、被排除、目录不符、子会话、截止点外和活跃轮次分别记录 skip，不自动改为全项目运行。已完成轮次可以写入，但同 session 还有活跃轮次时 complete=false。
- preview 返回 cutoff、scope、effective、candidates、skips，零模型调用、零任务写入。把 cutoff 传给 run.to 固定截止点；这不锁定后续源文件。
- retry 只处理已冻结任务，允许 id/alias/sessionId 及 maxCalls/maxSessions/maxInputBytes/maxDurationMs，拒绝 from/to/preprocessing/maxChunkBytes。旧任务继续使用原 prompt/schema/输入，已保存模型结果可零调用恢复。
- `transcript status` 返回安全详情投影：config、revision、cronRevision、status.running/pending/failed/skips/records 等；不返回冻结全文。pending 与 failed 分别表达未执行和失败任务。

run/retry/backfill 的结果包括：

- `calls/saved/records`：本次实际调用、写入数，以及 resourceId/sessionId/taskId/cutoff。
- `remaining`：本次选择范围内未完成任务数；`organizationRemaining`：组织全部未完成任务数。`deferred` 是已有任务超出本次 cutoff 的数量。
- `complete`：选择范围内任务完成且不存在影响完整性的 skip/错误。remaining=0 不能代表完成全部源材料。
- `scope/cutoff/effective/processedTasks`：请求范围、实际预算及已尝试任务；retry 顶层 cutoff 为 null，具体边界在每项任务中。
- `stopReason/nextAction/skips/failures`：预算、活跃轮次、范围不符、失败及恢复建议；nextAction 是提示，不是自动执行。

部分失败返回非零退出码、`TRANSCRIPT_FAILED`；`error.details` 保留上述完整结果和失败 task/session。先检查 saved/records 再恢复，不重新生成已成功部分。任务尚未冻结的材料要在后续 run 中发现，retry 不会扫描新增材料。

## 召回与续取

recall 的 `scope.projectId` 是登记的召回项目；与组织 UUID、源 sessionId、resourceId 不同。`recall config get` 只读取得完整配置及 revision；configure 按 expectedRevision 合并更新并保留其他映射。组织显式映射后，新转录记录继承范围；projectDir 本身不能代替登记。

recall read 直接读取固定原件，不依赖索引或模型。list 只读元数据，带 query 时执行全文筛选；search/prepare 的 retrievalMode 为 lexical、semantic 或 hybrid。查询不隐式建索引或下载模型；检查实际 stages、warnings、gaps、status。

- read 被裁剪：`continueCommand="recall read"`，将 `continue` 原样作为下一次输入。从最早遗漏片元开始，保留 scope/version/contentHash/splitter/section/endOffset；endOffset 为排他上界。
- list 有后续条目：`continueCommand="recall list"`，continue 保留 query、sort、direction、offset、limit、scope、snapshotFingerprint 与预算。资料/映射快照变化返回 `CONTINUATION_STALE`，从首页重新定位。
- search/task 的已选证据被裁剪：`continuations` 每项包含 command/input，分别读取对应固定资源区间。不能只读第一项；也不承诺遍历所有候选或整个库。
- 预算连一个完整片元/条目及定位信息都放不下时返回 `OUTPUT_BUDGET`；不会返回无进展的无限续读页。适当增大 maxBytes/budgetTokens 或缩小请求范围。
- 固定正文 hash 或切分身份变化返回 `CONTINUATION_STALE`。删除、范围撤回仍优先生效，续读不会绕过当前访问范围。

默认 maxFragments=6、maxBytes=12000、budgetTokens=3000；实际字节上限取 maxBytes 和 budgetTokens×3 的较小值。计量包含 JSON 包装与定位元数据，不能只按正文长度判断。

## 索引迁移

tokenizer 从 `nfkc-cjk-bigram-1` 升为 `nfkc-cjk-bigram-2`，区分汉字与拉丁边界，保留完整错误码、版本和路径，以及必要子词。单独查询复合标识符时要求完整标识匹配，避免相似错误码误召回。

旧索引的 status 显示 tokenizerCompatible=false、ready=false、stale=true，检索返回 `INDEX_TOKENIZER_MISMATCH`。显式重建：

```powershell
node "D:/project/knowledge-base/dist/cli/main.js" recall index build --vectors --data-dir "D:/knowledge-data/example" --json
```

需要向量时必须保留 `--vectors`。不带该参数会发布不含向量的新代次；覆盖已有向量代次时结果明确警告。模型与实际编码输入未变化时复用向量缓存，原始摘要和成功覆盖不重写。新写入资源应分别核对“scope 可见”“read 可读”“索引已更新”“查询命中”。

## 接入实例

执行 `npm run demo:agent` 生成双项目隔离示例、真实 ID、请求文件和项目提示词，默认完全离线。真实模型及真实 Agent 的复现与限制见 [验证报告](verification.md)。
