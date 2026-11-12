import path from 'node:path';
import { createHash } from 'node:crypto';
import { CoreManager } from '../core/manager.js';
import { KnowledgeError } from '../core/errors.js';
import type { RecallConfig, Mapping, RecordInfo, Request, Scope, SourceRecord } from './types.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export const emptyConfig = (): RecallConfig => ({ revision: 0, projects: [], resources: {}, organizations: {} });
export function fail(code: string, message: string, details?: unknown): never { throw new KnowledgeError(code, message, details, code === 'INVALID_ARGUMENT' ? 2 : 1); }
export function requireValue(value: unknown, message: string): asserts value { if (!value) fail('INVALID_ARGUMENT', message); }
export function strings(value: unknown, name: string): string[] { requireValue(value === undefined || Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()), `${name} 必须非空字符串数组`); return [...new Set(value as string[] ?? [])]; }
export function directory(value: string): string { const absolute = path.resolve(value); return process.platform === 'win32' ? absolute.toLowerCase() : absolute; }
export function within(root: string, child: string): boolean { const relative = path.relative(directory(root), directory(child)); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }

export async function readConfig(manager: CoreManager): Promise<RecallConfig> { return manager.pluginStore('recall').read('config', emptyConfig()); }
/** 范围修订经正式事务保存；未知字段拒绝，防止误以为过滤生效。 */
export async function configure(dataDir: string, input: Record<string, unknown>) {
  requireValue(Object.keys(input).every(k => ['expectedRevision', 'revision', 'projects', 'resources', 'organizations', 'chunking', 'ranking', 'input', 'json', 'cwd'].includes(k)), '未知召回配置字段');
  const manager = await CoreManager.open(dataDir);
  try {
    const prior = await readConfig(manager);
    requireValue(input.expectedRevision === prior.revision, 'expectedRevision 与当前范围配置不一致');
    requireValue(Array.isArray(input.projects), 'projects 必须为数组');
    const projects = input.projects.map((p: any) => {
      requireValue(p && typeof p === 'object' && /^[a-z][a-z0-9-]{0,63}$/.test(p.id), '项目 ID 无效');
      requireValue(Object.keys(p).every(k => ['id', 'aliases', 'directories', 'modules', 'entries'].includes(k)), '未知项目配置字段');
      return { id: p.id as string, aliases: strings(p.aliases, 'aliases').map(normalize), directories: strings(p.directories, 'directories').map(directory), modules: strings(p.modules, 'modules'), entries: strings(p.entries, 'entries') };
    });
    requireValue(new Set(projects.map(p => p.id)).size === projects.length, '项目 ID 重复');
    const mappings = (value: unknown): Record<string, Mapping> => {
      requireValue(value === undefined || value && typeof value === 'object' && !Array.isArray(value), '范围映射必须为对象');
      return Object.fromEntries(Object.entries(value ?? {}).map(([id, m]: [string, any]) => {
        requireValue(m && Object.keys(m).every(k => ['projectId', 'modules', 'sourcePaths'].includes(k)), '未知范围映射字段');
        const project = projects.find(p => p.id === m.projectId); requireValue(project, '映射项目未登记');
        const modules = strings(m.modules, 'modules'); requireValue(modules.every(x => project.modules.includes(x)), '映射模块未登记');
        return [id, { projectId: project.id, modules, sourcePaths: strings(m.sourcePaths, 'sourcePaths').map(directory) }];
      }));
    };
    const config: RecallConfig = { revision: prior.revision + 1, projects, resources: mappings(input.resources), organizations: mappings(input.organizations) };
    if (input.chunking !== undefined) {
      const c = input.chunking as any;
      requireValue(c && Object.keys(c).every(k => ['targetChars', 'maxBlockChars'].includes(k)) && Number.isInteger(c.targetChars) && c.targetChars >= 128 && c.targetChars <= 4000 && Number.isInteger(c.maxBlockChars) && c.maxBlockChars >= c.targetChars && c.maxBlockChars <= 8000, 'chunking 参数无效');
      config.chunking = { targetChars: c.targetChars, maxBlockChars: c.maxBlockChars };
    }
    if (input.ranking !== undefined) {
      const r = input.ranking as any;
      requireValue(r && Object.keys(r).every(k => ['semanticMinScore', 'rrfK', 'bm25TitleWeight'].includes(k)) && typeof r.semanticMinScore === 'number' && r.semanticMinScore >= 0 && r.semanticMinScore <= 1 && Number.isInteger(r.rrfK) && r.rrfK >= 1 && r.rrfK <= 1000 && typeof r.bm25TitleWeight === 'number' && r.bm25TitleWeight >= 0 && r.bm25TitleWeight <= 10, 'ranking 参数无效');
      config.ranking = { semanticMinScore: r.semanticMinScore, rrfK: r.rrfK, bm25TitleWeight: r.bm25TitleWeight };
    }
    for (const id of Object.keys(config.resources)) await manager.getResource(id);
    for (const id of Object.keys(config.organizations)) await manager.getOrganization(id);
    for (const p of projects) for (const id of p.entries) await manager.getResource(id);
    await manager.pluginStore('recall').write('config', config); return config;
  } finally { await manager.close(); }
}

