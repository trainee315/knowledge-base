# 运行与恢复

要求 Node.js 24+（包含 npm）。首次安装依赖需要访问 npm 源。Windows 可双击仓库根目录 `start.bat`；失败时窗口保留错误信息，成功后自动打开页面。

```powershell
.\cli.bat up --format text
.\cli.bat up --data-dir 'D:\知识库数据' --no-open --format text
.\cli.bat interactive --data-dir 'D:\知识库数据'
.\cli.bat resource import --help --format text
.\cli.bat resource import --file 'D:\notes\设计 说明.md' --data-dir 'D:\知识库数据' --format text
.\cli.bat service status --data-dir 'D:\知识库数据' --format text
.\cli.bat service stop --data-dir 'D:\知识库数据' --format text
```

默认数据位置仍是本仓库 `.data`。使用自定义库时，各命令必须传递相同 `--data-dir`。`up` 复用运行中的服务，不会隐式重启正在执行的任务；更新服务代码后请显式执行 `service restart`。

诊断及日志：

```powershell
.\cli.bat doctor --data-dir 'D:\知识库数据' --format text
.\cli.bat service logs --data-dir 'D:\知识库数据' --lines 100 --format text
Get-Content .\.runtime\setup.log -Tail 100
```

- Node 不存在：安装 Node 24+ 后重新打开终端。
- npm ci 失败：查看 setup.log，检查网络、npm 源及锁文件；修复后重新执行 up。
- 构建失败：查看 setup.log，修复编译错误后重试；不启动不完整服务。
- SETUP_BUSY：等待另一启动完成；只有确认准备进程已退出，才清理仓库 `.runtime/setup.lock`。
- 端口占用：选择其他端口，或 `service start --port 0` 自动分配。
- 服务不可达：检查 data-dir、服务状态及日志。诊断不会把所有失败都认定为“未启动”。
- 版本冲突：先 get 最新版本，合并后使用最新 expectedRevision/expectedContentVersion；不要直接覆盖他人修改。

自动化继续使用 `--json`。准备阶段写 stderr，stdout 仍是单 JSON。菜单不适用于重定向或管道输入；脚本应调用具体命令。
