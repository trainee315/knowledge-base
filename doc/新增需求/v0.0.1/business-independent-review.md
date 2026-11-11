# 业务插件独立复核

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

复核日期：2026-11-10。复核者未参与业务插件实现；本轮只读业务源文件，没有修改业务作者文件。当前知识库尚未出现在 codebase-memory 已索引项目中，结构核查采用目标源文件回退；范围是 scheduler、tasks、relations、organizer、tags、systems 和共享参数转换。

通过独立 `review-probe` 插件显式声明依赖获取公开 API，使用真实 CoreManager、PluginHost 和临时文件数据运行；没有模型付费调用、系统调度或 PPC 服务管理。每个场景独立数据目录，结束后关闭宿主并删除临时数据。

可重复运行：

```powershell
npm run build:core
node artifacts/business-review.mjs
```

修复前观察结果保存在 [business-review-before-fixes.json](../../../artifacts/business-review-before-fixes.json)，当前复跑结果为 [business-review-result.json](../../../artifacts/business-review-result.json)，复现脚本为 [business-review.mjs](../../../artifacts/business-review.mjs)。以下为首轮复核发现，作者修复后的复核状态另行补充。

## 首轮发现（四项均已修复）

1. **调度失败或超时仍标记整日完成（高）**。`scheduler.run` 在 `organizer.run` 返回 failed 或预算中断时，仍无条件写入 `lastDate`。实际注册失败处理器或 5ms 超时处理器后，04:00 tick 返回 `failed:1, completed:0`，状态却为 `lastDate:2026-11-11`；04:10 再次 tick 返回 `not-due`。当天积压任务不能通过 tick 自动继续，需要区分尝试日期与成功完成日期，并在失败/预算耗尽时保留可重试状态。[scheduler/index.ts](../../../src/plugins/scheduler/index.ts)

2. **超时处理器与重试并行，迟到写入可以覆盖新结果（高）**。任务超时由 `Promise.race` 返回，但旧 handler 仍在运行；runner 立即释放批次标志，也允许 reset 和 retry。同一输入下，旧 handler 等待 500ms、新尝试等待 1ms、任务超时为 100ms，二者都通过正式受控存储写入：重试完成后 effect 为 call2，旧 handler 结束后 effect 被覆盖为 call1，队列却仍记 completed/result call2。复现使用未遵守 AbortSignal 的扩展处理器，不声称当前内置 organizer 的所有路径都能触发；但任务公共接口缺少处理器隔离或未终结执行的重试阻止。建议超时后隔离未完成尝试，阻止同任务/批次重入，且继续保护 checkpoint。[tasks/index.ts](../../../src/plugins/tasks/index.ts)

3. **评分 provider 身份可错记（中）**。`relations.score` 使用可变 provider 引用，await 期间将 P1 切换为 P2，返回的 P1 分数和 reason 被标记为 P2 的 id/version 并保存。真实复现结果 `provider.id:review-new`，score reason 却是 `old-provider`。应捕获调用时 provider 和处理器输入快照，结果提交前检查输入仍有效，避免伪造来源和合并错误版本。[relations/index.ts](../../../src/plugins/relations/index.ts)

4. **非法参数类型被忽略或转换成其它含义（中）**。`schedule configure` 传 `{enabled:"false",time:123}` 成功返回原配置，没有报告参数错误；`task run` 传 `maxTasks:1.5` 实际执行 2 项；查询 `filename:[{unexpected:true}]` 被转为字符串而正常返回。共享转换和各命令需要明确区分 CLI 数字字符串与 JSON 布尔/数组/对象，计数与分页必须为非负整数；显式无效输入不能当作“没有传”。[shared.ts](../../../src/plugins/shared.ts)、[scheduler/index.ts](../../../src/plugins/scheduler/index.ts)、[tasks/index.ts](../../../src/plugins/tasks/index.ts)

## 已验证保护

- 人工拒绝后自动接受返回 `applied:false`，人工接受后自动拒绝同样被阻止，原人工决定保留。
- 标签 revision 或资源 contentVersion 变化后，旧 candidate/判断被 `STALE_INPUT` 拒绝。
- 评分 provider 升级后旧候选提交已由作者并行修复，观察到 `STALE_INPUT: 候选处理器已升级`，本项不再作为未修复发现。
- 体系父节点不存在、父子循环均被拒绝；添加节点后产生资源正式引用，清空节点后引用被清理；存在资源对体系的入向引用时，体系删除被核心阻止，清理关联后可删除。

本轮验证为上述范围的行为复现，不能替代完整插件状态机审计。任务迟到写入场景特别区分了扩展处理器不响应取消与内置处理器的实际防护，避免将理论风险描述成已复现的内置业务覆盖。

## 作者修复后的独立复验

2026-11-10，作者完成四项修复后，重新编译并使用同一复现脚本、真实核心/插件及临时数据运行，8 个场景全部通过断言。修复前 JSON 已单独保留，当前 JSON 为修复后证据。

- failed/timeout 时保存 `lastAttemptComplete:false`，不写成功 `lastDate`；同日再次 tick 确实继续触发。
- 超时处理器未结束时 retry 返回 `TASK_DRAINING`，run 返回 `processed:0, stopped:attempt-draining`；等待旧 handler 结束后重试成功，最终正式 effect 和 task result 均为 call2，没有旧尝试覆盖新尝试。
- await 期间切换 provider 返回 `STALE_PROVIDER`，旧评分未写入正式结果。
- `time:123`、`maxTasks:1.5`、对象 filename 均明确拒绝；CLI 形式的 `enabled:"false"` 则明确应用 false，不再静默忽略。
- 人工双向保护、旧资源/标签/provider 输入拒绝、体系父子与删除引用保护继续通过。

任务超时采用同进程未完成尝试隔离。扩展 handler 必须 await 自身全部工作，不能脱离返回 Promise 留下后台写入；不响应取消且永不结束的 handler 需要退出该进程后按队列状态恢复。首期不承诺强制中止任意第三方 JavaScript。
