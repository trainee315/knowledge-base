import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { safeDirectory } from '../recall/models.js';
import { KnowledgeError } from '../core/errors.js';
import type { Job, SemanticFragment } from './types.js';

// 派生库可以重建；正式标签定义/删除抑制保存在核心组织数据中。
const SCHEMA = 3;
export class SemanticStore {
  constructor(readonly db: DatabaseSync) {}
  static async open(dataDir: string, readOnly = false) {
    const file = await safeDirectory(dataDir, 'cache/semantic/index.sqlite');
    for (const suffix of ['-wal', '-shm', '-journal']) await safeDirectory(dataDir, 'cache/semantic/index.sqlite' + suffix);
    let exists=true;try{await access(file);}catch(error){if((error as any).code==='ENOENT')exists=false;else throw error;}
    if(!readOnly)await mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(readOnly&&!exists?':memory:':file, {readOnly:readOnly&&exists});
    db.exec('PRAGMA busy_timeout=5000;');
    if(!readOnly)db.exec('PRAGMA journal_mode=WAL;');
    const version = Number((db.prepare('PRAGMA user_version').get() as any).user_version);
    if (![0,1,2,SCHEMA].includes(version)) { db.close(); throw new KnowledgeError('SEMANTIC_SCHEMA', '语义缓存版本不支持'); }
    if(readOnly&&exists)return new SemanticStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS jobs(kind TEXT,id TEXT,wanted TEXT,published TEXT DEFAULT '',state TEXT DEFAULT 'queued',cursor TEXT DEFAULT '',error TEXT DEFAULT '',retryAt INTEGER DEFAULT 0,done INTEGER DEFAULT 0,total INTEGER DEFAULT 0,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS fragments(id TEXT PRIMARY KEY,resource TEXT,signature TEXT,payload TEXT,vectorKey TEXT);
      CREATE INDEX IF NOT EXISTS fragments_resource ON fragments(resource);
      CREATE TABLE IF NOT EXISTS vectors(key TEXT PRIMARY KEY,identity TEXT,query INTEGER,vector TEXT,truncated INTEGER);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS derivations(key TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE IF NOT EXISTS labels(id TEXT PRIMARY KEY,signature TEXT,vectorKey TEXT);
      CREATE TABLE IF NOT EXISTS matches(tag TEXT,fragment TEXT,score REAL,PRIMARY KEY(tag,fragment));
      CREATE INDEX IF NOT EXISTS matches_fragment ON matches(fragment);
      `);
    // v1 仅增加派生结构，保留原片元、任务、向量及标签匹配；GET 不迁移磁盘。
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS keyword_terms(id TEXT PRIMARY KEY,normalized TEXT NOT NULL UNIQUE,name TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS keyword_terms_order ON keyword_terms(normalized,id);
      CREATE TABLE IF NOT EXISTS keyword_documents(resource TEXT PRIMARY KEY,signature TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,searchText TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keyword_links(keyword TEXT NOT NULL,resource TEXT NOT NULL,fragment TEXT NOT NULL,value TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,count INTEGER NOT NULL,score REAL NOT NULL,PRIMARY KEY(keyword,resource,fragment));
      CREATE INDEX IF NOT EXISTS keyword_links_resource ON keyword_links(resource,keyword,fragment);
      CREATE INDEX IF NOT EXISTS keyword_links_fragment ON keyword_links(fragment,keyword);
      CREATE TABLE IF NOT EXISTS match_evidence(tag TEXT NOT NULL,fragment TEXT NOT NULL,status TEXT NOT NULL,score REAL NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tag,fragment));
      CREATE INDEX IF NOT EXISTS match_evidence_fragment ON match_evidence(fragment);
      CREATE INDEX IF NOT EXISTS match_evidence_status ON match_evidence(tag,status);
      PRAGMA user_version=3;
      COMMIT;`);
    return new SemanticStore(db);
  }
  close() { this.db.close(); }
  all<T>(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args) as unknown as T[]; }
  get<T>(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as unknown as T | undefined; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  enqueue(kind: Job['kind'], id: string, wanted: string) {
    this.run(`INSERT INTO jobs(kind,id,wanted) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET wanted=excluded.wanted,state='queued',cursor='',error='',retryAt=0,done=0,total=0 WHERE jobs.wanted!=excluded.wanted`, kind,id,wanted);
  }
  jobs() { return this.all<Job>('SELECT * FROM jobs ORDER BY kind,id'); }
  fragments() { return this.all<{payload:string}>('SELECT payload FROM fragments ORDER BY id').map(row => JSON.parse(row.payload) as SemanticFragment); }
  removeResource(id: string) {
    this.removeKeywordResource(id);
    this.run('DELETE FROM match_evidence WHERE fragment IN (SELECT id FROM fragments WHERE resource=?)',id);
    this.run('DELETE FROM matches WHERE fragment IN (SELECT id FROM fragments WHERE resource=?)',id);
    this.run('DELETE FROM fragments WHERE resource=?',id);
    this.run("DELETE FROM jobs WHERE kind='resource' AND id=?",id);
  }
  /** 与片元发布共用事务；一个词的所有引用消失后才回收词条。 */
  removeKeywordResource(id: string) {
    this.run('DELETE FROM keyword_links WHERE resource=?',id);
    const removed=this.run('DELETE FROM keyword_documents WHERE resource=?',id);
    this.run('DELETE FROM keyword_terms WHERE NOT EXISTS (SELECT 1 FROM keyword_links WHERE keyword=keyword_terms.id)');
    if(Number(removed.changes))this.bumpKeywordRevision();
  }
  bumpKeywordRevision() { this.run("INSERT INTO settings VALUES('keyword-revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1"); }
  setting(key:string) { return this.get<{value:string}>('SELECT value FROM settings WHERE key=?',key)?.value; }
  setSetting(key:string,value:string) {this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value!=excluded.value',key,value);}
  removeTag(id: string) { this.run('DELETE FROM match_evidence WHERE tag=?',id); this.run('DELETE FROM matches WHERE tag=?',id); this.run('DELETE FROM labels WHERE id=?',id); this.run("DELETE FROM jobs WHERE kind='tag' AND id=?",id); }
}
