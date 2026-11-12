import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AutoTokenizer, AutoModel, AutoModelForSequenceClassification, env } from '@huggingface/transformers';

const EMBEDDING_ID = 'Xenova/bge-small-zh-v1.5';
const RERANKER_ID = 'Xenova/bge-reranker-base';
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
const RUNTIME = '@huggingface/transformers@3.8.1';
const BATCH_SIZE = 8; // 限制单批内存；进程在请求结束后退出。
const MAX_TOKENS = 512; // 两个候选模型的输入上限，截断计数必须返回。

async function main() {
  let source = ''; for await (const chunk of process.stdin) source += chunk;
  const request = JSON.parse(source); const root: string = request.root;
  env.cacheDir = root; env.allowRemoteModels = request.op === 'prepare';
  const options = (revision: string): any => ({ revision, dtype: 'q8', device: 'cpu', local_files_only: request.op !== 'prepare', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' } });
  if (request.op === 'prepare') {
    const identity = async (id: string) => {
      const response = await fetch('https://huggingface.co/api/models/' + id, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('MODEL_REVISION_UNAVAILABLE');
      const value: any = await response.json(); if (!/^[a-f0-9]{40}$/.test(value.sha)) throw new Error('MODEL_REVISION_INVALID');
      return { id, revision: value.sha as string };
    };
    const embedding = await identity(EMBEDDING_ID), reranker = await identity(RERANKER_ID);
    for (const [kind, identity] of [['embedding', embedding], ['reranker', reranker]] as const) {
      await AutoTokenizer.from_pretrained(identity.id, options(identity.revision));
      const model = await (kind === 'embedding' ? AutoModel : AutoModelForSequenceClassification).from_pretrained(identity.id, options(identity.revision));
      await model.dispose();
    }
    const files: Record<string, string> = {};
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('MODEL_UNSAFE_PATH');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name !== 'lock.json' && !entry.name.endsWith('.tmp')) files[path.relative(root, file).replaceAll('\\', '/')] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      }
    }; await walk(root);
    const config = { runtime: RUNTIME, embedding, reranker, dtype: 'q8', pooling: 'cls', normalize: true, queryPrefix: QUERY_PREFIX, maxTokens: MAX_TOKENS, dimensions: 512, encodingVersion: 'bge-cls-pair-v1', files };
    return { ...config, fingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
  }
  const lock = request.lock; const identity = request.op === 'embed' ? lock.embedding : lock.reranker;
  const tokenizer = await AutoTokenizer.from_pretrained(identity.id, options(identity.revision));
  const model = await (request.op === 'embed' ? AutoModel : AutoModelForSequenceClassification).from_pretrained(identity.id, options(identity.revision));
  const values: number[][] | number[] = []; let tokens = 0; let truncated = 0; const truncatedInputs: boolean[] = [];
  try {
    for (let index = 0; index < request.texts.length; index += BATCH_SIZE) {
      const texts: string[] = request.texts.slice(index, index + BATCH_SIZE);
      const left = request.op === 'embed' ? texts.map(t => request.query ? lock.queryPrefix + t : t) : texts.map(() => request.queryText);
      const right = request.op === 'rerank' ? texts : undefined;
      for (let i = 0; i < left.length; i++) {
        const full = await tokenizer(left[i], { ...(right ? { text_pair: right[i] } : {}), truncation: false });
        const length = full.input_ids.data.length; tokens += Math.min(length, MAX_TOKENS); truncatedInputs.push(length > MAX_TOKENS); if (length > MAX_TOKENS) truncated++;
      }
      const input = await tokenizer(left, { ...(right ? { text_pair: right } : {}), padding: true, truncation: true, max_length: MAX_TOKENS });
      const output = await model(input);
      if (request.op === 'embed') {
        const tensor = output.last_hidden_state; const [, sequence, dimension] = tensor.dims;
        for (let i = 0; i < texts.length; i++) {
          const vector = Array.from(tensor.data.slice(i * sequence * dimension, i * sequence * dimension + dimension)) as number[];
          const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
          if (!norm || !Number.isFinite(norm)) throw new Error('MODEL_VECTOR_INVALID');
          (values as number[][]).push(vector.map(x => x / norm));
        }
      } else (values as number[]).push(...Array.from(output.logits.data) as number[]);
    }
    return { values, tokens, truncated, truncatedInputs, identity: lock.fingerprint, resources: process.resourceUsage() };
  } finally { await model.dispose(); }
}
main().then(value => process.stdout.write(JSON.stringify(value)), error => { process.stderr.write('LOCAL_MODEL_EXECUTION_FAILED: ' + String(error?.message ?? 'unknown').slice(0, 1000) + '\n'); process.exitCode = 1; });
