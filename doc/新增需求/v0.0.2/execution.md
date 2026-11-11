# v0.0.2 执行记录

日期2026-11-11。发布收尾更新：用户已指令实施“先发布002，再开始003”。实现提交ca79363，CLI正式0.0.2，跨kind引用保护三回归及完整62/62通过；归档见 [doc/v0.0.2](../../v0.0.2/readme.md)。以下59项/0.0.2-dev/未提交等为开发冻结时的历史记录，不再是当前发布状态；001旧档案证据不改。

## 所有权与阶段

- core：src/agent通用types/service/schema/profile/DeepSeek adapter/错误、src/plugins/agent、组合入口、CLI接线、package/lock与本目录四文档；仅mock，真实API0；另独立review relations/tasks。
- business：relations/organizer的业务prompt/schema、词对cache与迁移、预算联动，获主负责人授权最小扩展通用tasks.prepare；独立专项及业务记录。
- ui_ppc：src/agent/provider.integration.test.ts、tests/agent外部runner、examples/agent、验证文档与独立审计；唯一真实API负责人；不新增生产UI。
- 主agent：协调、接口裁定和验收，不编码。三方已freeze生产源码，后续仅汇总文档/证据。

按codebase-memory先查list/index/coverage，本仓库仍未索引，已回退精确源码，未以图缺失宣称无实现。DeepSeek官方首次调用/JSON mode/chat completions文档已核对，明确默认thinking会开启，adapter必须显式disabled。真实凭证仅外部runner临时注入env，infra作者没有读取仓库外密钥值。

## 实际交付

通用AgentApi支持文本与object生成、profiles/身份/状态，不import标签/关键词业务。Provider接口与DeepSeek DTO分离，默认deepseek-default/deepseek-flash/reasoningoff，HTTP显式thinking disabled；不自动重试。profile只存credentialEnv引用及非秘密参数，load/readonly/status/profile/config查询均不联网零写。JSON mode后还检查空白/截断/JSON语法/schema明确子集；业务完整词对/唯一/0..1另校验。

调用启动捕获profile/provider/messages/schema；model保留请求身份，actualModel追踪实际canonical名。configurationHash只含provider版本/model/真正生成参数，不含profileId/revision、凭证引用或值/指纹、timeout/并发。取消与时限覆盖队列/请求，非合作adapter未退出仍占实际并发slot；错误边界不透传原message/cause/响应/凭证。

关系默认offline，agent模式需显式选择；自动任务maxCalls0不请求模型。按tag级串行保护所有scope；归一化词对只补缺项，0仅coverage、正值scores。scope包含tag UUID、显式logic/provider/model/生成语义/prompt/schema版本，不含tagRevision；定义变化仅追踪/warning不自动重评。profileId/revision只追踪。v001已知lexical可复用，未知旧规则进入legacy scope，futurecache拒绝迁移。全批验证后才写，无半覆盖；人工最终决定仍独立保护。

任务prepare仅本地get/plan重估，过期可不收费完成；收费队首不阻免费缓存任务。prepare跨时限不能dispatch；exhausted旧scope可obsolete而不加attempt/费用，有效exhausted仍不dispatch。次数预留及score maxRequests为硬次数保护；maxCost只按声明估算，不是供应商实时美元硬上限。

## 独立反证闭环

core发现prepare60ms/batch20ms后仍dispatch（旧实测98ms、handler1/calls1），作者补prepare后time-budget检查；同反例已关闭。另反证跨scope共享tag文件不丢旧scope、在途旧scope拒写、zero稀疏覆盖、传输配置复用、0预算收费队首后免费可推进、prepare失败/obsolete不dispatch、重启0预算不重复付费、futurecache全量迁移写前停止、legacy0转coverage无模型。见 [独立review](./relations-independent-review.md)及 [脚本/输出](../../../artifacts/verification/v0.0.2/relations-independent-review.log)。exhausted淘汰角落由作者专项回归及最终suite覆盖，源码已独立复核。

