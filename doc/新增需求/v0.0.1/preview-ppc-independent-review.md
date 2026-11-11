# 预览与 PPC 独立复核

> 归档状态：本需求已于2026-11-11按用户指令归档发布并归档至 [已发布v0.0.1](../../v0.0.1/readme.md)。本文保留当时设计/实现/验证记录；当前能力以发布档案为准。

复核人：核心负责人（未编写 src/preview、web 或 PPC 接入实现）。日期：2026-11-10。范围为 `src/preview/**`、`web/**`、个人项目中心 `cli/knowledge.mjs` 与 `cli/ppc.mjs` 的 knowledge 分支。只使用临时目录、自己启动的进程和只读 HTTP；未启动 PPC HTTP 后端、未调用打包、付费模型或系统调度。

## 检索与证据边界

使用 codebase-memory 技能：知识库项目未索引，list_projects/index_status/check_index_coverage 均明确返回 project not found，按技能回退读取全部相关源码。PPC 项目选择 `C-Users-mamar-Desktop-personalProjectCenter`，图 generation 为 `2026-11-10T11:28:41Z`，非当前会话项目未watch；knowledge.mjs 为 not_tracked，ppc.mjs/README 元数据已变，search_graph 对新增文件无结果。故本次 PPC 结论来自精确源码读取与真实 CLI 命令，没有以旧图的“无结果”宣称无实现。

## 已发现并关闭的问题

P2：同一物理目录使用 Windows 大小写别名启动两个预览。旧 `src/preview/index.ts` 的 handlePreview 仅 resolve，readState 比较 state.dataDir 与输入字符串完全相等。独立临时探针先 start 原路径，再 start data.toUpperCase，返回两组真实 PID/端口：84896/64221 与42344/64222。后者覆盖同一 preview.json，原进程无法通过正常stop寻址。

作者修复为 realpath 目录身份、operation 与 instance 两个 OS IPC 命名空间（当前 `index.ts:89`、`mutex.ts:8`、`worker.ts:14`）。operation 串行start/status/stop，worker终生持instance；stop等待实例退出并清理令牌匹配记录后返回，避免旧进程清理删除新记录。失效磁盘PID文件不再用于抢锁。独立复验原路径、全大写路径与junction别名均复用PID96536；别名status同PID；大写路径stop完成后旧地址立即不能访问。此发现已关闭。

同时关注过旧磁盘启动锁的 read/kill/rm 竞态；当时8并发未复现双实例，未作为已证实发现。作者本次移除该锁并以OS IPC替代，已有8真实CLI进程、junction/大小写、旧PID和SIGKILL恢复回归。

## 独立行为验证

临时真实库包含35个资源，直接使用实际 CoreManager/PluginHost 构建内容、标签及体系，再以readOnly打开并调用 createPreviewServer，未替换业务查询实现。独立探针实际通过：

- 重复 filename=alpha&filename=beta 与 body=topic 得2项；再加精确标签条件得1项，体系命中对应UUID。offset=1/limit=1保留total=2并只返回1项。limit201/0/NaN、offset负数/小数均400。
- POST资源、PATCH组织、DELETE资源均405；外部Origin、错误Host、缺令牌stop均403（`server.ts:36`、`:44`）。
- 编码逃逸 `/%2e%2e%5csecret.txt` 和 `/..%2fsecret.txt` 均403，没有泄漏webDir外的哨兵文件。
- 全部业务插件停用并重新启动只读宿主后，filename分页和原件下载仍200；业务keywords筛选明确409不可用，详情content为unparsed。没有把停用等同数据清理。
- 对全部正式文件递归SHA256，正常预览与停用降级预览各自请求前后完全相同，读会话未改正式数据。
- 构造自己的假控制HTTP服务器与preview记录，status返回不匹配PID；handlePreview stop返回running=false，假服务器从未收到stop请求。另绑定自己的占用端口，preview start失败但该服务器继续返回occupied；不会停止其他服务。
- `.runtime` 为指向库外的junction时start返回UNSAFE_PATH，库外目录仍为空。

上述探针实际JSON输出记录了 queryAndOr/pagination/invalidPagination/readOnlyMethods/originHostAndToken/encodedTraversalRejected/formalFilesUnchanged/allPluginsDisabledFallback/stopWrongIdentityRejected 全true；生命周期复验为 caseAliasClosed/junctionAliasClosed/stopWaitsForOldAddressClosed/unsafeRuntimeJunctionRejectedWithoutWrites/occupiedPortDoesNotControlOtherServer 全true。所有探针仅清理自己创建的临时库和进程。

## PPC 真实入口与输出

按固定入口分别执行真实命令：

```powershell
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge resource import --file '临时目录/真实 原件 & $().txt' --data-dir '临时目录/正式 数据' --json
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge organize query --filename '真实 原件 & $()' --data-dir '临时目录/正式 数据' --json
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge resource import --data-dir '临时目录/正式 数据' --json
C:/nvm4w/nodejs/node.exe C:/Users/mamar/Desktop/personalProjectCenter/cli/ppc.mjs knowledge resource get --id not-a-uuid --data-dir '临时目录/正式 数据' --json
```

导入返回UUID9777d6e9-13d7-4567-a3c3-6db7b51354f6，文件名含空格、中文、&和$()原样保留；组合查询返回parsed正文和关键词、total=1。缺少file原样返回知识库INVALID_ARGUMENT对象，真实native退出码2；非法UUID返回INVALID_ID、退出码1。PowerShell外层用 `exit $LASTEXITCODE` 记录native码，避免外壳把非零统一映为1。

源码 `knowledge.mjs:25` 为 spawn(process.execPath,[entry,...forwarded])、shell:false、stdio:inherit；`:30` 透传子进程退出码。`ppc.mjs:138` 在原API分派前直接返回转发，无PPC backend依赖。参数/输入/stdout/stderr不经shell或二次JSON包装。缺构建时由PPC自己的错误包装返回KNOWLEDGE_UNAVAILABLE；此为PPC入口错误，不伪称知识库执行结果。

## 前端与视觉核对

`web/src/App.vue:33` 在筛选重置offset，`:39` 将逗号分隔值转重复query参数；server getAll与业务OR/AND协议一致。分页固定30、offset跨页递增，total来自过滤后的服务端结果。业务插件停用时禁用专属过滤，组织方式通过通用 `/api/organization-types` 读取（`server.ts:78`），无新管理写入口。

独立查看了实际截图 resources-markdown.png、resources-mobile.png、organizations.png：正文、UUID图片、匹配原因、元数据和中文状态可读；移动页按单列布局，无明显内容截断；组织页展示通用方式定义、处理器、配置及有序体系节点。HTML脚本文字作为正文显示。截图是作者实际headless Chrome生成，本次检查没有将截图视为网络安全或完整行为验证的替代。

## 结论与剩余边界

本次范围内已证实问题1项，作者修复后原反例通过；其余上述边界独立验证通过。插件启停状态是预览启动快照，页面明确提示重启加载；外部修改正式数据或运行目录、恶意本机Node代码不在隔离保证内。未进行长时预览、网络共享盘、浏览器全版本兼容和断电测试。最终冻结后的全套输出另见 execution.md 与 artifacts/verification。
