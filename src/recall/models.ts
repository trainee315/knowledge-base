import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { CoreManager } from '../core/manager.js';
import { KnowledgeError } from '../core/errors.js';
import { hash, fail } from './scope.js';
import type { ModelLock, Usage } from './types.js';
import { developmentBusy, requireDevelopmentIdle } from './development.js';

const WORKER_TIMEOUT = 180_000; // 单次本机推理硬上限，包括冷启动。
const PREPARE_TIMEOUT = 900_000; // 显式下载允许较长时间，不适用于普通查询。
const OUTPUT_LIMIT = 32 * 1024 * 1024; // 限制子进程输出及失控内存。
const WORKER = fileURLToPath(new URL('./model-worker.js', import.meta.url));
const HASH_BLOCK_BYTES = 1024 * 1024; // 分块校验允许开发负载中断，避免一次分配/哈希整个模型文件。
const checkedFiles = new Map<string, string>(); // 同进程按文件状态缓存校验，改动后重新核验内容哈希。
export const emptyUsage = (): Usage => ({ embeddingTexts: 0, embeddingTokens: 0, rerankPairs: 0, rerankTokens: 0, modelCalls: 0, cacheHits: 0, generationTokens: 0, apiCost: 0 });

/** OS 级互斥随进程退出自动释放；索引和查询不并行抢占模型资源。 */
export async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  const server = createServer(); const name = hash(key).slice(0, 32);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\kb-recall-${name}` : path.join(process.env.TMPDIR ?? '/tmp', `kb-recall-${name}.sock`);
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); }); }
  catch { fail('RECALL_BUSY', '已有召回构建或模型任务运行，请稍后重试'); }
  try { return await run(); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function safeDirectory(dataDir: string, relative: string): Promise<string> {
  const manager = await CoreManager.open(dataDir, { readOnly: true });
  try { await manager.storage.assertSafePath(relative); return manager.storage.resolve(relative); } finally { await manager.close(); }
}
export async function modelLock(dataDir: string): Promise<ModelLock | undefined> {
  const file = await safeDirectory(dataDir, 'cache/recall-models/lock.json');
  try {
    const lock = JSON.parse(await fs.readFile(file, 'utf8')) as ModelLock; const { fingerprint, ...body } = lock;
    if (hash(JSON.stringify(body)) !== fingerprint) fail('MODEL_INVALID', '模型锁定清单损坏');
    if (lock.maxTokens !== 512 || lock.dimensions !== 512 || lock.encodingVersion !== 'bge-cls-pair-v1' || lock.runtime !== '@huggingface/transformers@3.8.1') fail('MODEL_INVALID', '模型编码配置不兼容，请显式重新准备模型并构建索引');
    for (const [relative, expected] of Object.entries(lock.files)) {
      if (relative.split(/[\\/]/).some(p => p === '..' || p === '') || path.isAbsolute(relative)) fail('MODEL_INVALID', '模型清单路径无效');
      const target = await safeDirectory(dataDir, 'cache/recall-models/' + relative); const stat = await fs.stat(target); const signature = `${stat.size}:${stat.mtimeMs}:${expected}`;
      if (checkedFiles.get(target) !== signature) {
        await requireDevelopmentIdle(); const digest = createHash('sha256');
        for await (const bytes of createReadStream(target, { highWaterMark: HASH_BLOCK_BYTES })) { await requireDevelopmentIdle(); digest.update(bytes); }
        if (digest.digest('hex') !== expected) fail('MODEL_INVALID', '模型文件指纹不匹配'); checkedFiles.set(target, signature);
      }
    }
    return lock;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function worker(dataDir: string, request: Record<string, unknown>, prepare = false): Promise<any> {
  await requireDevelopmentIdle();
  const root = await safeDirectory(dataDir, 'cache/recall-models');
  return exclusive('knowledge-base-local-recall-model', () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', CUDA_VISIBLE_DEVICES: '' } });
    let output = '', diagnostic = '', size = 0; let done = false; let aborted: Error | undefined;
    const finish = (error?: Error, result?: unknown) => { if (done) return; done = true; clearTimeout(timer); clearInterval(developmentTimer); error ? reject(error) : resolve(result); };
    // kill只发出终止请求；等待close后才释放全局模型互斥，防止进程短暂重叠。
    const abort = (error: Error) => { aborted ??= error; child.kill(); };
    const timer = setTimeout(() => abort(new Error('MODEL_TIMEOUT')), prepare ? PREPARE_TIMEOUT : WORKER_TIMEOUT);
    const developmentTimer = setInterval(() => { void developmentBusy().then(busy => { if (busy && !done) abort(new KnowledgeError('DEVELOPMENT_BUSY', '开发负载优先，模型计算已取消，请稍后重试')); }, error => { if (!done) abort(error); }); }, 50);
    child.stdout.on('data', bytes => { size += bytes.length; if (size > OUTPUT_LIMIT) abort(new Error('MODEL_OUTPUT_LIMIT')); else output += bytes.toString(); });
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-2000); }); child.on('error', error => { aborted ??= error; }); child.stdin.on('error', abort);
    child.on('close', code => { if (aborted) finish(aborted); else if (code !== 0) finish(new Error('MODEL_EXECUTION_FAILED: ' + diagnostic)); else { try { finish(undefined, JSON.parse(output)); } catch { finish(new Error('MODEL_INVALID_OUTPUT')); } } });
    child.stdin.end(JSON.stringify({ root, ...request }));
  }));
}

export async function prepareModels(dataDir: string) {
  const root = await safeDirectory(dataDir, 'cache/recall-models'); await fs.mkdir(root, { recursive: true });
  const lock: ModelLock = await worker(dataDir, { op: 'prepare' }, true);
  const temporary = path.join(root, 'lock-' + hash(JSON.stringify(lock)).slice(0, 16) + '.tmp');
  await fs.writeFile(temporary, JSON.stringify(lock)); await fs.rename(temporary, path.join(root, 'lock.json'));
  return { ready: true, ...lock };
}

export async function infer(dataDir: string, lock: ModelLock, op: 'embed' | 'rerank', texts: string[], usage: Usage, query?: string | boolean) {
  if (!texts.length) return { values: [], truncated: 0, truncatedInputs: [] };
  usage.modelCalls++;
  const result = await worker(dataDir, { op, lock, texts, ...(op === 'embed' ? { query: query === true } : { queryText: query }) });
  if (result.identity !== lock.fingerprint || !Array.isArray(result.values) || result.values.length !== texts.length) fail('MODEL_INVALID', '模型输出身份或数量错误');
  if (result.resources) {
    usage.modelPeakRssBytes = Math.max(usage.modelPeakRssBytes ?? 0, result.resources.maxRSS * 1024);
    usage.modelCpuMs = (usage.modelCpuMs ?? 0) + (result.resources.userCPUTime + result.resources.systemCPUTime) / 1000;
    usage.modelFsRead = (usage.modelFsRead ?? 0) + result.resources.fsRead; usage.modelFsWrite = (usage.modelFsWrite ?? 0) + result.resources.fsWrite;
  }
  if (op === 'embed') {
    if (result.values.some((v: unknown) => !Array.isArray(v) || v.length !== 512 || v.some(x => typeof x !== 'number' || !Number.isFinite(x)))) fail('MODEL_INVALID', '向量维度或数值错误');
    usage.embeddingTexts += texts.length; usage.embeddingTokens += result.tokens;
  } else { if (result.values.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) fail('MODEL_INVALID', '重排分数错误'); usage.rerankPairs += texts.length; usage.rerankTokens += result.tokens; }
  return result as { values: number[][] | number[]; truncated: number; truncatedInputs: boolean[] };
}
