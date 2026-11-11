# v0.0.2 开发期公共契约（已归档）

> 按用户实施计划完成002收尾发布；当前稳定契约见 [doc/v0.0.2](../../v0.0.2/contracts.md)。本文保留原开发阶段接口裁定与分工历史，不修改001冻结记录。

通用接口权威定义为 `src/agent/types.ts`，不修改v0.0.1归档。插件id `agent`，manifest version1.0.0、apiVersion1、独立dataVersion1。任意业务显式声明依赖agent后使用 `getDependency<AgentApi>('agent')`，不读取其内部文件。

`generateText({profile?,messages,signal?,timeoutMs?,maxTokens?,temperature?,reasoning?})` 与 `generateObject<T>({...上述输入,schema})` 返回 `{value,profileId,profileRevision,provider:{id,version},model,actualModel?,configurationHash,usage:{inputTokens,outputTokens,totalTokens},finishReason:'stop',requestId?}`。JSON mode只保证传输模式，通用层继续检查空白/截断/JSON语法/schema子集；业务自身校验评分值域/词对覆盖。业务prompt不放入adapter或agent基础设施。

`describeProfile(id?)` 同步返回无网络的身份快照，可用于缓存scope；`listProfiles/getProfile/status`不联网，status只暴露凭证引用和是否已配置。`configureProfile/removeProfile`持久化非秘密配置；profile含id/revision/providerId/model/credentialEnv/timeoutMs/maxTokens/temperature/reasoning，不允许apiKey/token等额外字段。默认deepseek profile，model deepseek-flash、环境引用DEEPSEEK_API_KEY、非思考；没有任何load/refresh自动请求。

默认profile id为`deepseek-default`。configurationHash只含providerId/version、请求model、temperature/maxTokens/reasoning；不含profileId/revision、timeout、凭证引用或任何密钥/指纹。profileRevision仅追踪，不作为评分缓存版本。生成启动捕获profile/provider/messages/schema快照；调用级生成参数覆盖会体现在结果hash。结果model保持请求/配置语义身份，actualModel独立追踪HTTP实际模型名；canonical别名不改变缓存身份。

`AgentProvider.invoke`为可替换通用transport接口；DeepSeek adapter内部处理chat/completions DTO。生产默认official endpoint，测试可通过adapter构造注入fetch/endpoint/credential resolver。`AgentService`已提供可注入providers与profiles及并发/队列上限，默认实际并发2/等待100；测试stub不新增第二真实provider。Abort/timeout覆盖排队和请求，不自动重试；非合作adapter未结束时仍保留并发slot，不记录prompt/密钥/响应正文/cause到错误trace。默认总超时30秒、maxTokens1024/temperature0/reasoningoff，客户端maxTokens上限32768、超时上限300秒。

CLI：`agent status`、`agent profile list/get/set/delete`、`agent config get/set`、`agent generate text/object --input ...`；文本/JSON输入走统一CLI对象。调用显式发生，默认relations仍offline，启用DeepSeek必须业务明确选择。status/profile list/get/config get、relation get-config以readOnly打开，不联网且零正式写入，缺key仍可检查。profile/config set只写非秘密配置，不请求模型。

Schema子集：type为object/array/string/number/integer/boolean/null；description、enum、const；object的properties/required/additionalProperties布尔；array的items/minItems/maxItems/uniqueItems；number/integer的minimum/maximum；string的minLength/maxLength。根必须object；required项需声明properties。规则类型/作用位置及有限约束先校验，非JSON或循环enum/const拒绝；不支持$ref/oneOf/anyOf/pattern/format等，未知规则网络前报AGENT_UNSUPPORTED_SCHEMA，不能将DeepSeek JSON mode当完整schema保证。

关系缓存：归一化关键词词对按tag UUID+显式scoringLogicVersion+provider版本/请求模型/生成语义hash+prompt/schema版本划分scope；0只存coverage，正分才存scores；已覆盖对重复0新请求，仅补缺对。tagRevision/定义hash仅追踪并提示，不自动使旧对失效；profileId/revision/凭证/超时不入scope。更换生成语义或显式升级logic version后使用新scope，旧scope保留。人工最终归属仍独立保护。默认offline且自动任务maxCalls0；显式agent模式仅改变选择，仍需显式次数预算或直接score调用才可能请求。任务prepare只本地get/plan，预算前重估覆盖；maxRequests硬上限防配置竞态。maxCost按声明估算，非实时美元账单上限。

## 最小CLI示例

先在进程环境安全配置DEEPSEEK_API_KEY；profile仅引用变量名，不读取仓库外凭证文件。不要把值写入JSON输入、命令参数、profile、资源或Git，下面不包含任何密钥值。

```powershell
.\cli.bat agent status --json
.\cli.bat agent profile get --id deepseek-default --json
.\cli.bat agent profile set --id deepseek-default --model deepseek-flash --max-tokens 512 --reasoning off --json
```

上述无网络；以下为显式真实调用示例，会发请求且可能收费，默认测试和mock示例不会执行它们，本轮真实验证已关闭不要重复：

```powershell
.\cli.bat agent generate text --profile deepseek-default --input examples/agent/text.input.json --json
.\cli.bat agent generate object --profile deepseek-default --input examples/agent/object.input.json --json
.\cli.bat relation configure --mode agent --agent-profile deepseek-default --json
.\cli.bat relation score --id 标签UUID --max-calls 1 --input 关键词输入.json --json
```

关键词输入为`{"keywords":["纹理","压缩"]}`。恢复离线用`relation configure --mode offline`，显式重评用`relation configure --scoring-logic-version 新版本`。无费用通用示例：`node examples/agent/generic.mjs`。

所有权：core负责人src/agent（独立验证文件除外）、src/plugins/agent、组合入口、共享依赖和本目录readme/contracts/implementation/execution；business负责人relations/organizer/缓存及其测试；ui_ppc负责人src/agent/provider.integration.test.ts、tests/agent/live-smoke.mjs、examples/agent及agent-verification.md。真实付费验证统一ui控制总计5请求以内，infra作者仅mock。
