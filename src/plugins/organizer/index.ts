import { createHash } from 'node:crypto';
import { KnowledgeError } from '../../core/errors.js';
import type { PluginDefinition, QueryItem } from '../../contracts/index.js';
import type { ContentApi } from '../content/index.js';
import type { KeywordsApi } from '../keywords/index.js';
import type { TagsApi, DecisionInput } from '../tags/index.js';
import type { RelationsApi } from '../relations/index.js';
import type { SystemsApi, SystemData } from '../systems/index.js';
import type { TasksApi, RunOptions, TaskRunResult } from '../tasks/index.js';
import { normalize } from '../keywords/extract.js';
import { boolean, manifest, number, required, strings } from '../shared.js';

// 离线评分只召回候选；最终归属必须经工作Codex或人工提交。
const CANDIDATE_THRESHOLD = 0.35;
const PROCESSOR_VERSION = '2';
const CANDIDATES_KEY = 'candidates';
export interface Candidate {
  id: string; resourceId: string; tagId: string; contentVersion: number; tagRevision: number;
  score: number; reasons: string[]; provider: { id: string; version: string; kind: string };
  status: 'pending' | 'decided' | 'protected'; review: boolean; createdAt: string;
  processorVersion: string;
}
export interface OrganizerQuery { tagMatch?: 'any' | 'all'; filename?: string[]; body?: string[]; keywords?: string[]; tags?: string[]; systems?: string[]; parseStatus?: string[]; offset?: number; limit?: number }
export interface OrganizerApi {
  reconcile(): Promise<{ enqueued: number; resources: number }>;
  run(options?: RunOptions): Promise<TaskRunResult>;
  candidates(input?: { includeResolved?: boolean; resourceId?: string }): Promise<Candidate[]>;
  material(id: string): Promise<unknown>;
  submit(input: { candidateId: string; accepted: boolean; reason: string; source?: DecisionInput['source']; contentVersion?: number; tagRevision?: number }): Promise<unknown>;
  query(input?: OrganizerQuery): Promise<{ items: (QueryItem & { matchReasons: string[] })[]; total: number; offset: number; limit: number }>;
}
function fingerprint(tags: { id: string; revision: number }[]): string {
  return createHash('sha256').update(JSON.stringify(tags.map(tag => [tag.id, tag.revision]).sort())).digest('hex').slice(0, 16);
}

