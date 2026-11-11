# v0.0.3 执行记录

状态：源码已冻结，实现、集中回归及独立最终验证已完成，待用户验收；未暂存、提交或推送003。2026-11-11已先完成002发布，远端main与v0.0.2 peeled为b8e3fbefa10602461da3477e4db83e0b0dade822，之后才创建003分支。

## 所有权

- 主agent：协调、方案与验收，不直接编写业务。
- core：content/keywords只读版本派生与其tests，公共契约、package/lock/CLI版本、只读分类、组合注册、共享配置、根入口与本目录四正文，随后独立审查project插件。
- business：src/plugins/project-tracking生产实现与tests、项目组织权威结构/参数、专属实现记录；不写共享入口。
- ui：独立tests/project-tracking、examples/project-tracking、非付费PPC/浏览器必要回归、验证证据和专属复核记录。

## 阶段与状态

1. 002门禁：已完成。正式002实现ca79363b5907c4a5ab1052dd17a76b95ef997e98、档案b8e3fbefa10602461da3477e4db83e0b0dade822，远端main/tag已由core与主agent分别核验，003开始前工作区干净。
2. 分支与契约：已完成。`git switch -c feat/v0.0.3-project-tracking` exit0，已给两位同伴branch-ready。graph index/coverage均返回本仓库未索引，指定content/keywords/contracts/CLI源码回退读取，不建立新索引。
3. 只读助手：已实现并完成作者专项3/3。固定cv/hash/历史扩展/原文、纯关键词归一化已落盘。包/CLI改003-dev，002归档与证据保持冻结。
4. 项目插件：已实现并source-freeze，组合入口已注册projectTrackingPlugin，作者5项通过。append不可变、首次baseline、replacement仅记录、数值version/asOfVersion、日期次级、全文limit默认5/max20、requestId显式输入先查幂等、快照tags/keywords/parser、历史标签unknown、全历史refs、MD/TXT/JSON parsed才登记。专属记录见[作者实施记录](./project-tracking-implementation.md)。
5. 集成与独立反证：core独立probe7组通过；发现新命令shared参数转换exit1而非2，已交作者在插件内修复，原探针复验exit2/INVALID_ARGUMENT且原7组仍过，该发现关闭。细节见[独立复核](./project-independent-review.md)。未修改作者生产源。
6. 严格串行验证：已完成。第一轮完整npm test70项69过1失败，旧组织方式测试硬断默认3种而新增项目方式后4种；原测试作者更新4处预期并增加handler/备份断言，保留既有覆盖，生产无变更。失败日志保留test-first.log。重新严格串行typecheck exit0→npm test70/70 exit0（11142.454ms）→npm run build exit0；正式日志见artifacts/verification/v0.0.3/{typecheck,test,build}.log。已通知ui只使用最终dist做独立JS/浏览器/PPC，不再build。禁止额外真实API调用，002活动账本closed。
7. 文档与交付：已完成003候选文档与[总验证JSON](../../../artifacts/verification/v0.0.3/summary.json)。003只交开发候选及实际证据，保留002当前已发布状态，不commit/push/tag，不提前归档003。

## 验证证据

助手初轮已执行`npm run typecheck` exit0、`npm run build:core` exit0、`node --test dist/plugins/content/version.test.js` exit0，3/3通过，耗时671.6985ms。覆盖固定历史hash/原文BOM与CRLF、JSON/TXT/未知格式、invalid UTF8、future content schema、纯关键词/归一化、readonly全文件hash不变。上述3项已再次包含在最终70项回归中。

作者专项首次2/3：离线夹具误将extension写成`.md`，触发核心合法格式校验；改为仅将当前originalName改为new.md而保持合法extension/history后重跑3/3。Core schema强制历史扩展与资源extension一致，本轮不扩大核心模型；助手仍显式取history.file扩展，防当前名称误导。

ui使用最终dist完成独立项目9/9（independent.tap，5539.5144ms）、真实Chrome10插件/33资源/8截图（browser/browser-result.json）、固定PPC入口help0.0.3-dev与原2/2测试（ppc.tap，532.2917ms）。保留演示库6资源7条目，以真实已发布v0.0.2 tag/commit作为baseline，验证query默认5条、独立baseline、数值0.0.10优先、asOf、固定cv1而current2、request重放和快照，见demo-ppc.json；默认不启服务，外部请求0。全部新增证据在003目录，历史证据不变。

最终Git边界：git diff --check exit0；doc/v0.0.1、doc/v0.0.2及旧验证证据diff为空，git index无暂存。CIM按本轮browser/preview/project demo/独立测试/core probe命令筛选Node进程，匹配0；集中测试及构建均已结束，不清理不属于本轮的其他进程。