export function resolveScope(config: RecallConfig, request: Request): Scope {
  const scope = request.scope ?? {};
  requireValue(scope && typeof scope === 'object' && !Array.isArray(scope), 'scope 必须为对象');
  requireValue(Object.keys(scope).every(k => ['projectId', 'projectIds', 'crossProject', 'modules', 'organizationIds', 'sourcePaths', 'recordType', 'sessionId', 'time'].includes(k)), '未知范围字段');
  const identify = (name: string): string => {
    requireValue(typeof name === 'string' && !!name.trim(), '项目名称无效');
    const found = config.projects.filter(p => p.id === name || p.aliases.includes(normalize(name)));
    if (found.length !== 1) fail('SCOPE_AMBIGUOUS', '项目不存在或有多个候选', { candidates: found.map(p => p.id) });
    return found[0].id;
  };
  let ids = scope.projectId ? [identify(scope.projectId)] : [];
  if (scope.projectIds !== undefined) {
    const selected = strings(scope.projectIds, 'projectIds').map(identify);
    requireValue(selected.length > 0, 'projectIds 不能为空');
    ids = ids.length ? ids.filter(id => selected.includes(id)) : selected;
    if (!ids.length) fail('SCOPE_CONFLICT', '项目条件交集为空');
  }
  requireValue(scope.crossProject === undefined || typeof scope.crossProject === 'boolean', 'crossProject 必须为 boolean');
  if (ids.length > 1 && !scope.crossProject) fail('SCOPE_AMBIGUOUS', '跨项目查询必须显式 crossProject');
  if (request.contextProjectId) {
    const context = identify(request.contextProjectId);
    if (ids.length && !ids.includes(context)) fail('SCOPE_CONFLICT', '显式项目与任务项目冲突');
    ids = ids.length ? ids.filter(id => id === context) : [context];
  }
  if (!ids.length && scope.crossProject) ids = config.projects.map(p => p.id);
  if (!ids.length && request.cwd) ids = config.projects.filter(p => p.directories.some(d => within(d, request.cwd!))).map(p => p.id);
  if (!ids.length || ids.length > 1 && !scope.crossProject) fail('SCOPE_AMBIGUOUS', '请显式指定项目或登记目录映射', { candidates: ids });
  const modules = strings(scope.modules, 'modules');
  requireValue(modules.every(m => config.projects.some(p => ids.includes(p.id) && p.modules.includes(m))), '模块未显式登记');
  const time = scope.time;
  if (time) {
    requireValue(['sourceTime', 'recordedAt'].includes(time.field) && Object.keys(time).every(k => ['field', 'from', 'to'].includes(k)), '时间字段无效');
    for (const v of [time.from, time.to]) requireValue(v === undefined || typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)), '时间须带时区');
    requireValue(!time.from || !time.to || Date.parse(time.from) < Date.parse(time.to), '时间范围必须非空');
  }
  requireValue(scope.recordType === undefined || ['resource', 'note', 'transcript'].includes(scope.recordType), 'recordType 无效');
  requireValue(scope.sessionId === undefined || typeof scope.sessionId === 'string' && !!scope.sessionId, 'sessionId 无效');
  return { projectIds: [...new Set(ids)].sort(), ...(scope.crossProject ? { crossProject: true } : {}), modules, organizationIds: strings(scope.organizationIds, 'organizationIds'), sourcePaths: strings(scope.sourcePaths, 'sourcePaths').map(directory), ...(scope.recordType ? { recordType: scope.recordType } : {}), ...(scope.sessionId ? { sessionId: scope.sessionId } : {}), ...(time ? { time } : {}) };
}
export function allowed(record: RecordInfo, scope: Scope): boolean {
  if (!record.projectId || !scope.projectIds.includes(record.projectId)) return false;
  if (scope.modules?.length && !scope.modules.some(m => record.modules.includes(m))) return false;
  if (scope.organizationIds?.length && !scope.organizationIds.some(id => record.organizationIds.includes(id) || record.tagIds.includes(id))) return false;
  if (scope.sourcePaths?.length && !scope.sourcePaths.some(p => record.sourcePaths.some(s => within(p, s)))) return false;
  if (scope.recordType && scope.recordType !== record.recordType || scope.sessionId && scope.sessionId !== record.sessionId) return false;
  if (scope.time) {
    const from = scope.time.field === 'sourceTime' ? record.sourceFrom : record.recordedAt;
    const to = scope.time.field === 'sourceTime' ? record.sourceTo ?? from : from;
    if (!from || !to) return false;
    if (scope.time.from && Date.parse(to) < Date.parse(scope.time.from) || scope.time.to && Date.parse(from) >= Date.parse(scope.time.to)) return false;
  }
  return true;
}