export const organizerPlugin: PluginDefinition = {
  manifest: manifest('organizer', ['content', 'keywords', 'tags', 'relations', 'tasks', 'systems']),
  async load(context) {
    const content = context.getDependency<ContentApi>('content');
    const keywords = context.getDependency<KeywordsApi>('keywords');
    const tags = context.getDependency<TagsApi>('tags');
    const relations = context.getDependency<RelationsApi>('relations');
    const tasks = context.getDependency<TasksApi>('tasks');
    const systems = context.getDependency<SystemsApi>('systems');
    const candidates = await context.store.read<Candidate[]>(CANDIDATES_KEY, []);
    const processingVersion = () => [PROCESSOR_VERSION, content.processorVersion, keywords.processorVersion, relations.provider().cacheIdentity].join(':');
    const inputVersion = (contentVersion: number, allTags: { id: string; revision: number }[], values: string[]) => `${contentVersion}:${fingerprint(allTags)}:${createHash('sha256').update(JSON.stringify([...new Set(values)].sort())).digest('hex').slice(0, 16)}`;
    tasks.register('organizer.resource', async (task, execution) => {
      const resource = await context.core.getResource(task.entityId);
      const allTags = await tags.list();
      const words = await keywords.extract(resource.id);
      const version = inputVersion(resource.contentVersion, allTags, words.items.map(word => word.value));
      if (resource.deletedAt || version !== task.inputVersion || task.processorVersion !== processingVersion()) return { obsolete: true };
      execution.signal.throwIfAborted();
      const checkpoint = task.checkpoint as { completedTags?: string[] } | undefined;
      const completedTags = new Set(checkpoint?.completedTags ?? []);
      let remainingRequests = task.estimatedCalls ?? 0;
      for (const tag of allTags) {
        if (completedTags.has(tag.id)) continue;
        execution.signal.throwIfAborted();
        const latest = await context.core.getResource(resource.id);
        const previous = tags.decisions(latest).find(decision => decision.tagId === tag.id);
        const unchanged = previous?.contentVersion === resource.contentVersion && previous.tagRevision === tag.revision;
        // 评分覆盖与最终归属分开；版本升级仍补评分，已有人工/工作Agent决定不重复提交。
        const scored = await relations.score(tag.id, words.items.map(word => word.value), execution.signal, { maxRequests: remainingRequests });
        if (scored.provider.kind === 'model') remainingRequests -= scored.stats?.requests ?? 0;
        if (!unchanged) {
          execution.signal.throwIfAborted();
          const best = scored.scores.filter(score => score.score >= CANDIDATE_THRESHOLD).sort((a, b) => b.score - a.score);
          const currentResource = await context.core.getResource(resource.id);
          if (currentResource.contentVersion !== resource.contentVersion || (await tags.get(tag.id)).revision !== tag.revision) return { obsolete: true };
          const id = createHash('sha256').update(JSON.stringify([resource.id, resource.contentVersion, tag.id, tag.revision, task.processorVersion])).digest('hex');
          if (best.length && !candidates.some(candidate => candidate.id === id)) {
            candidates.push({ id, resourceId: resource.id, tagId: tag.id, contentVersion: resource.contentVersion, tagRevision: tag.revision, processorVersion: task.processorVersion, score: best[0].score, reasons: [...best.slice(0, 5).map(score => `${score.keyword}: ${score.reason} (${score.score.toFixed(3)})`), ...scored.warnings], provider: scored.provider, status: 'pending', review: previous?.source === 'manual', createdAt: new Date().toISOString() });
            await context.store.write(CANDIDATES_KEY, candidates);
          }
        }
        completedTags.add(tag.id);
        await execution.checkpoint({ completedTags: [...completedTags] });
      }
      return { resourceId: resource.id, parsed: (await content.get(resource.id))?.status, keywords: words.items.length, tagsChecked: allTags.length, assignmentPending: true };
    }, { async prepare(task) {
      let resource;
      try { resource = await context.core.getResource(task.entityId); }
      catch (error) { if ((error as { code?: string }).code === 'NOT_FOUND') return { obsolete: true }; throw error; }
      if (resource.deletedAt || task.processorVersion !== processingVersion()) return { obsolete: true };
      const allTags = await tags.list(); const words = await keywords.get(resource.id);
      if (!words || words.inputVersion !== resource.contentVersion || task.inputVersion !== inputVersion(resource.contentVersion, allTags, words.items.map(word => word.value))) return { obsolete: true };
      let estimatedCalls = 0;
      for (const tag of allTags) estimatedCalls += (await relations.plan(tag.id, words.items.map(word => word.value))).estimatedCalls;
      return { estimatedCalls };
    } });
    const api: OrganizerApi = {
      /** 全量版本核对补齐漏事件，稳定输入键避免重复任务。 */
      async reconcile() {
        const resources = await context.core.listResources();
        const allTags = await tags.list();
        const before = (await tasks.list()).length;
        for (const { resource } of resources) {
          const words = await keywords.extract(resource.id);
          let estimatedCalls = 0;
          for (const tag of allTags) estimatedCalls += (await relations.plan(tag.id, words.items.map(word => word.value))).estimatedCalls;
          await tasks.enqueue({ type: 'organizer.resource', entityId: resource.id, inputVersion: inputVersion(resource.contentVersion, allTags, words.items.map(word => word.value)), processorVersion: processingVersion(), estimatedCalls, payload: { contentVersion: resource.contentVersion, tags: allTags.map(tag => ({ id: tag.id, revision: tag.revision })) } });
        }
        return { enqueued: (await tasks.list()).length - before, resources: resources.length };
      },
      async run(options) { await api.reconcile(); return tasks.run(options); },
      async candidates(input = {}) {
        const result: Candidate[] = [];
        for (const candidate of candidates) {
          if (!input.includeResolved && candidate.status !== 'pending' || input.resourceId && candidate.resourceId !== input.resourceId) continue;
          if (candidate.processorVersion !== processingVersion()) continue;
          try {
            const resource = await context.core.getResource(candidate.resourceId);
            const tag = await tags.get(candidate.tagId);
            if (!resource.deletedAt && resource.contentVersion === candidate.contentVersion && tag.revision === candidate.tagRevision) result.push(structuredClone(candidate));
          } catch { /* 已清理的对象不再构成可提交候选。 */ }
        }
        return result.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      },
      async material(id) {
        const candidate = candidates.find(value => value.id === id);
        if (!candidate) throw new Error('NOT_FOUND: 候选不存在');
        if (candidate.processorVersion !== processingVersion()) throw new Error('STALE_INPUT: 候选处理器已升级');
        return { candidate, resource: await context.core.getResource(candidate.resourceId), content: await content.get(candidate.resourceId), keywords: await keywords.get(candidate.resourceId), tag: await tags.get(candidate.tagId), instructions: '评分仅用于候选召回。请阅读材料后提交accepted/reason；人工判断持续有效。' };
      },
      async submit(input) {
        const candidate = candidates.find(value => value.id === input.candidateId);
        if (!candidate) throw new Error('NOT_FOUND: 候选不存在');
        if (candidate.processorVersion !== processingVersion()) throw new Error('STALE_INPUT: 候选处理器已升级');
        if (input.contentVersion !== undefined && input.contentVersion !== candidate.contentVersion || input.tagRevision !== undefined && input.tagRevision !== candidate.tagRevision) throw new Error('STALE_INPUT: 提交版本与候选不符');
        const result = await tags.decide({ resourceId: candidate.resourceId, tagId: candidate.tagId, accepted: input.accepted, reason: input.reason, source: input.source ?? 'codex', contentVersion: candidate.contentVersion, tagRevision: candidate.tagRevision });
        candidate.status = result.applied ? 'decided' : 'protected';
        await context.store.write(CANDIDATES_KEY, candidates);
        return result;
      },
      /** 每类条件内OR，不同条件间AND；每个命中条件留下可读原因。 */
      async query(input = {}) {
        for (const key of ['filename', 'body', 'keywords', 'tags', 'systems', 'parseStatus'] as const) {
          const values = input[key];
          if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim()))) throw new Error(`INVALID_INPUT: ${key}必须为非空字符串数组`);
        }
        if (input.parseStatus?.some(status => !['parsed', 'unsupported', 'failed', 'pending'].includes(status))) throw new Error('INVALID_INPUT: 未知解析状态');
        if (![input.offset ?? 0, input.limit ?? 50].every(Number.isSafeInteger) || (input.offset ?? 0) < 0 || (input.limit ?? 50) < 0 || (input.limit ?? 50) > 1000) throw new Error('INVALID_INPUT: offset/limit必须为非负整数，limit最多1000');
        if (input.tagMatch !== undefined && !['any', 'all'].includes(input.tagMatch)) throw new KnowledgeError('INVALID_ARGUMENT', 'tagMatch必须为any或all', undefined, 2);
        const selectedTags = input.tags?.length ? await Promise.all(input.tags.map(value => tags.get(value).catch(() => undefined))) : [];
        const selectedSystems = input.systems?.length ? (await systems.list()).filter(system => input.systems!.some(value => system.id === value || normalize(system.name) === normalize(value))) : [];
        const items: (QueryItem & { matchReasons: string[] })[] = [];
        for (const { resource } of await context.core.listResources()) {
          const parsed = await content.get(resource.id);
          const words = await keywords.get(resource.id);
          const reasons: string[] = [];
          let matches = true;
          const includes = (values: string[] | undefined, actual: string[], label: string) => {
            if (!values?.length) return;
            const found = values.filter(value => actual.some(text => normalize(text).includes(normalize(value))));
            if (!found.length) matches = false; else reasons.push(`${label}: ${found.join(', ')}`);
          };
          includes(input.filename, [resource.originalName], '文件名');
          includes(input.body, parsed?.status === 'parsed' && parsed.inputVersion === resource.contentVersion ? [parsed.text] : [], '正文');
          includes(input.keywords, words?.inputVersion === resource.contentVersion ? words.items.map(word => word.value) : [], '关键词');
          if (input.tags?.length) {
            const found = selectedTags.filter(tag => tag && tags.decisions(resource).some(decision => decision.tagId === tag.id && decision.accepted));
            if (!found.length || input.tagMatch === 'all' && found.length !== selectedTags.length) matches = false; else reasons.push(`标签: ${found.map(tag => tag!.name).join(', ')}`);
          }
          if (input.systems?.length) {
            const found = selectedSystems.filter(system => (system.data as unknown as SystemData).nodes.some(node => node.resourceId === resource.id));
            if (!found.length) matches = false; else reasons.push(`体系: ${found.map(system => system.name).join(', ')}`);
          }
          const parseStatus = parsed?.inputVersion === resource.contentVersion ? parsed.status : 'pending';
          if (input.parseStatus?.length) {
            if (!input.parseStatus.includes(parseStatus)) matches = false; else reasons.push(`解析状态: ${parseStatus}`);
          }
          if (matches) items.push({ resource, reasons, matchReasons: reasons, parseStatus });
        }
        const offset = Math.max(0, Math.floor(input.offset ?? 0));
        const limit = Math.max(0, Math.min(1000, Math.floor(input.limit ?? 50)));
        return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
      },
    };
    context.registerCommand('organize query', async ({ input }) => api.query({ tagMatch: input.tagMatch as 'any' | 'all' | undefined, filename: strings(input.filename), body: strings(input.body), keywords: strings(input.keywords), tags: strings(input.tags), systems: strings(input.systems), parseStatus: strings(input.parseStatus), offset: number(input.offset, 0), limit: number(input.limit, 50) }));
    context.registerCommand('organize candidates', async ({ input }) => api.candidates({ includeResolved: input.includeResolved === undefined ? false : boolean(input.includeResolved), resourceId: input.resourceId === undefined ? undefined : required(input, 'resourceId') }));
    context.registerCommand('organize material', async ({ input }) => api.material(required(input, 'id')));
    context.registerCommand('organize submit', async ({ input }) => api.submit(input as unknown as Parameters<OrganizerApi['submit']>[0]));
    context.registerCommand('organize run', async ({ input }) => api.run({ maxTasks: number(input.maxTasks, 20), maxDurationMs: number(input.maxDurationMs, 60_000), maxCalls: number(input.maxCalls, 0), maxCost: number(input.maxCost, 0) }));
    context.registerCommand('organize reconcile', async () => api.reconcile());
    return { api, async refresh() { if (!await context.store.read('semantic-mode', false)) await api.run(); } };
  },
};
export default organizerPlugin;
