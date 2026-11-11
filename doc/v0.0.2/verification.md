# v0.0.2 发布验证与局限

按用户实施计划先发布002、再开始003。本次实现提交为 `ca79363b5907c4a5ab1052dd17a76b95ef997e98`，见 [版本历史](../version-history.md)，发布档案由annotated v0.0.2标识。001冻结档案和旧证据保留。

本次发布机器汇总见 [release/summary.json](../../artifacts/verification/v0.0.2/release/summary.json)，旧开发final-summary按原阶段保留。

## 当前发布检查

严格串行执行typecheck、npm test、npm build均exit0，完整 **62/62**（原002的59项加3个同UUID引用回归），测试11338.10ms。ui随后确认Chrome9插件/33资源、PPC正式help0.0.2和原2项、补丁临时apply/转发验证通过；实际key精确扫描331文件0匹配、备份逐项解码/CLI无key、网络封锁外部0请求。见 [非付费汇总](../../artifacts/verification/v0.0.2/release/nonpaid-summary.json)及 [测试原始日志](../../artifacts/verification/v0.0.2/release/test.log)。不覆盖原002开发证据或001final-*。

跨kind缺口先使用纯CoreManager临时库复现：组织→资源、资源→组织两个方向均漏保护，见 [before](../../artifacts/verification/v0.0.2/release/cross-kind-before.json)；修复后均REFERENCED，见 [after](../../artifacts/verification/v0.0.2/release/cross-kind-after.json)和 [可重复探针](../../artifacts/verification/v0.0.2/release/cross-kind-repro.mjs)。三项回归另外验证全部历史版本受保护，以及真正selfref不误拦删除。探针无HTTP调用。

原开发冻结证据59/59、独立HTTP13、Chrome9插件/33资源、PPC2及key精确扫描0匹配保留于 [开发执行记录](../新增需求/v0.0.2/execution.md)、[Agent独立验证](../新增需求/v0.0.2/agent-verification.md)、[关系独立复核](../新增需求/v0.0.2/relations-independent-review.md)。发布时只进行必要非付费回归，不重新运行真实模型。

## 独立干净检出

业务负责人无hardlink临时clone并detached检出实现ca79363：npm ci exit0（99包、audit0），typecheck exit0，完整62/62；双向跨kind、历史保护与self独立probe通过，CLI正式0.0.2。PPC验证使用独立输出路径，临时基线apply/help/2tests通过、原外部index/源文件未变；clone工作区干净、package/lock无diff。未读取真实key或调用模型。

原始证据：[npm ci](../../artifacts/verification/v0.0.2/release/clean-npm-ci.log)、[typecheck](../../artifacts/verification/v0.0.2/release/clean-typecheck.log)、[62项测试](../../artifacts/verification/v0.0.2/release/clean-test.log)、[引用probe](../../artifacts/verification/v0.0.2/release/clean-cross-kind.log)、[PPC](../../artifacts/verification/v0.0.2/release/clean-ppc-patch.log)。没有重跑无变动大基准。

## 真实请求账本

沿用已关闭campaign：3次synthetic请求（text/JSON/relation各1），共462tokens=386输入+76输出，非思考，第二次关系调用0新请求。没有保存响应正文、reasoning或密钥；剩余次数不使用。发布阶段不追加真实API调用。

## 仍不包含

自主工具执行、规划/记忆、完整Agent运行时、第二真实provider、实时美元账单硬界、OCR/复杂正文解析、向量检索与系统调度注册均未实现。JSON schema为明确子集；任意第三方非合作JS不承诺强制终止。真实3次成功不是长期质量或费用承诺。001已有单机/单写者/空目标恢复等边界继续适用。

项目跟踪、按版本只读派生等属于003规划，不因本次发布而成为已实现能力。本次不提交外部PPC仓库、不启动PPC服务、不进行PPC打包。
