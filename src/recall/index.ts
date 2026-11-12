import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreManager } from '../core/manager.js';
import { hash, snapshot, fail } from './scope.js';
import { split, terms, ftsQuery, SPLITTER_VERSION, TOKENIZER_VERSION } from './fragments.js';
import { modelLock, infer, emptyUsage, safeDirectory, exclusive } from './models.js';
import type { Fragment, ModelLock, Usage } from './types.js';
import { requireDevelopmentIdle } from './development.js';

const INDEX_SCHEMA = 1; // 不兼容变更必须拒绝旧代次并要求显式重建。
const ENCODING_BATCH = 32; // 每批完成即写派生缓存，故障恢复不重复已完成编码。
export interface IndexPointer { schema: number; generation: string; fingerprint: string; splitter: string; tokenizer: string; model?: string; builtAt: string; records: number; fragments: number; skipped: string[]; usage: Usage; truncatedEncodingInputs?: number }

export async function pointer(dataDir: string): Promise<IndexPointer | null> {
  const manager = await CoreManager.open(dataDir, { readOnly: true });
  try { const value = await manager.pluginStore('recall').read<IndexPointer | null>('active-index', null, 'cache'); if (value && (value.schema !== INDEX_SCHEMA || !/^[a-f0-9-]{36}$/.test(value.generation))) fail('INDEX_INVALID', '索引代次无效'); return value; } finally { await manager.close(); }
}
export async function openIndex(dataDir: string) {
  const active = await pointer(dataDir); if (!active) return null;
  const file = await safeDirectory(dataDir, `cache/recall/${active.generation}.sqlite`);
  try { const db = new DatabaseSync(file, { readOnly: true }); return { active, db }; }
  catch { fail('INDEX_INVALID', '索引文件不可用，请显式重建'); }
}
export async function indexStatus(dataDir: string) {
  const active = await pointer(dataDir); const current = await snapshot(dataDir);
  let exists = false; if (active) { try { exists = (await fs.stat(await safeDirectory(dataDir, `cache/recall/${active.generation}.sqlite`))).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  const tokenizerCompatible = !active || active.tokenizer === TOKENIZER_VERSION;
  return { ready: !!active && exists && tokenizerCompatible, stale: !!active && (active.fingerprint !== current.fingerprint || !tokenizerCompatible), tokenizerCompatible, expectedTokenizer: TOKENIZER_VERSION, ...(active ? { generation: active.generation, tokenizer: active.tokenizer, builtAt: active.builtAt, fragments: active.fragments, vectors: !!active.model } : {}), unknownScopeRecords: current.records.filter(r => !r.projectId).length };
}
const encodedText = (f: Fragment) => [f.title, f.headings.join(' / '), f.text].join('\n');
const cacheKey = (lock: ModelLock, text: string) => hash(JSON.stringify([lock.fingerprint, 'document', text]));

/** 模型执行只写派生缓存；正式库仅在最终校验与发布指针时短暂加锁。 */
export async function buildIndex(dataDir: string, vectors: boolean, rebuild: boolean) {
  await requireDevelopmentIdle();
  return exclusive('build:' + await fs.realpath(dataDir), async () => {
    const started = performance.now(); const source = await snapshot(dataDir, true);
    const splitter = SPLITTER_VERSION + ':' + hash(JSON.stringify(source.config.chunking ?? null));
    const root = await safeDirectory(dataDir, 'cache/recall'); await fs.mkdir(root, { recursive: true });
    const cacheRoot = await safeDirectory(dataDir, 'cache/recall-vectors'); await fs.mkdir(cacheRoot, { recursive: true });
    const lock = vectors ? await modelLock(dataDir) : undefined;
    if (vectors && !lock) fail('MODEL_NOT_READY', '先执行 recall model prepare');
    const old = await openIndex(dataDir).catch(error => { if (rebuild) return null; throw error; });
    const fragments: Fragment[] = []; let reusedFragments = 0;
    try {
      for (const record of source.records) {
        await requireDevelopmentIdle();
        let prior: Fragment[] = [];
        if (!rebuild && old?.active.splitter === splitter) prior = (old.db.prepare('SELECT payload FROM fragments WHERE resource_id=? AND version=? AND hash=? ORDER BY ordinal').all(record.resourceId, record.contentVersion, record.contentHash) as { payload: string }[]).map(row => JSON.parse(row.payload));
        if (prior.length) { reusedFragments += prior.length; fragments.push(...prior.map(f => ({ ...f, ...record, text: f.text }))); }
        else fragments.push(...split(record, source.config.chunking));
      }
    } finally { old?.db.close(); }
    const usage = emptyUsage(); const encoded = new Map<string, number[]>(); const missing: { key: string; text: string }[] = []; let truncated = 0;
    if (lock) {
      const unique = new Map(fragments.map(f => [cacheKey(lock, encodedText(f)), encodedText(f)]));
      for (const [key, text] of unique) {
        try { const file = await safeDirectory(dataDir, `cache/recall-vectors/${key}.json`); const cached = JSON.parse(await fs.readFile(file, 'utf8')); if (cached.identity !== lock.fingerprint || typeof cached.truncated !== 'boolean' || cached.key !== key || !Array.isArray(cached.vector) || cached.vector.length !== 512 || cached.vector.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('invalid cache'); encoded.set(key, cached.vector); usage.cacheHits++; if (cached.truncated) truncated++; }
        catch (error) { if ((error as { code?: string }).code === 'UNSAFE_PATH') throw error; missing.push({ key, text }); }
      }
      for (let start = 0; start < missing.length; start += ENCODING_BATCH) {
        const batch = missing.slice(start, start + ENCODING_BATCH); const result = await infer(dataDir, lock, 'embed', batch.map(x => x.text), usage); truncated += result.truncated;
        for (let i = 0; i < batch.length; i++) { const { key } = batch[i]; const vector = result.values[i] as number[]; encoded.set(key, vector); const file = path.join(cacheRoot, key + '.json'); const temporary = file + '.' + randomUUID() + '.tmp'; await fs.writeFile(temporary, JSON.stringify({ key, identity: lock.fingerprint, vector, truncated: result.truncatedInputs[i] })); await fs.rename(temporary, file); }
      }
    }
    const generation = randomUUID(); const file = path.join(root, generation + '.sqlite'); const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE fragments(id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL, vector TEXT); CREATE INDEX by_resource ON fragments(resource_id); CREATE VIRTUAL TABLE lexical USING fts5(title,body); BEGIN IMMEDIATE');
      const insert = db.prepare('INSERT INTO fragments VALUES (?,?,?,?,?,?,?)'); const fulltext = db.prepare('INSERT INTO lexical(rowid,title,body) VALUES (?,?,?)');
      for (const f of fragments) { const row = insert.run(f.id, f.resourceId, f.contentVersion, f.contentHash, f.ordinal, JSON.stringify(f), lock ? JSON.stringify(encoded.get(cacheKey(lock, encodedText(f)))) : null); fulltext.run(row.lastInsertRowid, terms(f.title + ' ' + f.headings.join(' ')).join(' '), terms(f.text).join(' ')); }
      db.exec('COMMIT');
    } finally { db.close(); }
    const active: IndexPointer = { schema: INDEX_SCHEMA, generation, fingerprint: source.fingerprint, splitter, tokenizer: TOKENIZER_VERSION, ...(lock ? { model: lock.fingerprint } : {}), builtAt: new Date().toISOString(), records: source.records.length, fragments: fragments.length, skipped: source.skipped, usage, truncatedEncodingInputs: truncated };
    const publisher = await CoreManager.open(dataDir);
    try {
      await requireDevelopmentIdle();
      const current = await snapshot(dataDir);
      if (current.fingerprint !== source.fingerprint) fail('INDEX_SOURCE_CHANGED', '构建期间源数据或范围配置变化，请重试；旧代次保持可用');
      await publisher.pluginStore('recall').write('active-index', active, 'cache');
    } finally { await publisher.close(); }
    // 保留当前及上一代；已打开的旧读者在Windows占用时延后清理，不影响发布。
    for (const name of await fs.readdir(root)) if (/^[a-f0-9-]{36}\.sqlite$/.test(name) && name !== generation + '.sqlite' && name !== old?.active.generation + '.sqlite') {
      const target = await safeDirectory(dataDir, 'cache/recall/' + name);
      try { await fs.unlink(target); } catch (error) { if (!['EPERM', 'EBUSY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    return { ...active, reusedFragments, vectors: !!lock, warnings: !lock && old?.active.model ? ['VECTOR_INDEX_REMOVED:本次显式全文构建未发布向量；需要向量时build --vectors'] : [], truncatedEncodingInputs: truncated, durationMs: performance.now() - started };
  });
}

/** 允许资源集合参与 SQL 过滤后才排序/LIMIT，其他项目不能挤占 Top K。 */
export function lexical(db: DatabaseSync, ids: string[], query: string, limit: number, titleWeight = 2) {
  const match = ftsQuery(query); if (!ids.length || !match) return [];
  const rows = db.prepare('SELECT f.payload, bm25(lexical,?,1.0) AS score FROM lexical JOIN fragments f ON f.rowid=lexical.rowid WHERE lexical MATCH ? AND f.resource_id IN (SELECT value FROM json_each(?)) ORDER BY score,f.id LIMIT ?').all(titleWeight, match, JSON.stringify(ids), limit) as { payload: string; score: number }[];
  return rows.map(r => ({ fragment: JSON.parse(r.payload) as Fragment, score: -r.score }));
}
export function scopedFragments(db: DatabaseSync, ids: string[]): { fragment: Fragment; vector?: number[] }[] {
  return (db.prepare('SELECT payload,vector FROM fragments WHERE resource_id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(ids)) as { payload: string; vector: string | null }[]).map(row => ({ fragment: JSON.parse(row.payload), ...(row.vector ? { vector: JSON.parse(row.vector) } : {}) }));
}
