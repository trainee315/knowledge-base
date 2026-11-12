# v0.0.6 验收清单

状态：待验证。使用独立临时数据目录、合成 Session 和模型替身。

## 本地试用

构建后，在仓库根目录执行下列 PowerShell 命令。使用启动结果中的 URL 打开网页。

```powershell
npm ci
npm run build
$dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ('kb-006-' + [guid]::NewGuid())
.\cli.bat service status --data-dir "$dataDir" --json
.\cli.bat service start --data-dir "$dataDir" --json
try {
  .\cli.bat resource list --data-dir "$dataDir" --json
  .\cli.bat cron types --data-dir "$dataDir" --json
  '{"taskType":"organizer.run","params":{"maxCalls":0},"schedule":{"kind":"interval","minutes":5}}' |
    .\cli.bat cron create --input - --data-dir "$dataDir" --json
  .\cli.bat cron list --data-dir "$dataDir" --json
  .\cli.bat cron runs --data-dir "$dataDir" --json
} finally {
  .\cli.bat service stop --data-dir "$dataDir" --json
}
```

新计划处于停用状态。用 `cron enable --id <计划ID> --expected-revision <当前修订号>` 启用，或用 `cron run --id <计划ID>` 验证一次主动执行。

已有库首次启动会迁移已保存的周期。备份后如需验证迁移，可将备份恢复到另一空库。恢复后的周期默认停用，手动检查配置及预算后再启用。

## 服务与兼容

- [ ] 显式启动、状态、重启、停止排空和异常退出恢复。
- [ ] 同目录及路径别名单实例，独立数据目录各自运行。
- [ ] 停服业务 CLI 指引、本地 help、单 JSON 和退出码。
- [ ] 相对文件路径、stdin、UTF-8 BOM 与换行字节保真。
- [ ] 构建网页、Vite 代理与 CLI 看到同一状态，兼容原预览入口。
- [ ] 停用 cron 后，服务、CLI 与网页仍可操作知识库。

## 调度与数据

- [ ] 重复迁移、兼容旧周期命令、恢复混合配置写入。
- [ ] cron、间隔和时区边界，错过周期最多补一次。
- [ ] 同一时点去重、主动与定时互斥、预算限制、暂停与重启。
- [ ] 注入业务已提交但运行状态未保存的故障，核对业务结果及中断标记。
- [ ] 新旧备份恢复，恢复出的计划默认停用。

验收证据记录验证命令、输出、故障注入结果和已知限制。
