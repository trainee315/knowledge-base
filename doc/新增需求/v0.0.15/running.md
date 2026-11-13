# v0.0.15 运行与恢复

日常使用仍通过 `start.bat` 或 `cli.bat up --format text`。在组织与体系页面选择标签，可编辑名称、别名和说明，查看文档、正文片元、关键词或待核对候选。

新增带别名标签：

```powershell
.\cli.bat semantic create --name "预制体" --aliases "Prefab" --description "Cocos Creator 节点与组件资产" --json
.\cli.bat semantic get --id "标签UUID" --view candidates --json
```

已有名称或别名冲突时编辑原标签，不创建重复概念。候选不等于已确认归属；若大量出现无关含义，修改说明和别名后重新匹配。

## 丢弃全部标签和关键词

此维护入口会清空包括人工定义、别名、旧决定及删除抑制在内的标签整理数据，并清空关键词及匹配索引。仅在明确要丢弃这些数据时使用。文档正文、内容版本、历史、资源身份及其他组织保持完整；元数据 revision 与更新时间允许变化。

```powershell
.\cli.bat service stop --json
node scripts/reset-semantic.mjs --data-dir ".data" --discard-existing
.\cli.bat service start --json
```

`--data-dir` 必须明确指定目标库。脚本要求该库服务已停止；存在其他业务对标签的引用时预检拒绝，不静默删除这些引用。正式文件使用核心写会话维护；清理中断会留下持久标记，后台不继续生成。再次停止服务并执行相同清理命令即可恢复，之后启动服务生成新结果。

向量缓存只作内容寻址复用，不保留为可见关键词或标签。重建失败保留持久任务，可通过页面重试或 `semantic retry-all` 后继续运行；全部任务完成并不自动代表质量验收通过。

仅刷新关键词、保留标签定义时，仍使用 `semantic rebuild`；它有意暂停本轮自动新增标签，不能替代上述全部丢弃流程。

## 验证

`npm test` 验证核心与服务回归。`tests/semantic/quality-browser.mjs` 需要 `KB_SEMANTIC_MODEL_DIR` 指向已准备的本地模型，并在临时库验证真实匹配、编辑别名、候选隔离和桌面／窄屏页面。

`tests/semantic/quality-v15.mjs` 为只读质量检查器，需要本地冻结标注文件；私有样本、原文、逐项评估及真实库截图保留在忽略目录中。机器检查覆盖正文 hash、关键词偏移、关键概念保留和预标注标签对；关键词及自动标签合理性仍需结合出处人工审阅，不能只看词条数或任务状态。
