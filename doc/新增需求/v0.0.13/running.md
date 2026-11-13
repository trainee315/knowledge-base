# v0.0.13 运行与恢复

## 页面

构建使用 `npm run build`。当前主库服务已恢复为 `http://127.0.0.1:62945`。

进入“组织与体系”，在“组织方式”选择“关键词”。初始只请求词表；选择词条才加载关联文档，选择文档才加载命中片元。三个区域分别搜索或分页，全文通过“阅读文档全文”单独加载。慢请求显示加载中，失败可刷新或重试；索引代次改变后需重新选择。URL 保留搜索、分页和选择，支持刷新和前进后退。

## 显式重新生成

需要重新计算关键词时，在已有本地模型的库执行：

```powershell
node dist/cli/main.js semantic rebuild --data-dir D:/project/knowledge-base/.data --json
node dist/cli/main.js semantic run --data-dir D:/project/knowledge-base/.data --json
node dist/cli/main.js semantic list --data-dir D:/project/knowledge-base/.data --json
```

rebuild 排队全库；后台服务会继续消费，也可以重复 run 推进，每批至多 4 个任务。检查 run 的 `complete` 和 list 的资源/失败状态，不能以“请求已排队”代替完成。重建过程中词表明确显示正在生成，不显示混合结果。通常已有向量可复用，关键词派生计数应增加，而 encodedTexts 可以为零。

失败原因可在 semantic list 的任务状态中查看。修复原因后执行 `semantic retry-all` 再继续 run。服务重启保留队列和重建状态；不需要重复清库，不应删除 cache/semantic 整个目录。普通无变更运行不重新派生、不更新发布代次。

需要严格固定文档与配置的维护验收，应先排空并停止业务写入，记录保护基线，再调用 `rebuildKeywords/runSemantic` 进行受控批次，验收完成后恢复服务。本次主库使用该流程，核对所有正文及历史文件、资源非关键词字段、组织和插件配置，保留标签集合；详细操作脚本和含真实信息的基线位于本地忽略目录 `.data/.runtime/v0013-*`。

## 重跑验证

```powershell
npm run build
node --test --test-concurrency=1 dist/**/*.test.js tests/chains/chain.test.mjs
node tests/semantic/keywords-browser.mjs
node web/tests/browser.mjs
node tests/semantic/keywords-performance.mjs
$env:KB_SEMANTIC_MODEL_DIR='D:/project/knowledge-base/.data/cache/recall-models'
node tests/semantic/keywords-live.mjs
```

这些测试使用隔离临时库和合成数据。真实模型测试只复制已经存在的本地模型缓存，不下载模型；浏览器测试需要本机 Chrome，可通过 `KB_CHROME_PATH` 指定路径。公开验证材料位于 `artifacts/verification/v0.0.13`，真实词汇和页面截图仅存于主库忽略目录。
