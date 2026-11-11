import type { Organization, PluginDefinition, ResourceMeta } from '../../contracts/index.js';
import { normalize } from '../keywords/extract.js';
import { json, manifest, required, strings, readPluginMeta, PLUGIN_META_SCHEMA_VERSION } from '../shared.js';

export interface TagDefinition { aliases: string[]; description: string }
export interface TagDecision {
  tagId: string; accepted: boolean; source: 'manual' | 'codex' | 'automatic'; reason: string;
  contentVersion: number; tagRevision: number; at: string;
}
export interface TagData { decisions: TagDecision[] }
export interface DecisionInput {
  resourceId: string; tagId: string; accepted: boolean; source: TagDecision['source']; reason: string;
  contentVersion: number; tagRevision: number;
}
export interface TagsApi {
  list(): Promise<Organization[]>; get(idOrName: string): Promise<Organization>;
  create(input: { name: string; aliases?: string[]; description?: string }): Promise<Organization>;
  update(id: string, patch: { name?: string; aliases?: string[]; description?: string }): Promise<Organization>;
  delete(id: string): Promise<void>; decisions(resource: ResourceMeta): TagDecision[];
  clear(resourceId: string, tagId: string): Promise<void>;
  decide(input: DecisionInput): Promise<{ applied: boolean; decision: TagDecision; review?: string }>;
}

function definition(tag: Organization): TagDefinition { return tag.data as unknown as TagDefinition; }

export const tagsPlugin: PluginDefinition = {
  manifest: { ...manifest('tags'), organizationTypes: [{ id: 'tag', name: '标签', config: {} }] },
  async load(context) {
    /** 标签名称和别名共享唯一命名空间，避免确定匹配歧义。 */
    async function validate(name: string, aliases: string[], exceptId?: string) {
      if (!normalize(name)) throw new Error('INVALID_INPUT: 标签名称不能为空');
      const values = [name, ...aliases].map(normalize);
      if (values.some(value => !value) || new Set(values).size !== values.length) throw new Error('TAG_ALIAS_CONFLICT: 名称或别名重复/为空');
      for (const tag of await api.list()) {
        if (tag.id === exceptId) continue;
        if ([tag.name, ...definition(tag).aliases].map(normalize).some(value => values.includes(value))) throw new Error(`TAG_ALIAS_CONFLICT: 与 ${tag.name} 冲突`);
      }
    }
    const api: TagsApi = {
      async list() { return context.core.listOrganizations('tag'); },
      async get(idOrName) {
        const value = normalize(idOrName);
        const tag = (await api.list()).find(tag => tag.id === idOrName || [tag.name, ...definition(tag).aliases].some(name => normalize(name) === value));
        if (!tag) throw new Error(`NOT_FOUND: 标签 ${idOrName}`);
        return tag;
      },
      async create(input) {
        await validate(input.name, input.aliases ?? []);
        return context.core.createOrganization({ type: 'tag', pluginId: 'tags', name: input.name, data: json({ aliases: input.aliases ?? [], description: input.description ?? '' }) });
      },
      async update(id, patch) {
        const tag = await api.get(id);
        const data = definition(tag);
        await validate(patch.name ?? tag.name, patch.aliases ?? data.aliases, tag.id);
        return context.core.updateOrganization(tag.id, { name: patch.name ?? tag.name, data: json({ aliases: patch.aliases ?? data.aliases, description: patch.description ?? data.description }) }, tag.revision);
      },
      async delete(id) {
        const tag = await api.get(id);
        for (const { resource } of await context.core.listResources({ includeDeleted: true })) {
          if (api.decisions(resource).some(decision => decision.tagId === tag.id)) throw new Error('REFERENCE_IN_USE: 标签存在接受或拒绝记录，需先显式清理关联');
        }
        await context.core.deleteOrganization(tag.id);
      },
      decisions(resource) { return readPluginMeta<TagData>(resource, 'tags')?.decisions ?? []; },
      async clear(resourceId, tagId) {
        const resource = await context.core.getResource(resourceId);
        const next = api.decisions(resource).filter(decision => decision.tagId !== tagId);
        await context.core.updatePluginMeta(resourceId, 'tags', json({ decisions: next }), { schemaVersion: PLUGIN_META_SCHEMA_VERSION, expectedRevision: resource.revision, expectedContentVersion: resource.contentVersion, references: next.map(value => ({ kind: 'organization', id: value.tagId })) });
      },
      async decide(input) {
        if (!['manual', 'codex', 'automatic'].includes(input.source) || typeof input.accepted !== 'boolean' || !input.reason?.trim()) throw new Error('INVALID_INPUT: 判断需要accepted/source/reason');
        const resource = await context.core.getResource(input.resourceId);
        const tag = await api.get(input.tagId);
        if (resource.contentVersion !== input.contentVersion || tag.revision !== input.tagRevision) throw new Error('STALE_INPUT: 资源内容或标签定义已变化');
        const decisions = api.decisions(resource);
        const previous = decisions.find(decision => decision.tagId === tag.id);
        if (previous?.source === 'manual' && input.source !== 'manual') return { applied: false, decision: previous, review: '人工决定持续有效；自动结果只构成复核建议' };
        const decision: TagDecision = { ...input, tagId: tag.id, at: new Date().toISOString() };
        // 关联只存在资源 meta，组织引用仅供核心校验删除约束。
        const next = decisions.filter(value => value.tagId !== tag.id).concat(decision);
        const references = next.map(value => ({ kind: 'organization' as const, id: value.tagId }));
        await context.core.updatePluginMeta(resource.id, 'tags', json({ decisions: next }), { schemaVersion: PLUGIN_META_SCHEMA_VERSION, expectedRevision: resource.revision, expectedContentVersion: input.contentVersion, references });
        return { applied: true, decision };
      },
    };
    context.registerCommand('tag list', async () => api.list());
    context.registerCommand('tag get', async ({ input }) => api.get(required(input, 'id')));
    context.registerCommand('tag create', async ({ input }) => api.create({ name: required(input, 'name'), aliases: strings(input.aliases), description: typeof input.description === 'string' ? input.description : '' }));
    context.registerCommand('tag update', async ({ input }) => api.update(required(input, 'id'), { name: typeof input.name === 'string' ? input.name : undefined, aliases: input.aliases === undefined ? undefined : strings(input.aliases), description: typeof input.description === 'string' ? input.description : undefined }));
    context.registerCommand('tag delete', async ({ input }) => api.delete(required(input, 'id')));
    context.registerCommand('tag decide', async ({ input }) => api.decide(input as unknown as DecisionInput));
    context.registerCommand('tag clear', async ({ input }) => api.clear(required(input, 'resourceId'), required(input, 'tagId')));
    return { api };
  },
};
export default tagsPlugin;
