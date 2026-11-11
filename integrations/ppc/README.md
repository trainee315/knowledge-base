# PPC knowledge CLI 集成补丁

此目录随知识库 0.0.1 发布，保存个人项目中心（PPC）的独立 CLI 适配，便于在其它机器重现安装。

- PPC 基线：`72a78f1b2a26c49ae3d6cddd6548dd10eb69d18e`（`72a78f1`）。
- 补丁：[knowledge-cli.patch](./knowledge-cli.patch)，UTF-8、LF 实际换行，可直接使用 `git apply`。
- 范围仅限四个文件：修改 `cli/ppc.mjs`、`cli/README.md`；新增 `cli/knowledge.mjs`、`cli/knowledge.test.mjs`。
- 不包含 PPC 已有的压图或其它工作区修改，不需要 PPC 后端，不启停 PPC 服务。

交付时本机 PPC 仓库没有配置 Git remote，原有工作区改动保留，本轮没有在该仓库暂存、提交或推送。知识库仓库的发布包含这份集成补丁，不能据此认为外部 PPC 仓库已经推送。

## 安装

先在知识库仓库完成 `npm install` 和 `npm run build`。然后在对应基线的 PPC 仓库根运行：

```powershell
git rev-parse HEAD
git apply --check 'D:/project/knowledge-base/integrations/ppc/knowledge-cli.patch'
git apply 'D:/project/knowledge-base/integrations/ppc/knowledge-cli.patch'
node cli/ppc.mjs --help
node cli/ppc.mjs knowledge --help --knowledge-home 'D:/project/knowledge-base' --json
node --test cli/knowledge.test.mjs
```

先确认 `git apply --check` 成功。若这四个文件已有其它修改或适配已安装，补丁可能拒绝应用，应查看差异并合并；不要覆盖现有改动，也不要重复应用。本机现有 PPC 已包含此适配，无需再次应用。

`knowledge` 使用 `process.execPath` 和 `spawn` 参数数组调用知识库 `dist/cli/main.js`，设置 `shell:false`，原样透传参数、JSON stdout、stderr 和退出码；原有 `note` 命令保持独立。知识库路径优先级为：

1. `--knowledge-home <知识库仓库>`。
2. 环境变量 `PPC_KNOWLEDGE_HOME`。
3. 本机默认 `D:/project/knowledge-base`。

```powershell
node cli/ppc.mjs knowledge resource list --knowledge-home 'D:/project/knowledge-base' --data-dir 'D:/资料/知识库 数据' --json
```

## 可重复验证

在知识库仓库运行：

```powershell
node integrations/ppc/verify.mjs 'C:/Users/mamar/Desktop/personalProjectCenter' 'D:/project/knowledge-base'
```

验证器只从 PPC 基线读取五个 CLI 必需文件（包括原有 `api.mjs`、`service.mjs`、`windows.mjs`），导出到带中文和空格的独立临时目录。在该目录先 `git apply --check` 再应用补丁，检查 PPC 帮助、向真实知识库 CLI 转发帮助，以及两项专属测试。测试覆盖中文/空格/shell 特殊字符参数、路径配置、JSON/stdout/stderr/退出码透传及缺失构建错误。

验证器不会将补丁应用到原始 PPC 工作区，不修改其 Git index，不运行 `service` 或 `pack` 命令。结束时先验证临时目录的绝对路径和归属，再删除自己创建的目录。结果写入 [verification.json](./verification.json)，其中记录补丁 SHA-256、基线、测试输出及原始 index/文件未变的检查。
