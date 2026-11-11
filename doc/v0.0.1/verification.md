# v0.0.1 验证与边界

按2026-11-11用户“完成0.0.1版本并推送”指令归档发布；自动验证及独立复核已通过。2026-11-10冻结实现证据与本次发布检查分开记录，避免把历史基准当作新的性能承诺。实现提交为 `0cb29d69b5ddf4c4284e702e7d85e7d889a7d956`，见 [版本历史](../version-history.md)。

## 冻结验收证据

Windows、Node24.11.0、npm11.6.1。严格串行typecheck、npm test、npm build通过；**34/34测试**含14核心、1CLI、11业务、3组织方式、5预览。真实Chrome test:web验证33资源、8插件、8截图；PPC转发测试2/2。原始输出见 [artifacts/verification](../../artifacts/verification/final-summary.json)。

已验证多文件故障注入redo恢复、真实journal中间态读取等待、8进程单写竞争、alias与SIGKILL后恢复、备份规范路径/schema/hash/引用/内部junction预检、未知分区保留、未来版本拒绝、失败依赖与重启load阻断、组织owner保护。业务覆盖人工接受/拒绝、旧content/tag/provider拒绝、超时重试隔离、同日未完成继续及AND/OR分页。预览覆盖只读/Origin/Host/控制令牌、UUID链接图片、HTML转义、下载、全插件停用降级、大小写/junction别名实例互斥。

独立复核发现的六类核心、四类业务与预览alias问题已逐项修复并用原反例复验，见 [核心复核](../新增需求/v0.0.1/core-independent-review.md)、[业务复核](../新增需求/v0.0.1/business-independent-review.md)、[预览/PPC复核](../新增需求/v0.0.1/preview-ppc-independent-review.md)。完整历史执行记录见 [execution](../新增需求/v0.0.1/execution.md)。

## 规模证据

最终安全祖先检查版本1000个合成Markdown资源实测：导入21346.48ms、热分页offset900/limit50为9.11ms、reindex13.55ms、check909.83ms、冷只读分页147.25ms，全部valid=true，见 [原始基准](../../artifacts/verification/final-resource-benchmark.log)。

既有1000任务基准为10批、1重启、全部完成、重复0，入队9231ms/总32166ms；运行早于最终祖先检查与组织方式补齐，仅证明当时恢复行为及性能，不冒充最终性能。未重复无关大基准。

## 发布检查

本次重新执行typecheck exit0、npm test（含构建）34/34通过，测试耗时8568.30ms，见 [release-typecheck.log](../../artifacts/verification/release-typecheck.log)、[release-test.log](../../artifacts/verification/release-test.log)。未重跑无改动大基准。Git发布只提交实现、文档、示例、精选证据和可分发集成材料，不提交node_modules/dist/数据/缓存/密钥/.codex。本地PPC仓库不在本次Git发布范围。

独立发布复核使用无hardlink的干净临时clone，detached检出实现提交0cb29d6：npm ci通过（99packages/audit0），typecheck通过，npm test含core/web构建34/34通过，package与锁文件无变更；同一干净检出再验证PPC补丁临时apply、真实help转发、2专属测试通过，原外部PPC index与文件未改。原始日志：[npm ci](../../artifacts/verification/release-clean-npm-ci.log)、[typecheck](../../artifacts/verification/release-clean-typecheck.log)、[test](../../artifacts/verification/release-clean-test.log)、[PPC patch](../../artifacts/verification/release-clean-ppc-patch.log)。发布材料逐文件复核无凭证、禁入路径或相对链接阻挡。

## 尚未支持

OCR、PDF/Office等复杂正文解析、向量检索、付费模型执行、独立Codex运行时、远程插件/热加载和真实系统夜间任务均未实现。默认词汇评分只召回候选，不代表语义归属质量。新结构迁移有接口和版本保护，本版本没有历史核心meta升级样本。

预览只读，插件启停为启动快照；恢复只支持空目标，不覆盖合并。未验收断电、磁盘满、硬件故障、网络共享盘、多主写入、长期负载及全平台兼容。超时扩展handler必须await全部工作，未终结尝试被隔离；不承诺强制中止任意脱离Promise或永不结束的第三方JS。发布不包含npm包、PPC打包、付费调用或系统调度注册。
