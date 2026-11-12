import { appendFileSync } from 'node:fs';

// 离线审计允许本机服务，阻断外部请求，只记录计数。
const nativeFetch = globalThis.fetch;
let blocked = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return nativeFetch(input, { ...init, redirect: 'error' });
  blocked++;
  if (process.env.KB_OFFLINE_COUNTER_FILE) appendFileSync(process.env.KB_OFFLINE_COUNTER_FILE, '1\n');
  throw new Error('Offline verification forbids external requests');
};
process.on('exit', () => process.stderr.write(`KB_OFFLINE_REQUEST_COUNT:${blocked}\n`));
