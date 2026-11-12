# 组织入口调整验证

2026-11-12用户确认本项作为v0.0.5补充需求归档并提交。实现基线为v0.0.5 / 03104a2，验证包含当前main集成状态的提交前复核，包版本为0.0.5。

## 实现范围

组织方式选择器过滤project-development-tracking，清理页面中的历史基线、阶段、历史标签和替代声明专用展示。旧页面链接采用替换当前历史条目的hash导航进入Session转录列表，清除旧定位、筛选、分页和实例详情参数。

尚未登记Session方式的旧库显示空实例列表并提供首次配置入口。只读页面导航保持组织方式登记状态，用户保存实例时才走既有写入流程。后端保留旧组织及固定原文回查契约。

## 自动验证

- 类型检查和完整构建通过。
- 初次在v0.0.5基线上验证核心测试93/93通过。归属修正后在main / 6363fde集成状态重新验证，核心测试99/99通过，涵盖既有资源、组织、标签、关键词、项目跟踪、Session转录及已合入的本地服务行为。
- 独立项目跟踪9项及开发服务集成1项通过。
- Chrome通用浏览回归通过，覆盖资源、体系、自定义组织、插件状态和390px布局。
- Chrome实例配置回归通过，新增检查覆盖旧方式撤下、旧链接清除定位条件、刷新及前进后退、开发与构建页面、窄屏、尚未登记Session方式的旧库。另验证历史组织及资源元数据保持一致、固定v1正文可读、页面导航仅使用当前组织接口。
- 模型夹具调用2次用于准备合成Session记录，本次真实模型调用0次。测试使用系统临时库及合成材料。

旧库补充用例曾发现hash参数清理后外层页面保留旧instance状态，首次配置按钮未显示。改用标准hash替换导航后用例通过，并验证旧库导航仍保持零初始化写入。

证据位于[组织入口验证目录](../../../artifacts/verification/v0.0.5/organization-entry/summary.json)，包含测试输出、浏览器结构化结果和合成截图。

## 用户验收

1. 刷新正在使用的页面，进入“组织与体系”，展开“组织方式”。选择项包含Session转录，旧“项目开发状态跟踪”入口已撤下。
2. 选择Session转录，进入“knowledge-base 项目开发记录”的实例详情，核对关联记录与实例配置可用。
3. 在当前页面URL后使用`/#browse?type=project-development-tracking&id=legacy&entry=legacy&instance=legacy&offset=20&q=legacy`，应进入Session转录列表，旧定位及筛选条件清空。刷新和浏览器前进后退应正常。
4. 切换标签、关键词和体系，核对关联文档与正文读取可用。

需要独立合成库时运行`node examples/create-records-demo.mjs`，按输出设置KB_DATA_DIR后启动开发预览。

```powershell
npm run typecheck
npm run build
node --test dist/**/*.test.js
node --test tests/project-tracking/independent.test.mjs web/tests/dev.integration.mjs
$env:KB_BROWSER_USE_PPC = '0'
$env:KB_BROWSER_EVIDENCE = 'artifacts/verification/v0.0.5/organization-entry/browser'
npm run test:web
$env:KB_TRANSCRIPT_BROWSER_EVIDENCE = 'artifacts/verification/v0.0.5/organization-entry/transcript-browser'
node web/tests/transcript-configuration.mjs
```

验证范围为本地页面行为与历史读取兼容。历史项目条目自动转换为Session转录记录属于后续数据处理议题。
