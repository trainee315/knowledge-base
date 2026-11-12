# v0.0.5 运行说明

要求Node.js24+和npm。在仓库根目录完成安装构建后使用CLI，数据目录默认本仓.data，`--data-dir`可选择独立库。

```powershell
npm ci
npm run build
.\cli.bat help --json
.\cli.bat note add --file .\notes.md --request-id note-001 --json
.\cli.bat note list --json
```

文本可用`--text`，管道正文可用`--stdin`，与`--file`三选一。读取使用`note get --id UUID`，显式删除和恢复沿用resource命令。标签使用已存在的标签ID、名称或别名。

## 转录

创建UTF-8配置文件。

```json
{
  "alias": "项目开发记录",
  "projectDir": "D:/project/knowledge-base",
  "startDate": "2026-11-12",
  "timezone": "Asia/Shanghai",
  "focus": "项目状态与关键决策",
  "profile": "deepseek-default",
  "maxCalls": 0
}
```

```powershell
.\cli.bat transcript create --input config.json --json
.\cli.bat transcript preview --alias "项目开发记录" --json
.\cli.bat transcript run --alias "项目开发记录" --max-calls 1 --json
.\cli.bat transcript records --alias "项目开发记录" --json
.\cli.bat transcript retry --alias "项目开发记录" --max-calls 1 --json
.\cli.bat transcript backfill --alias "项目开发记录" --from 2026-11-01 --to 2026-11-11T23:59:59+08:00 --max-calls 1 --json
.\cli.bat check --json
```

默认来源为当前用户.codex，精确匹配项目目录，排除子Agent和未完成轮次。默认单段40000字节、总输入200000字节、10个session、120000毫秒、0次模型调用。完整轮次过大时可通过configure调整预算，并为长输出选择合适profile。maxDurationMs最高300000。正文按sourceFrom/sourceTo对应的时段理解，source位置可回查。

Agent profile通过`agent profile list/get/set`管理，密钥以环境变量引用供适配器读取。deepseek-default默认使用DEEPSEEK_API_KEY。启用正数预算会将筛选出的材料提交到所选模型，执行前用preview核对范围。模式脱敏覆盖已识别凭证，敏感内容仍需按本地数据规则管理。

周期配置使用enabled、intervalMinutes和projectDir。外部定时工具调用`transcript tick --json`检查到期实例。服务只在用户启动页面预览时运行，CLI任务执行结束退出。

## 页面与隔离验收

```powershell
node examples/create-records-demo.mjs
npm run dev
```

脚本打印独立临时库及验收命令。页面通过KB_DATA_DIR选择同一个库，在组织与体系中选择Session转录，进入实例详情即可编辑配置、预览草稿和阅读记录。保存会校验修订号，冲突时草稿保留，可刷新合并后再次保存。CLI和页面共用权威数据及校验。

构建页面预览仍用`preview start/status/stop`，默认监听127.0.0.1动态端口。开发默认端口5183。仅配置保存及草稿预览开放专用同源JSON请求，资源浏览通过读取接口提供。

更详细的隔离验收步骤见[用户验收历史](../新增需求/v0.0.5/acceptance.md)。
