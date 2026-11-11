# 项目插件独立复核（core）

范围：src/plugins/project-tracking及CLI公共接线；复核者不是项目插件作者。未调用真实API，未修改作者生产源。图coverage返回本仓库未索引，按指定index/types/validation源码回退阅读，非全仓库安全审计。

## 已复现发现

新CLI命令原复用shared.required/boolean/number转换会抛普通Error：`project-track query`输入`includeBaseline:"garbage"`实际exit1、EXECUTION_FAILED，参数错误应exit2。已反馈business作者在插件内采用local转换修复，未改shared。最新版dist用同一探针复验exit2、INVALID_ARGUMENT，原7组全部仍通过；该发现已关闭。

## 实测反证

`node artifacts/verification/v0.0.3/core-project-probe.mjs` exit0，7组检查通过，结果见[原始JSON](../../../artifacts/verification/v0.0.3/core-project-probe.json)。探针仅建立合成临时库，全局fetch在请求前封锁，结束关闭宿主并删除临时库。

- 首次baseline省略contentVersion，资源更新后同requestId重放仍为原entry/cv；显式输入变更返回PROJECT_REQUEST_CONFLICT。
- 1.10.0优先于1.2.0，即便日期更旧且stage为planned；旧verified项仍计入total和可读全文。asOfVersion先限制范围，未来替代声明不出现在旧视图。
- 同项目8并发追加后11条唯一entry，无丢失更新；用另一项目读取同entry返回NOT_FOUND。
- 登记后把当前content派生分区改future99，旧条目仍从固定原件返回精确BOM/CRLF原文，不消费最新派生分区。
- writer持锁期间另开readOnly宿主执行documents/read，全部数据文件SHA256前后相同。
- 软删除原资源后历史条目仍可读；purge返回REFERENCED。
- backup/restore后11条记录、原始全文和正式引用仍保留。

语义核对：planned高版baseline只作为上下文，返回stage仍planned，不宣称已生效；replacement只展示声明；标签确定匹配，关键词归一化子串匹配。这些是已确认行为，不作为缺陷调整。

结论：当前复核没有待修发现。source-freeze后集中typecheck/test/build均成功，70/70回归包含002全部62项及003新增8项。边界：probe不是压力测试；无法由此证明任意手工损坏组织数据均可恢复；future schema采用明确拒绝。