ui对infra/CLI/profile独立13项mock审计无待修：transport/JSON/空白/length/schema/4014295xx、取消与排队/并发、provider替换、readonly/profile/备份无key；已确认status探测异常和配置存储错误脱敏、READ_ONLY固定码、model/actualModel边界。详见 [agent验证](./agent-verification.md)。

## 最终严格串行验证

等待所有生产修改结束，每个命令实际退出后才启动下一条：

完整机器结果见 [final-summary.json](../../../artifacts/verification/v0.0.2/final-summary.json)，其中明确本轮完成待验收、未发布、59/59与真实3次账本closed。

- `npm run typecheck` exit0：[final-typecheck.log](../../../artifacts/verification/v0.0.2/final-typecheck.log)。
- `npm test` exit0：**59/59**（34旧版回归+19 agent/独立HTTP+6 relations/tasks），9213.47ms：[final-test.log](../../../artifacts/verification/v0.0.2/final-test.log)。
- `npm run build` exit0，Vite32模块，JS183.79kB/gzip74.82kB：[final-build.log](../../../artifacts/verification/v0.0.2/final-build.log)。
- ui随后mock13/13、9插件/33资源真实Chrome、PPC2/2及knowledge help0.0.2-dev通过，新浏览器证据仅 [v002/browser](../../../artifacts/verification/v0.0.2/browser/browser-result.json)。
- 离线实际key精确扫描当时310文件0匹配，备份逐entry解码和5类CLI stdout/stderr无key；网络封锁probe外部0请求：[secret-audit.json](../../../artifacts/verification/v0.0.2/secret-audit.json)。

所有新日志/summary在artifacts/verification/v0.0.2，不覆盖v001final-*或artifacts/preview。未重跑无变动大基准。验证进程均已退出，ui确认没有本轮preview/browser/live/audit Node残留。

## 受控真实验证

仅ui统一执行，共3请求（text/JSON/relation各1），均使用synthetic材料、deepseek-flash、非思考、有限token。共462tokens：输入386、输出76。关系第二次命中cache，0新请求；只保存脱敏usage/计数/状态，不保存模型正文或reasoning。账本已closed，剩余额度不使用，后续不得追加真实请求。infra与business作者真实API0。

## 局限与接续

不是自主Agent运行时：无工具自主执行/规划/记忆/流式/第二真实provider/实时账单计量。schema是明确子集，未知规则网络前拒绝；任意非合作第三方JS不承诺强杀。费用上限按估算，真实3次不等于大规模生产质量。等待用户验收后再决定发布；本轮不进行Git提交/推送/标签或新版本归档。使用入口与安全环境说明见 [contracts](./contracts.md)，业务细节见 [relations记录](./relations-implementation.md)。

## 发布收尾（后续用户实施指令）

用户已授权先归档提交/tag/push002，再开始003，取代上文开发阶段的暂不发布约束。纯CoreManager临时库真实复现同UUID跨kind引用双向漏保护，已修kind+id排除自身；新增3回归保留历史和真正self语义，发布全测62/62。CLI正式0.0.2，PPC补丁验证器改读目标package版本，不改原patch或外部PPC工作区。

实现提交 `ca79363b5907c4a5ab1052dd17a76b95ef997e98` 已被独立无hardlink临时clone审计：npm ci99包/audit0、typecheck、62/62、双向引用/历史/self probe、PPC补丁apply+help+2tests均通过，clone工作区干净且package/lock无变。发布浏览器9插件/33资源、正式help/PPC2通过；331文件精确key扫描0、外部请求0，真实账本仍closed3。新证据均在 [release目录](../../../artifacts/verification/v0.0.2/release/test.log)，旧001及002开发证据保留。

档案 [doc/v0.0.2](../../v0.0.2/readme.md)、入口/版本历史引用实际实现SHA；独立允许后创建档案commit及annotated v0.0.2，正常推送main/tag并远端核验。003实现必须在002远端核验成功后独立推进，不属于本次发布。
