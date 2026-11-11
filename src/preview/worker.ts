import { access, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openApplication } from '../index.js';
import { createPreviewServer } from './server.js';
import { saveState, removeState } from './index.js';
import { acquirePreviewMutex } from './mutex.js';

async function start(): Promise<void> {
  const args = process.argv.slice(2);
  const dataDir = await realpath(resolve(args[args.indexOf('--data-dir') + 1]));
  const port = Number(args[args.indexOf('--port') + 1]);
  const webDir = fileURLToPath(new URL('../web/', import.meta.url));
  await access(resolve(webDir, 'index.html'));
  const release = await acquirePreviewMutex(dataDir, 'instance', 3000);
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  let preview: Awaited<ReturnType<typeof createPreviewServer>> | undefined;
  try {
    app = await openApplication(dataDir, { readOnly: true });
    preview = await createPreviewServer({ app, dataDir, webDir, port, onClose: async () => { try { await removeState(dataDir, preview?.token); } finally { await release(); } } });
    const state = { running: true, dataDir, pid: process.pid, url: preview.url, port: preview.port, token: preview.token };
    await saveState(state);
    process.send?.({ ok: true, state });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void preview?.close(); });
  } catch (error) { if (preview) await preview.close(); else { try { await app?.close(); } finally { await release(); } } throw error; }
}
start().catch((error: any) => { process.send?.({ ok: false, code: error.code, error: error.message }); process.exitCode = 1; process.disconnect?.(); });
