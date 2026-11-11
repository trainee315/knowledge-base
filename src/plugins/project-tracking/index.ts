import { createHash, randomUUID } from 'node:crypto';
import type { PluginDefinition, ResourceMeta } from '../../contracts/index.js';
import { KnowledgeError } from '../../core/errors.js';
import type { ContentApi } from '../content/index.js';
import type { KeywordsApi } from '../keywords/index.js';
import type { TagDefinition, TagsApi } from '../tags/index.js';
import { json, manifest } from '../shared.js';
import type { AddProjectEntryInput, ProjectDocument, ProjectEntry, ProjectEntryView, ProjectQueryInput, ProjectTrackingApi, TagSnapshot } from './types.js';
import { compareVersion, invalid, nonempty, orderEntries, PROJECT_PLUGIN_ID, PROJECT_SCHEMA_VERSION, PROJECT_TYPE, projectData, stringArray, timestamp, validateAdd, version } from './validation.js';
export type * from './types.js';

// 全文分页保持小批量；基线上下文独立返回，不挤占匹配条目页。
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 20;

function cliNumber(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value))) invalid('数值参数必须为整数');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid('数值参数必须为安全整数');
  return parsed;
}
function cliBoolean(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return invalid('includeBaseline必须为true或false');
}
function cliTerms(value: unknown, name: string): string[] { return stringArray(typeof value === 'string' ? [value] : value, name); }

