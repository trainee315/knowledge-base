# Session压缩模式可视化配置补充需求

2026-11-12用户要求将aggressive模式加入页面，入口为插件→project-tracking→配置→Session压缩模式，三种模式各附简短说明，纳入v0.0.9补充需求。

当前压缩模式属于Session实例配置。该入口先选择Session实例，再编辑其preprocessing字段，沿用CLI同一权威数据与修订校验。模式选择为off、conservative、aggressive，默认conservative。所有模式均执行编码载荷路径替换，文字说明分别说明基础清理、保守清理、激进工具节选。

页面沿用插件详情表单的保存、取消、草稿离开保护、修订冲突和最新值比较。URL用configKey记录实例UUID，支持刷新与前进后退。保存作用于所选实例后续新建任务。空库提供Session实例创建入口，停用或失败状态可读取并说明编辑状态。

契约复用GET /api/plugins/project-tracking?configKey=<实例UUID>与PATCH /api/plugins/project-tracking/config，保存携带configKey、expectedConfigVersion及values.preprocessing。配置版本绑定实例UUID和组织revision。所有保存复用转录领域配置校验，读取和保存零模型调用。

验收覆盖三模式说明、实例切换、CLI互通、保存/取消、刷新、冲突、非法模式、空库、停用和执行忙碌、只读与模型零调用、发现边界/任务/记录一致性，以及桌面与窄屏。使用隔离合成库完成自动测试和Chrome回归，更新验证结果后提供运行中的页面入口。

## 验证与交付

2026-11-12用户验收通过。共享configureTranscript领域事务供CLI与插件表单调用，表单仅投影实例选择和preprocessing，配置版本绑定实例完整修订。所有读取及配置保存均复用既有本地接口和写者协调。

类型检查、完整构建、核心119/119、专项39/39、独立项目跟踪9项及开发集成1项通过。新增接口测试覆盖三模式保存、CLI读回、非法字段/模式、缺少实例、并发CAS、执行租约、转录插件停用、空库入口与任务材料投影。Chrome插件详情回归通过，覆盖说明、取消、实例切换、草稿离开保护、刷新/前进后退、390px保存及CLI互通，外部请求计数0。原Session实例配置Chrome回归通过。

证据在artifacts/verification/v0.0.9/visual-compression，包含core-tests.txt、focused-tests.txt、independent-tests.txt、typecheck.txt、build.txt、browser/result.json和transcript-browser/result.json。截图使用合成实例。运行中的正式页面已只读核对三选项、三份说明及当前保存值，真实页面截图保存在本地忽略目录。

验收入口为[本地插件配置](http://127.0.0.1:5183/#plugins?id=project-tracking&view=config)。后端沿用127.0.0.1:62945，页面服务5183。

1. 进入插件→project-tracking→配置，选择Session实例。
2. 核对off、conservative、aggressive的说明及公共载荷清理说明。
3. 修改模式后取消，确认表单恢复保存值。再选择aggressive并保存，刷新页面核对。
4. 通过CLI `transcript get --id "<实例UUID>" --json`核对preprocessing。通过CLI修改该实例后，用旧页面保存可验收冲突提示、草稿保留与最新值比较。
5. 切换其他实例，并用浏览器返回/前进核对实例与模式。窄屏完成一次保存，核对说明和控件可读。

配置按所选Session实例保存，作用于其后续新建转录任务。该入口由project-tracking插件页面承载，持久化权威为对应Session实例的config.preprocessing。
