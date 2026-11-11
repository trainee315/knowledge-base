import assert from 'node:assert/strict';
import { AgentService } from '../../dist/agent/service.js';

// 默认只用本地 mock，展示同一通用接口服务摘要和结构化提取，不会调用付费 API。
const provider = {
  id: 'example-mock', version: '1',
  async invoke(input, signal) {
    signal.throwIfAborted();
    return {
      text: input.output === 'text' ? '合成摘要：资源已保存，等待明确的归属判断。' : JSON.stringify({ topic: 'knowledge', labels: ['synthetic', 'preview'] }),
      model: input.profile.model, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  },
};
const service = new AgentService({ providers: [provider], profiles: [{ id: 'example', revision: 1, providerId: provider.id, model: 'synthetic-model', credentialEnv: 'EXAMPLE_UNUSED_KEY', timeoutMs: 1000, maxTokens: 256, temperature: 0, reasoning: 'off' }] });
const summary = await service.generateText({ profile: 'example', messages: [{ role: 'user', content: '概括这段合成材料：资源已保存；评分发现候选；人工确认归属。' }] });
const extracted = await service.generateObject({ profile: 'example', messages: [{ role: 'user', content: '将这段合成材料提取为 json：topic knowledge；labels synthetic 和 preview。' }], schema: {
  type: 'object', properties: { topic: { type: 'string', minLength: 1 }, labels: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true } }, required: ['topic', 'labels'], additionalProperties: false,
} });
assert.equal(summary.provider.id, provider.id); assert.equal(extracted.provider.id, provider.id);
console.log(JSON.stringify({ provider: provider.id, paidRequests: 0, summary: summary.value, extracted: extracted.value }, null, 2));
