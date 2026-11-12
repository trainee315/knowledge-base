import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 合成验收的全进程共享预算；脚本与服务顺序调用，发送前即记账，失败不自动重试。
const MAX_CALLS = 32; // 初始campaign为24；Agent调试只允许显式追加一次8次，账本记录原因。
const MAX_OUTPUT_TOKENS = 2048;
const MAX_REQUEST_BYTES = 50000;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const endpoint = new URL(url);
  if (endpoint.hostname === '127.0.0.1') return nativeFetch(url, init);
  if (String(url) !== 'https://api.deepseek.com/chat/completions' || !process.env.KB_CHAIN_LIVE_LEDGER) throw new Error('LIVE_ENDPOINT_NOT_ALLOWED');
  const file = process.env.KB_CHAIN_LIVE_LEDGER;
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const request = JSON.parse(init.body);
  if (ledger.attempts.length >= Math.min(MAX_CALLS, ledger.maximumCalls) || request.max_tokens > MAX_OUTPUT_TOKENS || Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) throw new Error('LIVE_BUDGET_EXHAUSTED');
  const attempt = { ordinal: ledger.attempts.length + 1, at: new Date().toISOString(), model: request.model, requestBytes: Buffer.byteLength(init.body), requestHash: createHash('sha256').update(init.body).digest('hex') };
  ledger.attempts.push(attempt); writeFileSync(file, JSON.stringify(ledger, null, 2));
  try {
    const response = await nativeFetch(url, init); attempt.status = response.status;
    try { const payload = await response.clone().json(); attempt.usage = payload.usage; attempt.actualModel = payload.model; } catch { attempt.unreadable = true; }
    return response;
  } finally { writeFileSync(file, JSON.stringify(ledger, null, 2)); }
};
