# v0.0.2 已发布版本

按用户实施计划指令先收尾并发布0.0.2，再开始0.0.3。发布日期2026-11-11；package与CLI版本均为0.0.2，annotated tag为 `v0.0.2`。实现提交与版本关系见 [版本历史](../version-history.md)。本档案记录实际交付，原开发讨论与证据留在 [需求历史](../新增需求/v0.0.2/readme.md)。

## 本版新增

- 通用agent基础设施插件：任意业务经显式依赖调用generateText/generateObject；统一provider/model/usage/finishReason，profile非秘密配置与只读状态查询。通用service、provider transport和业务prompt分离。
- 首个真实适配器DeepSeek，默认deepseek-flash、非思考、有限tokens/超时。凭证仅引用进程环境，不保存密钥或reasoning；加载、预览、状态和配置查询不自动联网，无隐式重试。
- JSON输出本地schema子集校验，空白/截断/非法JSON/不匹配明确失败；取消与排队/并发控制、固定脱敏错误，支持mock provider替换。
- relations首接入：默认仍offline，显式选择agent才可调用模型。归一化词对只补缺项，0分只存coverage，正分稀疏保存；稳定评分scope排除凭证/超时/profile修订，标签定义变化仅提示与追踪，显式逻辑版本或生成语义变化使用新scope。
- v001评分迁移、future schema保护、按tag串行避免跨scope覆盖、完整批次验证后提交，失败/取消不保存半覆盖。最终人工归属保护保持不变。
- 通用tasks.prepare在预算前本地估算/淘汰旧任务；默认maxCalls0阻止自动模型调用，预算不足不阻后续免费任务，prepare跨时限不dispatch，耗尽旧scope可无费用淘汰。
- 修复同UUID跨kind引用删除保护：资源与组织身份按kind+id区分；组织→资源阻purge，资源→组织阻delete，真正自身引用可随自身删除。

原资源、历史内容、组织/方式、备份恢复、单写者、只读预览和PPC转发继续保留；本版完整回归62/62、类型检查/构建及必要浏览器/PPC验证通过。真实验证沿用已关闭的3次synthetic请求，发布不追加真实API调用。

## 入口

- [运行说明](./running.md)：无网络配置与显式调用示例。
- [公共契约](./contracts.md)：AgentApi、schema、缓存与引用语义。
- [验证与边界](./verification.md)：62项回归、独立审计与真实账本。
- [v0.0.1归档](../v0.0.1/readme.md)：基础能力历史；本版不改旧档案或旧证据。

本版不是自主Agent运行时，不包含工具自动执行、规划、记忆、第二真实provider或实时美元账单硬限。项目跟踪属于后续0.0.3，不在本版交付范围。
