import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { KnowledgeError, assert } from './errors.js';

// 活跃写入读取最多等待五秒，避免读取跨文件事务中间态。
const READ_RETRIES = 100;
const READ_DELAY_MS = 50;
const RENAME_RETRIES = 40; // Windows 读取句柄短暂占用目标时重试原子替换。
interface Write { file: string; value: string | null; encoding?: 'utf8' | 'base64' }
interface Journal { id: string; writes: Write[] }
export type StorageMutation = { file: string; value: Buffer | string | null };
/** 单写者事务：journal 为重做日志，恢复时重复执行安全。 */
export class FileStorage {
  private lockToken?: string;
  private writerMutex?: Server;
  private canonicalRoot?: string;
  private pending = Promise.resolve();
  constructor(public readonly root: string, public readonly readOnly = false, private failAfterWrites?: number) {}
  resolve(file: string): string {
    const result = path.resolve(this.root, file);
    assert(result.startsWith(path.resolve(this.root) + path.sep), 'INVALID_PATH', '数据路径必须位于数据目录内');
    return result;
  }
  /** 词法边界之外再拒绝数据根下面的链接/reparse，阻止恢复沿 junction 写到外部。 */
  async assertSafePath(file: string): Promise<void> {
    const target = this.resolve(file);
    let actualRoot: string;
    try { actualRoot = await fs.realpath(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.canonicalRoot) return; throw error; }
    const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!this.canonicalRoot) this.canonicalRoot = actualRoot;
    assert(identity(this.canonicalRoot) === identity(actualRoot), 'UNSAFE_PATH', '数据目录实际位置已改变');
    let ancestor = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep)) {
      ancestor = path.join(ancestor, segment);
      try { const stat = await fs.lstat(ancestor); assert(!stat.isSymbolicLink(), 'UNSAFE_PATH', '数据目录内部不允许符号链接或junction', { file, ancestor }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
  }
  async readBytes(file: string): Promise<Buffer> { await this.assertSafePath(file); return fs.readFile(this.resolve(file)); }
  async init(): Promise<void> {
    if (this.readOnly) return;
    await fs.mkdir(this.root, { recursive: true });
    // OS 持有 IPC 名称直至进程结束，消除失效磁盘锁读后删除的竞争窗口。
    const canonicalRoot = await fs.realpath(this.root);
    this.canonicalRoot = canonicalRoot;
    const identity = createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest('hex');
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\knowledge-base-writer-${identity}` : process.platform === 'linux' ? `\0knowledge-base-writer-${identity}` : path.join(this.root, '.writer.socket');
    const mutex = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => { mutex.once('error', reject); mutex.listen(endpoint, () => { mutex.removeListener('error', reject); resolve(); }); });
      mutex.unref(); this.writerMutex = mutex;
    } catch (error) {
      mutex.close();
      if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new KnowledgeError('WRITER_LOCKED', '数据目录已有写入进程');
      throw error;
    }
    const lock = this.resolve('.writer.lock');
    try {
      await this.assertSafePath('.writer.lock');
      this.lockToken = randomUUID();
      const handle = await fs.open(lock, 'w');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); await handle.close();
      await this.recover();
    } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    await this.pending;
    try {
      if (this.lockToken) { const lock = this.resolve('.writer.lock'); try { const info = JSON.parse(await fs.readFile(lock, 'utf8')); if (info.token === this.lockToken) await fs.unlink(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    } finally { this.lockToken = undefined; const mutex = this.writerMutex; this.writerMutex = undefined; if (mutex) await new Promise<void>((resolve, reject) => mutex.close(error => error ? reject(error) : resolve())); }
  }
  async readJson<T>(file: string, fallback?: T): Promise<T> {
    try { return JSON.parse((await this.readBytes(file)).toString('utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
  }
  async files(directory: string): Promise<string[]> {
    try {
      await this.assertSafePath(directory);
      const entries = await fs.readdir(this.resolve(directory), { withFileTypes: true });
      const result: string[] = [];
      for (const item of entries) {
        const file = path.posix.join(directory, item.name);
        assert(!item.isSymbolicLink(), 'UNSAFE_PATH', '正式数据目录内部不允许符号链接或junction', { file });
        if (item.isDirectory()) result.push(...await this.files(file)); else if (item.isFile()) result.push(file);
      }
      return result.sort();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  /** 无锁读者在无活动 journal 且提交序号未变时得到完整快照。 */
  async snapshot<T>(read: () => Promise<T>): Promise<T> {
    if (!this.readOnly) return read();
    for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
      const activeBefore = await this.files('journal');
      const before = await this.readJson('state/generation.json', 0);
      if (activeBefore.some(file => file.endsWith('.json'))) { await new Promise(resolve => setTimeout(resolve, READ_DELAY_MS)); continue; }
      try {
        const result = await read();
        const after = await this.readJson('state/generation.json', 0);
        if (before === after && !(await this.files('journal')).some(file => file.endsWith('.json'))) return result;
      } catch (error) {
        if (before === await this.readJson('state/generation.json', 0) && !(await this.files('journal')).some(file => file.endsWith('.json'))) throw error;
      }
    }
    throw new KnowledgeError('READ_BUSY', '数据目录正在恢复或写入，请稍后重试', undefined, 1);
  }
  async transaction(mutations: StorageMutation[]): Promise<void> {
    assert(!this.readOnly && this.lockToken, 'READ_ONLY', '只读会话不能写入');
    const run = this.pending.then(async () => {
      const generation = await this.readJson('state/generation.json', 0);
      const journal: Journal = { id: randomUUID(), writes: [...mutations.map(item => ({ file: item.file, value: Buffer.isBuffer(item.value) ? item.value.toString('base64') : item.value, encoding: Buffer.isBuffer(item.value) ? 'base64' as const : 'utf8' as const })), { file: 'state/generation.json', value: JSON.stringify(generation + 1), encoding: 'utf8' }] };
      for (const write of journal.writes) await this.assertSafePath(write.file);
      const file = `journal/${journal.id}.json`;
      await this.atomic(file, Buffer.from(JSON.stringify(journal)));
      await this.apply(journal, true);
      await fs.unlink(this.resolve(file));
    });
    this.pending = run.catch(() => {}); return run;
  }
  private async atomic(file: string, value: Buffer): Promise<void> {
    const target = this.resolve(file); await fs.mkdir(path.dirname(target), { recursive: true });
    await this.assertSafePath(file);
    const temp = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await this.assertSafePath(file);
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, target); break; }
      catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= RENAME_RETRIES) throw error; await new Promise(resolve => setTimeout(resolve, 10 + attempt * 2)); }
    }
  }
  private async apply(journal: Journal, inject = false): Promise<void> {
    let count = 0;
    for (const write of journal.writes) {
      await this.assertSafePath(write.file);
      if (write.value === null) await fs.rm(this.resolve(write.file), { force: true });
      else await this.atomic(write.file, Buffer.from(write.value, write.encoding ?? 'utf8'));
      if (inject && this.failAfterWrites !== undefined && ++count >= this.failAfterWrites) { this.failAfterWrites = undefined; throw new KnowledgeError('INJECTED_FAILURE', '事务失败注入', { journal: journal.id }, 1); }
    }
  }
  private async recover(): Promise<void> {
    for (const file of await this.files('journal')) {
      if (!file.endsWith('.json')) continue;
      const journal = await this.readJson<Journal>(file);
      assert(Array.isArray(journal.writes), 'INVALID_JOURNAL', '操作日志损坏');
      await this.apply(journal); await fs.unlink(this.resolve(file));
    }
  }
}
