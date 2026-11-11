// 允许临时预览的loopback HTTP，封锁所有外部模型/网络请求，不记录请求参数。
const nativeFetch = globalThis.fetch;
let blocked = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { blocked++; throw new Error('Project-tracking verification blocks external network'); }
  return nativeFetch(input, init);
};
process.on('exit', () => { if (process.env.KB_PROJECT_FENCE_SILENT !== '1') process.stderr.write(`KB_PROJECT_EXTERNAL_REQUEST_COUNT:${blocked}\n`); });