export const projectTrackingPlugin: PluginDefinition = {
  manifest: { ...manifest(PROJECT_PLUGIN_ID, ['content', 'keywords', 'tags']), organizationTypes: [{ id: PROJECT_TYPE, name: '项目开发状态跟踪', description: '固定原文版本的基线和累加文档，显式记录阶段及替代声明', config: {} }] },
  async load(context) {
    const content = context.getDependency<ContentApi>('content');
    const keywords = context.getDependency<KeywordsApi>('keywords');
    const tags = context.getDependency<TagsApi>('tags');
    // 同一项目追加串行；expectedRevision同时拒绝外部写入造成的丢失更新。
    const tails = new Map<string, Promise<void>>();
    async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      tails.set(id, pending);
      await previous;
      try { return await action(); }
      finally { release(); if (tails.get(id) === pending) tails.delete(id); }
    }
    async function snapshotTags(resource: ResourceMeta, cv: number, explicit?: string[]): Promise<TagSnapshot> {
      if (explicit === undefined && resource.contentVersion !== cv) return { status: 'unknown', source: 'unavailable-history', items: [] };
      const decisions = explicit === undefined ? tags.decisions(resource).filter(item => item.accepted) : [];
      const ids = explicit ?? decisions.map(item => item.tagId);
      const items: TagSnapshot['items'] = [];
      for (const value of ids) {
        const tag = await tags.get(value);
        if (items.some(item => item.id === tag.id)) continue;
        const definition = tag.data as unknown as TagDefinition;
        items.push({ id: tag.id, name: tag.name, aliases: [...definition.aliases], definitionRevision: tag.revision, source: explicit ? 'explicit' : decisions.find(item => item.tagId === tag.id)!.source });
      }
      return { status: 'known', source: explicit === undefined ? 'resource-meta' : 'explicit', items };
    }
    function select(input: ProjectQueryInput, entries: ProjectEntry[]) {
      nonempty(input.projectId, 'projectId');
      if (input.includeBaseline !== undefined && typeof input.includeBaseline !== 'boolean') invalid('includeBaseline必须为布尔值');
      const offset = input.offset ?? 0; const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid('offset必须为非负整数，limit必须为1..20整数');
      const tagTerms = input.tags === undefined ? [] : stringArray(input.tags, 'tags').map(value => keywords.normalize(value));
      const keywordTerms = input.keywords === undefined ? [] : stringArray(input.keywords, 'keywords').map(value => keywords.normalize(value));
      const asOf = input.asOfVersion === undefined ? undefined : version(input.asOfVersion);
      const eligible = entries.filter(entry => !asOf || compareVersion(entry.projectVersion, asOf) <= 0).sort(orderEntries);
      const reasons = new Map<string, string[]>();
      const matched = eligible.filter(entry => {
        const matchedTags = tagTerms.filter(term => entry.snapshot.tags.items.some(item => [item.id, item.name, ...item.aliases].some(value => keywords.normalize(value) === term)));
        const matchedKeywords = keywordTerms.filter(term => entry.snapshot.keywords.some(value => keywords.normalize(value).includes(term)));
        if (tagTerms.length && !matchedTags.length || keywordTerms.length && !matchedKeywords.length) return false;
        reasons.set(entry.id, [...matchedTags.map(value => `tag:${value}`), ...matchedKeywords.map(value => `keyword:${value}`)]);
        return true;
      });
      function view(entry: ProjectEntry): ProjectEntryView {
        return { entry, matchReasons: reasons.get(entry.id) ?? [], replacement: { replacedBy: eligible.filter(candidate => candidate.replaces?.entryIds.includes(entry.id)).map(candidate => ({ entryId: candidate.id, stage: candidate.stage, scope: candidate.replaces!.scope, effect: candidate.replaces!.effect })) } };
      }
      return { offset, limit, eligible, matched, view, includeBaseline: input.includeBaseline ?? !(tagTerms.length || keywordTerms.length) };
    }
    async function document(view: ProjectEntryView): Promise<ProjectDocument> {
      // 已登记条目的读取只依赖固定原件与hash，不消费最新派生分区或算法。
      const bytes = await context.core.readContent(view.entry.resourceId, view.entry.contentVersion);
      if (createHash('sha256').update(bytes).digest('hex') !== view.entry.contentHash) throw new KnowledgeError('PROJECT_PIN_MISMATCH', '项目登记hash与固定原件不一致', { entryId: view.entry.id });
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new KnowledgeError('PROJECT_CONTENT_UNREADABLE', '固定原件不能作为UTF8全文读取'); }
      return { ...view, text };
    }
    const api: ProjectTrackingApi = {
      async create(input) {
        nonempty(input.name, 'name');
        if (input.description !== undefined && typeof input.description !== 'string') invalid('description必须为字符串');
        return context.core.createOrganization({ type: PROJECT_TYPE, pluginId: PROJECT_PLUGIN_ID, name: input.name, data: json({ schemaVersion: PROJECT_SCHEMA_VERSION, description: input.description ?? '', entries: [] }) });
      },
      async list() {
        const projects = await context.core.listOrganizations(PROJECT_TYPE);
        for (const project of projects) projectData(project);
        return projects;
      },
      async get(projectId) { nonempty(projectId, 'projectId'); const project = await context.core.getOrganization(projectId); projectData(project); return project; },
      /** 先处理幂等请求，再解析动态默认值；固定版本校验成功后单次原子追加。 */
      async add(supplied) {
        const { fingerprint, projectVersion } = validateAdd(supplied);
        const input = structuredClone(supplied);
        return serialized(input.projectId, async () => {
          const project = await api.get(input.projectId); const data = projectData(project);
          if (input.requestId) {
            const existing = data.entries.find(entry => entry.requestId === input.requestId);
            if (existing) {
              if (existing.requestFingerprint !== fingerprint) throw new KnowledgeError('PROJECT_REQUEST_CONFLICT', 'requestId已用于不同的显式输入');
              return { projectId: project.id, entry: existing, replayed: true };
            }
          }
          if (!data.entries.length && input.role !== 'baseline') throw new KnowledgeError('PROJECT_BASELINE_REQUIRED', '项目首条记录必须为baseline');
          if (input.replaces?.entryIds.some(id => !data.entries.some(entry => entry.id === id))) throw new KnowledgeError('PROJECT_REPLACEMENT_INVALID', '替代目标必须为同一项目已有条目');
          if (data.entries.length && input.role === 'baseline' && !input.replaces?.entryIds.some(id => data.entries.some(entry => entry.id === id && entry.role === 'baseline'))) throw new KnowledgeError('PROJECT_BASELINE_REPLACEMENT_REQUIRED', '后续baseline必须显式替代已有baseline');
          const resource = await context.core.getResource(input.resourceId);
          const cv = input.contentVersion ?? resource.contentVersion;
          const pinned = await content.readVersion(resource.id, cv);
          if (pinned.status !== 'parsed' || pinned.rawText === null || !['.md', '.markdown', '.txt', '.json'].includes(pinned.format)) throw new KnowledgeError('PROJECT_CONTENT_INVALID', '仅支持严格解析成功的MD/TXT/JSON原件', { status: pinned.status, format: pinned.format, error: pinned.error });
          const tagSnapshot = await snapshotTags(resource, cv, input.tags);
          const derived = keywords.fromText(pinned.rawText);
          const now = new Date().toISOString();
          const entry: ProjectEntry = {
            id: randomUUID(), resourceId: resource.id, contentVersion: cv, contentHash: pinned.contentHash,
            title: input.title, role: input.role, projectVersion, stage: input.stage, recordedAt: input.recordedAt === undefined ? now : timestamp(input.recordedAt),
            ...(input.replaces ? { replaces: input.replaces } : {}), ...(input.requestId ? { requestId: input.requestId, requestFingerprint: fingerprint } : {}),
            snapshot: { tags: tagSnapshot, keywords: derived.items.map(item => item.value), parseStatus: 'parsed', parserVersion: pinned.parserVersion, keywordProcessorVersion: derived.processorVersion, filename: pinned.filename, format: pinned.format, originalNameKnown: pinned.originalNameKnown, capturedAt: now, sourceMetaRevision: resource.revision },
          };
          // 登记前再次校验固定原件；当前meta变化不能把另一版本/标签混进本次快照。
          const verified = await content.readVersion(resource.id, cv);
          const latest = await context.core.getResource(resource.id);
          if (verified.contentHash !== entry.contentHash) throw new KnowledgeError('PROJECT_PIN_MISMATCH', '登记过程中原件hash变化');
          if (latest.revision !== resource.revision) throw new KnowledgeError('CONFLICT', '登记过程中资源meta变化，请重新登记');
          const entries = [...data.entries, entry];
          await context.core.updateOrganization(project.id, { data: json({ ...data, entries }), references: [...new Set(entries.map(item => item.resourceId))].map(id => ({ kind: 'resource', id })) }, project.revision);
          return { projectId: project.id, entry, replayed: false };
        });
      },
      async documents(input) {
        const selected = select(input, projectData(await api.get(input.projectId)).entries);
        return { projectId: input.projectId, items: selected.matched.slice(selected.offset, selected.offset + selected.limit).map(selected.view), total: selected.matched.length, offset: selected.offset, limit: selected.limit, hasMore: selected.offset + selected.limit < selected.matched.length };
      },
      async read(input) {
        nonempty(input.entryId, 'entryId');
        const selected = select({ projectId: input.projectId, asOfVersion: input.asOfVersion }, projectData(await api.get(input.projectId)).entries);
        const entry = selected.eligible.find(item => item.id === input.entryId);
        if (!entry) throw new KnowledgeError('NOT_FOUND', '项目范围内不存在此条目');
        return document(selected.view(entry));
      },
      async query(input) {
        const selected = select(input, projectData(await api.get(input.projectId)).entries);
        const items = await Promise.all(selected.matched.slice(selected.offset, selected.offset + selected.limit).map(entry => document(selected.view(entry))));
        const baseline = selected.includeBaseline ? selected.eligible.find(entry => entry.role === 'baseline') : undefined;
        return { projectId: input.projectId, items, total: selected.matched.length, offset: selected.offset, limit: selected.limit, hasMore: selected.offset + selected.limit < selected.matched.length, baselineEntryId: baseline?.id ?? null, baseline: baseline && !items.some(item => item.entry.id === baseline.id) ? await document(selected.view(baseline)) : null };
      },
    };
    function queryInput(input: Record<string, unknown>): ProjectQueryInput {
      return { projectId: nonempty(input.projectId, 'projectId'), ...(input.asOfVersion !== undefined ? { asOfVersion: nonempty(input.asOfVersion, 'asOfVersion') } : {}), ...(input.tags !== undefined ? { tags: cliTerms(input.tags, 'tags') } : {}), ...(input.keywords !== undefined ? { keywords: cliTerms(input.keywords, 'keywords') } : {}), ...(input.includeBaseline !== undefined ? { includeBaseline: cliBoolean(input.includeBaseline) } : {}), ...(input.offset !== undefined ? { offset: cliNumber(input.offset) } : {}), ...(input.limit !== undefined ? { limit: cliNumber(input.limit) } : {}) };
    }
    context.registerCommand('project-track create', async ({ input }) => api.create({ name: nonempty(input.name, 'name'), ...(input.description !== undefined ? { description: input.description as string } : {}) }));
    context.registerCommand('project-track list', async () => api.list());
    context.registerCommand('project-track get', async ({ input }) => api.get(nonempty(input.projectId, 'projectId')));
    context.registerCommand('project-track add', async ({ input }) => api.add({ ...input, ...(input.contentVersion !== undefined ? { contentVersion: cliNumber(input.contentVersion) } : {}) } as unknown as AddProjectEntryInput));
    context.registerCommand('project-track documents', async ({ input }) => api.documents(queryInput(input)));
    context.registerCommand('project-track read', async ({ input }) => api.read({ projectId: nonempty(input.projectId, 'projectId'), entryId: nonempty(input.entryId, 'entryId'), ...(input.asOfVersion !== undefined ? { asOfVersion: nonempty(input.asOfVersion, 'asOfVersion') } : {}) }));
    context.registerCommand('project-track query', async ({ input }) => api.query(queryInput(input)));
    return { api };
  },
};
export default projectTrackingPlugin;