/** 正式元数据快照；读取列表不加载正文，索引与证据路径才读取固定原件。 */
export async function snapshot(dataDir: string, bodies = false, versions: Record<string, number> = {}) {
  const manager = await CoreManager.open(dataDir, { readOnly: true });
  try { return await manager.storage.snapshot(async () => {
    const config = await readConfig(manager); const organizations = await manager.listOrganizations();
    const resources = (await manager.listResources()).map(x => x.resource);
    const records: SourceRecord[] = []; const skipped: string[] = [];
    for (const resource of resources) {
      const note = resource.plugins.notes?.data; const transcript = resource.plugins.transcripts?.data;
      const version = versions[resource.id] ?? (note || transcript ? 1 : resource.contentVersion);
      const original = version === resource.contentVersion ? resource : resource.history.find(h => h.contentVersion === version);
      if (!original) { skipped.push(resource.id + ':version-missing'); continue; }
      const orgs = organizations.filter(o => o.references.some(ref => ref.kind === 'resource' && ref.id === resource.id)).map(o => o.id);
      const tagIds = ((resource.plugins.tags?.data.decisions ?? []) as any[]).filter(d => d.accepted).map(d => String(d.tagId));
      const mappings = [config.resources[resource.id], ...orgs.map(id => config.organizations[id])].filter((m): m is Mapping => !!m);
      if (!mappings.length && typeof note?.projectDir === 'string') {
        for (const p of config.projects.filter(p => p.directories.some(d => within(d, note.projectDir as string)))) mappings.push({ projectId: p.id, modules: [] });
      }
      const ids = [...new Set(mappings.map(m => m.projectId))];
      if (ids.length > 1) skipped.push(resource.id + ':scope-conflict');
      const record: SourceRecord = { resourceId: resource.id, contentVersion: version, contentHash: original.hash, title: resource.originalName, ...(ids.length === 1 ? { projectId: ids[0] } : {}), modules: [...new Set(mappings.flatMap(m => m.modules))], organizationIds: orgs, tagIds, sourcePaths: [...new Set(mappings.flatMap(m => m.sourcePaths ?? []))], recordType: note ? 'note' : transcript ? 'transcript' : 'resource', ...(typeof transcript?.sessionId === 'string' ? { sessionId: transcript.sessionId } : {}), ...(typeof transcript?.sourceFrom === 'string' ? { sourceFrom: transcript.sourceFrom } : {}), ...(typeof transcript?.sourceTo === 'string' ? { sourceTo: transcript.sourceTo } : {}), recordedAt: typeof note?.recordedAt === 'string' ? note.recordedAt : typeof transcript?.at === 'string' ? transcript.at : resource.createdAt, text: '' };
      if (bodies) {
        if (!['md', 'markdown', 'txt', 'json'].includes(path.extname(original.file).slice(1).toLowerCase())) { skipped.push(resource.id + ':unsupported'); continue; }
        const bytes = await manager.storage.readBytes(original.file);
        if (hash(bytes) !== original.hash) fail('CONTENT_HASH_MISMATCH', '固定原文哈希不匹配', { id: resource.id, version });
        try { record.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { skipped.push(resource.id + ':invalid-utf8'); continue; }
      }
      records.push(record);
    }
    const fingerprint = hash(JSON.stringify({ config, resources: resources.map(r => [r.id, r.revision, r.contentVersion, r.hash]), organizations: organizations.map(o => [o.id, o.revision]) }));
    return { config, records, fingerprint, skipped };
  }); } finally { await manager.close(); }
}
