import { appendFileSync } from 'node:fs';

// 允许临时服务的回环 HTTP，封锁外部请求，只记录计数。
const nativeFetch = globalThis.fetch;
let blocked = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return nativeFetch(input, { ...init, redirect: 'error' });
  blocked++;
  if (process.env.KB_OFFLINE_COUNTER_FILE) appendFileSync(process.env.KB_OFFLINE_COUNTER_FILE, '1\n');
  throw new Error('Project-tracking verification blocks external network');
};
process.on('exit', () => { if (process.env.KB_PROJECT_FENCE_SILENT !== '1') process.stderr.write(`KB_PROJECT_EXTERNAL_REQUEST_COUNT:${blocked}\n`); });
