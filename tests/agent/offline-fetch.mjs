// 仅在离线 CLI 审计子进程预加载：任何意外 transport 都在本机拒绝，不记录参数。
let blocked = 0;
globalThis.fetch = async () => { blocked++; throw new Error('Offline verification forbids external requests'); };
process.on('exit', () => process.stderr.write(`KB_OFFLINE_REQUEST_COUNT:${blocked}\n`));
