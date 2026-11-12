import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 合成控制流夹具：只允许回环服务；所有供应商响应在本进程生成。
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (new URL(url).hostname === '127.0.0.1') return nativeFetch(url, init);
  const request = JSON.parse(init.body);
  const source = JSON.parse(request.messages.at(-1).content);
  if (process.env.KB_CHAIN_CALLS) appendFileSync(process.env.KB_CHAIN_CALLS, JSON.stringify({ positions: source.messages.map(m => m.position), requestHash: createHash('sha256').update(JSON.stringify(request.messages)).digest('hex') }) + '\n');
  const failure = process.env.KB_CHAIN_CALLS + '.fail-next';
  if (existsSync(failure)) { unlinkSync(failure); return new Response('{}', { status: 503 }); }
  const value = { title: '合成链路记录', sections: Array.from({ length: 6 }, (_, i) => ({ heading: `事务${i}`, body: `CHAIN_PROBE_8192：限制为8，测试失败，尚未验证通过。独立条件${i}。`, evidence: source.messages.map(m => m.position) })) };
  return new Response(JSON.stringify({ model: 'offline-fixture', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
};
