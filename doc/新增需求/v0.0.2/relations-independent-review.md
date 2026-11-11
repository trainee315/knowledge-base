# v0.0.2 关系与任务独立复核

复核人为agent基础设施作者，未编写本轮relations/organizer/tasks业务实现。仅本地mock，未读取用户凭证、未真实模型调用，未改业务作者源码。仓库未索引，已按codebase-memory检查覆盖后回退目标源码与公开API反证。冻结v0.0.1文档和证据未修改。

## 发现及关闭

新TaskRegistration.prepare在预算检查前执行本地估算，但原实现只在prepare前检查批次时限。独立临时探针使用纯本地prepare延迟60ms、maxDurationMs20ms，实测98ms后仍handlerCalls1/result.calls1/completed1，可能在批次时限已耗尽后发付费请求。

已反馈业务作者，作者在prepare返回后、预算预留与running状态写入前再次检查时限，增加慢prepare回归。原同等参数独立复验结果为handler0/calls0/stopped=time-budget，问题关闭。prepare仅允许本地get/plan，不请求模型或提交业务结果；当前organizer.prepare符合约束，关键词提取在reconcile正常流程完成。

## 独立反证证据

可重复命令（先构建，脚本只用编译产物）：

```powershell
node artifacts/verification/v0.0.2/relations-independent-review.mjs
```

[脚本](../../../artifacts/verification/v0.0.2/relations-independent-review.mjs)、[原始结果](../../../artifacts/verification/v0.0.2/relations-independent-review.log)。使用真实CoreManager/PluginHost和可替换mock provider，临时目录结束时按绝对路径/归属校验清理。模型计数3均为本地fake invoke，不是DeepSeek请求。

- 标签文件按tagId串行，跨profile/logic scope也共享该锁。先已有scope1(alpha/zero)，scope1(beta)在途切换scope2(gamma)：beta旧结果STALE拒绝且不写coverage，alpha/zero旧scope保留，gamma新scope追加，两个scope同时存在，没有read-modify-write丢失。
- 零分只有归一化coverage，scores只含正值；timeout/env引用修改不改变语义scope，重复gamma为0新请求。provider实际canonical别名不误判配置切换。
- 收费任务排队首、maxCalls0时保持pending，后面的免费缓存任务仍completed；obsolete任务completed但不dispatch；非法prepare估算failed且不dispatch。
- 慢prepare跨过批次时限后不dispatch、不预留次数；重新打开宿主，completed/failed及仍需付费pending任务在0预算下均无重复dispatch。
- 原始v001零分记录与future cache99并存时，完整迁移预检先失败，legacy文件仍原样，future也未覆盖；移除future后显式恢复刷新把legacy ZERO转归一zero coverage、scores空，模型计数不增加。

源码同时确认：score所有批次结果完整/唯一/有限0..1且reason有效后才一次提交scores+coverage；失败、取消、缺失或重复结果不写半覆盖。scopeKey包含tag UUID、显式logicVersion、provider/model/生成语义hash与prompt/schema版本，不含profileRevision/凭证/超时。人工决定仍由tags原保护逻辑维护，旧content/tag/provider候选拒绝；这些还由原业务与独立HTTP集成回归覆盖。

## 边界

Task队列结构未新增强制持久字段，prepare为可选注册能力，旧任务重启继续兼容；原超时未终结尝试隔离、retry/checkpoint逻辑仍保留。maxRequests按预留次数给score硬上限，防止分批配置竞态；maxCost沿用任务声明估算，不是供应商实时美元账单硬上限，estimatedCost0不表示免费。整个复核未测试真实费用。

此为任务相关范围反证，不等于任意第三方handler的强制沙箱；未知handler脱离返回Promise的后台工作仍不在保证内。最终全回归结果见本目录execution与v0.0.2验证输出，不复写旧版证据。
