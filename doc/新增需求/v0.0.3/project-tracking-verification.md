# v0.0.3 项目追踪独立验证

状态：候选验收完成，无待修生产问题。使用 core 最终构建的 `0.0.3-dev`，本负责人未提交、推送或打标签。

本负责人不修改 project-tracking/core 生产实现。测试位于 `tests/project-tracking`，使用真实公开 manager/PluginHost/CLI，所有测试进程封锁 fetch，不读取凭证，不调用 Agent 或外部服务。真实 DeepSeek 账本保持 v0.0.2 的 closed/3。

codebase-memory 项目列表、index_status 及目标 check_index_coverage 确认本知识库未索引。先编写公开接口黑盒反例，再回退阅读 project-tracking 的实现/验证、content 和 keywords 目标源码；不将其描述为完整图审计。

重点验证：首条 baseline、append-only/requestId 幂等与冲突、快照不受最新 meta/tag alias/keyword 影响、historical unknown 与显式 known-empty、资源 UUID/cv/hash 固定、同项目 replaces、并发追加、三段版本数值排序与 asOf、先匹配再全文分页、独立 baseline 上下文、回收/引用清理保护、备份恢复、future schema 拒绝、writer 持锁时只读零写。

原文验证使用 MD/TXT/JSON 的 BOM、CRLF、Unicode 和首尾空白，逐字节 hash 与全文比较，不允许 trim/pretty-print；invalid UTF8、invalid JSON、unsupported 登记失败时项目 entries/refs 不半写，原件仍存在。

## 格式边界

v0.0.3 保留核心现有 history/file/extension 约束，不支持同一资源跨格式更新；JSON 改为 Markdown 应导入新的资源 UUID。离线“名称误导”夹具仅修改当前 originalName 为 `.md`，内容和 extension/history 路径仍为合法 JSON，用于证明历史读取依固定版本路径而非最新显示名；不将非法 metadata 当作受支持升级。历史原始文件名不可还原时明确 originalNameKnown=false。

通用预览只展示组织元数据；普通 `kb://resource/<uuid>` 指向资源当前版本，不作为项目历史全文通道。历史全文与基线上下文必须通过规范 project-track read/query 读取。

## 结果

core 串行 typecheck、全套测试 **70/70**、build 均成功后，使用同一 dist 完成以下独立验证，没有再次构建。独立 JS **9/9**（5539.5144 ms），与 70 项全套测试分别统计：

1. MD/TXT/JSON 原文 BOM、CRLF、Unicode、首尾空白和 hash 保持；无效 UTF8/JSON、不支持格式登记失败，entries/refs 不半写且原件仍在。
2. 合法 JSON cv1/cv2/cv3 更新及当前显示名误导，不串用历史格式/正文；旧版 tags unknown 与显式空数组 known-empty 区分；回收后固定版本仍读，purge 被引用保护阻止。
3. 当前标签名称/别名、关键词和 meta 更新不改快照；历史别名与关键词仍匹配，新别名/缓存污染不追溯命中。
4. requestId 在原件版本、标签和服务端时间变化后重放同一 entry、正式文件零变更；显式 payload 不同冲突，同 requestId 跨项目独立；跨项目替代、空范围及不合法 baseline 被拒绝。
5. 同宿主 8 个并发追加不丢失；同 requestId 8 个并发请求仅新增一条。不将此结果扩大为多 writer 支持。
6. 0.0.10 数值高于 0.0.2，版本优先日期；全文默认5条、分页总数准确、不截断；baseline 独立上下文不重复；先筛选再分页；替代标注使用 asOf 可见全集。
7. 备份恢复保留已回收历史 bytes/hash；future schema 明确拒绝，读取不降级、不写盘。
8. writer 持锁时 CLI query/read 返回完整固定正文，正式数据零写、零网络。
9. 不可能日历日期、缺时区日期和不安全版本整数在写入前拒绝。

源码复核确认 requestId 在动态默认值前处理、项目串行追加结合 expectedRevision、固定版本/hash 重验、refs 保留所有历史条目、asOf 先于筛选分页，以及 strict UTF8 原文读取。未发现额外待修项。范围仅为上述反例和目标源码，不代表全仓安全审计。

浏览器回归通过：33 个资源、10 个插件卡片，1440px 桌面和390px移动端；包括筛选/分页/无结果、Markdown 转义、UUID 图片和跳转、坏引用诊断、二进制不支持、组织节点及插件启停提示。PPC 原专属测试 **2/2**；固定入口 help 返回 `0.0.3-dev`，真实转发 project-track query/read 得到7条记录、默认全文5条、asOf 0.0.3为6条，固定cv1/hash仍与当前cv2分开。未改外部 PPC 源码、未调用 PPC 服务管理或打包。

## 保留演示库

实际运行 `node examples/project-tracking/create-demo.mjs` 成功，core check 有效，6 个资源、7 条 entry，发布事实仅核对本地 `v0.0.2` tag 指向 `b8e3fbefa10602461da3477e4db83e0b0dade822`；其余设计/计划均明确合成。

- dataDir：`C:/Users/mamar/AppData/Local/Temp/knowledge-base-project-demo-AcROAI/项目演示库`
- projectId：`4c1a288a-5f15-4e88-9811-90f1cf033fd0`
- manifest：`C:/Users/mamar/AppData/Local/Temp/knowledge-base-project-demo-AcROAI/project-demo.json`
- 固定历史 entry：`e3e1609c-66d7-49fb-b602-4296447def64`，cv1；当前原件已cv2。

manifest 已输出可直接复制的 PPC query/read/preview start/stop 及 directReadPinned 命令。脚本未启动服务，不删除库；系统临时目录可能被清理，需长期保留时请用正式 backup 另存。通用预览链接读取当前原件，历史全文仍以 project-track read/query 为准。

## 证据和清理

全部新证据仅在 `artifacts/verification/v0.0.3`：`independent.tap`、`ppc.tap`、`demo-ppc.json`、`browser/browser-result.json` 与8张截图、`independent-summary.json`、`independent-commands.md`。core 的70项测试/构建日志独立保留。旧 v0.0.1/v0.0.2 档案及证据路径 diff 为0。

测试 fetch 封锁外部请求，允许浏览器测试所需 loopback；独立验证外部请求计数0。未读取真实密钥，真实 DeepSeek 账本保持 closed/3，没有新增付费请求。最终 CIM 检查本轮 preview/browser/demo/独立测试 Node 进程为0；演示服务未启动，未创建系统任务。
