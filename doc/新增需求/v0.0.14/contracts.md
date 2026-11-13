# CLI 公共契约

## 输出与退出码

- 默认 stdout 为单个 JSON 对象：成功 `{ok:true,data}`，失败 `{ok:false,error}`。
- `--json` / `--json=true` 优先于 `--format text`；`--format json` 显式选择 JSON。
- 错误保留 `code/message/details`，新增 `suggestions: string[]`、`helpCommand: string`。
- 参数错误退出 2，执行错误退出 1，正常退出 0。doctor 检查不健康时返回 `ok:true,data.healthy:false`、退出 1；此处表示诊断执行成功而检查未通过。
- 阶段信息和交互提示写 stderr。文本输出不把 `complete:false` 或已排队任务包装为“已完成”。
- `interactive` 需要 stdin/stderr 都是 TTY；拒绝 `--json`，非终端直接退出 2，不等待用户输入。

## 帮助与校验

`help`、`help resource`、`help resource import`、`resource --help`、`resource import -h` 均可离线使用，不启动服务，不读取 `--input`。未构建时源码入口先提供最小启动帮助；完成首次准备后提供全部详细帮助。

所有已注册内置命令均进行参数白名单、类型和必填项校验；嵌套字段、业务值域及并发版本仍由所属业务模块核验。命令行覆盖 UTF8 JSON 输入文件或 `--input -`。保留既有逗号列表格式；复杂对象必须使用 JSON 输入。

`org` 等价于 `organization`。`preview` 保留共享服务生命周期。旧项目跟踪只读调用统一携带的 `projectId/entryId` 继续接受；帮助明确列出本命令忽略的字段。新增内置插件命令必须同步登记帮助元数据，覆盖测试会检查遗漏。

## 启动

`start.bat`、`cli.bat up`、`npm start` 和包 bin 入口使用 `scripts/launch.mjs`。`up` 接受 `port/noOpen/dataDir/json/format/input`。以根目录为准备工作目录，保留调用方 cwd 用于相对输入路径。参数校验先于安装或构建。

依赖完整且源码、配置、锁文件指纹不变、核心及页面入口存在时复用构建；否则安装缺失依赖或重建。准备过程由 `.runtime/setup.lock` 互斥，冲突返回 SETUP_BUSY；不自动删除未知锁。`service start` 保持原有轻量语义，不自动构建。

启动服务会运行已有启用的后台计划。默认打开本地页面，`--no-open` 禁止自动打开。重复启动复用同数据目录服务；端口变化须显式 restart。打开浏览器失败返回 warnings 和 URL，服务仍保持运行。

## 诊断与日志

doctor 检查 Node、npm 入口、构建、依赖入口、数据目录访问权限和可验证服务连通性，不创建数据目录或试写文件。尚未构建时仅提供最小诊断。权限检查不能代替实际写入时的系统校验。

准备日志位于仓库 `.runtime/setup.log`；服务 stdout/stderr 位于数据目录 `.runtime/service.log`。`service logs --lines N` 返回日志末尾 1–1000 行，默认 50 行，单次最多读取 256 KiB，并对常见凭证模式脱敏；不返回服务控制 token。启动前版本留下的服务可能没有新日志。

## 交互取消

`/cancel` 返回上层菜单；Ctrl+C/EOF 终止交互。尚未提交的输入不执行；已提交的操作不会因取消而回滚，等待结果后报告已完成的启动、导入、停止次数。菜单只包含常用低复杂度操作，其他命令通过完整 CLI 使用。
