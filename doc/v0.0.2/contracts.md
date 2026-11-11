# v0.0.2 公共契约

权威类型见 [src/agent/types.ts](../../src/agent/types.ts)，本版新增AgentApi，不改变资源/通用组织的基础职责。核心基线见 [v0.0.1契约](../v0.0.1/contracts.md)，本版引用修复见下文。

## AgentApi与配置

插件id为agent，业务显式声明直接依赖并调用公开API。generateText接收profile?/messages/signal?/timeoutMs?/maxTokens?/temperature?/reasoning?；generateObject额外接收schema。返回value、profileId/profileRevision、provider{id,version}、model、actualModel、configurationHash、usage{inputTokens,outputTokens,totalTokens}、finishReason=stop和可选requestId。非stop、空白、截断或非法结构不作为成功返回。

model为请求身份，actualModel追踪供应商canonical名；启动捕获profile/provider/messages/schema快照，避免在途配置变更错标。describeProfile无网络，configurationHash只含provider版本/请求model/temperature/maxTokens/reasoning，不含profileId/revision、超时/并发、凭证引用、密钥或指纹。profileRevision仅追踪。

profile白名单为id/revision/providerId/model/credentialEnv/timeoutMs/maxTokens/temperature/reasoning；不接受apiKey/token等额外字段。默认deepseek-default/deepseek-flash、DEEPSEEK_API_KEY环境引用、30秒、1024tokens、temperature0、reasoningoff。客户端timeout上限300秒、maxTokens上限32768；默认实际并发2、等待100。取消/超时覆盖排队和请求，不合作adapter未结束仍占slot。没有隐式重试；错误只暴露固定码/文案及安全HTTP状态，不带原响应或cause。

## Provider与JSON

通用AgentProvider.invoke不泄露DeepSeek DTO；DeepSeek adapter内部使用非流式chat/completions，默认显式thinking disabled。服务加载、预览、状态与配置查询不联网；真实调用必须显式发生。测试可替换provider或注入mock transport，未新增第二真实provider。

支持schema子集：type为object/array/string/number/integer/boolean/null；description/enum/const；properties/required/additionalProperties布尔；items/minItems/maxItems/uniqueItems；minimum/maximum；minLength/maxLength。根必须object，required项须声明properties；循环或非JSON enum/const、未知或不适用规则在网络前拒绝。不支持$ref/oneOf/anyOf/pattern/format等完整JSON Schema能力。JSON mode本身不是schema保证；业务另验词对完整覆盖/唯一/有限0..1。

## 评分与队列

评分scope由tag UUID、显式scoringLogicVersion、provider版本/请求模型/生成语义hash、prompt/schema版本确定。归一化已评分词对存coverage，只有正值存scores；tagRevision/定义hash与profileRevision仅追踪。标签定义变化不自动重评；显式逻辑或生成语义切换进入新scope，旧scope保留。共享tag文件按tag串行，不同scope也受保护；所有批次成功校验后一次提交，失败/取消不写半覆盖。

tasks.prepare是可选本地估算/obsolete能力，不新增强制持久字段，不允许模型请求或业务结果提交。预算前重估缓存命中，跨时限不dispatch；收费队首不阻免费项，耗尽旧scope可obsolete但不重置尝试。maxCalls/score maxRequests提供次数上限；maxCost按声明估算，非实时账单保证。

## 引用保护修复

资源与组织分别以kind+UUID确定身份。正式refs仍只含kind/id/owner，版本绑定的插件须自行校验contentVersion并登记资源UUID引用；该引用保护整份资源与历史。删除检查仅排除同kind同id真正自身，跨kind同UUID的对象仍是外部引用，双向删除/清理均会被阻止。资源历史读取仍为CoreApi.readContent(id,version)，没有历史meta快照。
