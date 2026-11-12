// 仅供合成实例使用：原样记录给定文字，不代表真实模型的摘要质量。
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (new URL(url).hostname === '127.0.0.1') return nativeFetch(url, init);
  if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('DEMO_ENDPOINT_NOT_ALLOWED');
  const request = JSON.parse(init.body), source = JSON.parse(request.messages.at(-1).content);
  const value = { title: '离线合成演示记录', sections: source.messages.map(m => ({ heading: `合成材料 ${m.position}`, body: m.content, evidence: [m.position] })) };
  return new Response(JSON.stringify({ model: 'offline-demo', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
};
