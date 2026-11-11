# v0.0.2 Agent基础设施与关系接入

状态：已完成。按用户实施计划收尾发布0.0.2，实际能力与局限归档到 [v0.0.2](../../v0.0.2/readme.md)，实现提交为ca79363。以下保留开发阶段范围与验证历史，原“未发布/不提交”约束仅适用于当时阶段；001冻结归档仍不改，003不包含在本版。

首版新增通用agent基础设施插件，供任意业务调用，文本与JSON结构化生成、profiles非秘密配置、环境凭证引用、统一provider/model/usage/finishReason、取消/超时/并发和脱敏错误。DeepSeek为唯一真实adapter，业务prompt/schema与API DTO分离。首个业务接入为词对关系评分，默认仍offline，DeepSeek必须显式配置；词对缓存及零分稀疏由业务负责。

不做工具自主执行、规划、记忆、完整Agent运行时或第二真实provider。加载、只读查询、预览与配置操作不自动联网。用户授权少量真实验证，由测试负责人统一控制不超过5请求；凭证由外部runner临时注入env，绝不进入profile、store、备份、日志或Git。

实际接口见 [contracts](./contracts.md)，进度/责任/证据见 [execution](./execution.md)；旧版能力以 [v0.0.1归档](../../v0.0.1/readme.md) 为准。

开发冻结验证59/59、HTTP13保留；发布补同UUID跨kind保护三回归后，完整62/62、类型检查/构建、正式CLI0.0.2和9插件Chrome/PPC2通过。真实验证仍只3请求462tokens且closed，发布不追加；无费用示例为`node examples/agent/generic.mjs`。当前发布检查见 [release证据](../../../artifacts/verification/v0.0.2/release/test.log)，开发证据按原阶段保留。

已评分词对含零分覆盖均复用，只补缺对；标签定义修改只保留追踪/提示，不自动重评。显式logic版本或provider/model/真正生成语义变化才进入新scope；凭证引用/超时/profileRevision不是评分版本。默认仍offline，agent模式和实际预算/调用需显式选择。
