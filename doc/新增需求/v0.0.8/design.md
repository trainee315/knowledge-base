# v0.0.8 召回设计

状态：2026-11-12用户验收通过，见[user-acceptance.md](user-acceptance.md)。基线 `81387b5`，包含需求 `ebeee44`。独立分支 `codex/v0.0.8-recall`，不携带主工作树 v0.0.9 修改。

## 数据与执行边界

CLI 继续经过现有本地服务，新增独立 recall 业务层。范围登记写入核心 PluginStore 的正式 data 分区；正文、notes/transcripts、标签及关键词保持既有语义。召回索引放在独立派生缓存，丢失后显式重建。普通读、列举和 scope 不调用文档编码，不刷新全库索引。

项目以显式 ID、任务上下文、调用目录映射确定，候选冲突返回歧义。目录比较遵守平台大小写及路径段边界。资源映射显式登记 projectId、modules、sourcePaths；旧 note 的 projectDir 可匹配登记目录。转录项目可通过显式组织映射确定；不从标题推断项目或模块。未知记录不进入严格范围。组织实例关联和接受的标签关联分别保留。

片元包含资源 ID、固定 contentVersion/hash、UTF-16 起止偏移、行范围、标题路径、邻接及切分版本。原文包括 BOM/CRLF，引用不使用清洗后的索引文本。notes 与 transcripts 默认固定版本 1；普通资源默认当前版本，显式历史版本可直接读取。按 Markdown 块切分，超长块分段并标记需要展开；编码输入与引用正文分开。

构建先读取一致的源快照，再在正式库写锁之外切分和编码。新索引在独立文件中构造，校验源修订后原子发布代次指针；失败保留旧代次。查询先算允许的记录集合，再在其片元中 BM25/向量排名；输出前重新验证删除、范围及固定原文版本。删除内容不依赖重建才能撤回。恢复重用匹配指纹的向量；范围修订不改变编码缓存身份。

## 检索与模型

全文采用 Node SQLite FTS5，输入使用相同的 NFKC、英文词和中文字符/二元词处理，FTS 表只收派生词串。所有表达式由转义后的词构造并绑定参数；不直接执行用户 FTS 表达式。范围限定在 LIMIT 之前。融合用 RRF，原始不同量纲分数不相加。

用户选择本机按需模型。候选运行时固定 `@huggingface/transformers@3.8.1`，首选 `Xenova/bge-small-zh-v1.5` 与 `Xenova/bge-reranker-base`（BAAI 模型的 ONNX 转换）。先用 CPU、单线程、单并发，模型进程随请求结束退出；不启用常驻模型、GPU或云端替代。模型准备为显式命令，查询不隐式联网下载。锁定模型仓库修订、文件哈希、dtype、pooling、归一化、查询指令及实际运行时版本。只有本机质量/负载试验通过后才标为已验证默认配置。

embedding 使用独立 encode 接口（CLS pooling + L2 normalization，查询增加官方中文检索指令）；重排使用 query/document 成对分类 logits。不得调用 generateText 冒充 embedding。编码缓存键包括实际输入文本及完整模型身份；查询向量和重排用量分别记录。配置/模型缺失时 lexical 可用，semantic 返回明确不可用，hybrid 降级并报告实际阶段。

## 组装

直接读取、列举、问题检索、任务组装共用范围和预算。任务用调用者给出的 needs 或确定性约束/设计/问题/验证模板生成子问题；本版默认不增加生成模型。固定入口来自显式项目登记，优先直接读。按片元身份去重，邻接展开遵守相同范围，保留来源及历史身份。预算覆盖完整响应，token 为估计并同时使用 UTF-8 字节硬限；预算不足返回省略及继续读取入口，不截断为貌似完整的证据。

## 技术依据

- https://www.sqlite.org/fts5.html
- https://huggingface.co/docs/transformers.js/v3.8.1/en/tutorials/node
- https://huggingface.co/BAAI/bge-small-zh-v1.5
- https://huggingface.co/Xenova/bge-small-zh-v1.5
- https://huggingface.co/Xenova/bge-reranker-base

官方资料用于确认能力，不是本项目准确率或性能证明。

## 实测后的执行策略调整

2026-11-12，持续索引/查询与真实构建、核心测试配对测量未通过3%非劣门槛，部分场景平均退化超过10%。保留原始失败结果，不以CPU单线程或低优先级替代验收。

新增显式 `recall workload`：CLI包裹 node/npm 开发命令，用短生命周期租约阻止新召回计算，50ms检查间隔中断在途模型；开发命令输出走stderr，退出状态走单JSON。不安装系统任务/钩子。直接read/list仍可用。恢复后用户可重试未发布索引，派生编码缓存保留。保护以推迟召回为代价；未经过入口的外部开发负载无法自动识别，不能声称全局无影响。使用同一冻结门槛另存保护模式复测结果。

模型实际固定修订：embedding `75c43b069aac4d136ba6bc1122f995fedcfd2781`，reranker `280bcc27a84e0b898c251e06fddb25171bd9b101`，量化q8；模型文件指纹记录在评价报告。实际执行不依赖Python或GPU。

后续复核发现初次模型校验在父进程整块读取/哈希模型文件，可能与开发命令竞争CPU、I/O和内存。改为1MiB分块哈希，每块核验开发负载租约；取消后不写入已校验缓存，重试必须完成全部校验。模型推理取消同样等待子进程close才释放互斥。此策略的负载数据另存 `stream-check`，旧失败记录不覆盖。分块校验不改变模型权重、向量空间或召回排序参数。
