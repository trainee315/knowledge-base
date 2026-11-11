import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KnowledgeError } from '../core/errors.js';

// 独立于业务 writer 的两个命名空间：CLI 操作串行化，worker 实例终生互斥。
const MUTEX_RETRY_MS = 30;
export async function acquirePreviewMutex(dataDir: string, scope: 'operation' | 'instance', timeoutMs = 30_000): Promise<() => Promise<void>> {
  const identity = createHash('sha256').update(process.platform === 'win32' ? dataDir.toLowerCase() : dataDir).digest('hex');
  const name = `knowledge-base-preview-${scope}-${identity}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : process.platform === 'linux' ? `\0${name}` : join(dataDir, `.${scope}.preview.socket`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const mutex = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((done, fail) => { mutex.once('error', fail); mutex.listen(endpoint, () => { mutex.removeListener('error', fail); done(); }); });
      mutex.unref();
      return () => new Promise<void>((done, fail) => mutex.close((error) => error ? fail(error) : done()));
    } catch (error) {
      mutex.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw new KnowledgeError('PREVIEW_BUSY', `预览${scope === 'instance' ? '实例' : '生命周期操作'}仍在运行，请稍后重试`);
      await new Promise((done) => setTimeout(done, MUTEX_RETRY_MS));
    }
  }
}
