import type { PreviewApplication } from './readonly.js';
import { KnowledgeError } from '../core/errors.js';
import { normalize } from '../plugins/keywords/extract.js';
import { readPluginMeta } from '../plugins/shared.js';
import type { KeywordData } from '../plugins/keywords/index.js';
import type { TagData } from '../plugins/tags/index.js';
import type { SystemData } from '../plugins/systems/index.js';

const PAGE_SIZE = 30; // 普通浏览批量上限与历史正文的20条上限分开。
const MAX_PAGE = 200;
function invalid(message: string): never { throw new KnowledgeError('INVALID_ARGUMENT', message); }
function page(url: URL, max = MAX_PAGE) {
  const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? Math.min(PAGE_SIZE, max));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > max) invalid('分页参数无效');
  return { offset, limit };
}
/** 只读组织浏览：聚合现有权威数据，不建立组织成员的第二份索引。 */
export async function browse(app: PreviewApplication, url: URL): Promise<unknown> {
  const exec = (name: string, input: Record<string, unknown> = {}) => app.plugins.execute(name, input, []) as Promise<any>;
  const historical = /^\/api\/project-tracking\/([^/]+)\/entries\/([^/]+)$/.exec(url.pathname);
  if (historical) return exec('project-track read', { projectId: historical[1], entryId: historical[2], ...(url.searchParams.has('asOfVersion') ? { asOfVersion: url.searchParams.get('asOfVersion') } : {}) });
  if (!['/api/browse/collections', '/api/browse/documents'].includes(url.pathname)) throw new KnowledgeError('NOT_FOUND', '组织浏览接口不存在');
  const type = url.searchParams.get('type') ?? 'tag';
  const kinds = await app.manager.listOrganizationTypes();
  const kind = kinds.find(item => item.id === type);
  if (!kind) throw new KnowledgeError('NOT_FOUND', '组织方式不存在');
  const plugins = await app.plugins.list() as any[];
  const ready = (id: string) => plugins.some(p => (p.manifest?.id ?? p.id) === id && p.enabled !== false && p.ready !== false && !p.failure);
  const required = ({ tag: 'tags', keyword: 'keywords', system: 'systems', 'project-development-tracking': 'project-tracking' } as Record<string,string>)[type];
  if (required && !ready(required)) throw new KnowledgeError('PLUGIN_UNAVAILABLE', '该组织方式的业务插件不可用');
  const { offset, limit } = page(url, type === 'project-development-tracking' && url.pathname.endsWith('/documents') ? 20 : MAX_PAGE);
  const query = normalize(url.searchParams.get('q') ?? '');
  const ids = [...new Set(url.searchParams.getAll('id'))];
  const resources = (await app.manager.listResources()).map(item => item.resource);
  const organizations = await app.manager.listOrganizations(type);
  const words = (r: typeof resources[number]) => { const data = readPluginMeta<KeywordData>(r, 'keywords'); return data?.inputVersion === r.contentVersion ? data.items.map(item => normalize(item.value)) : []; };
  const tagged = (r: typeof resources[number], id: string) => readPluginMeta<TagData>(r, 'tags')?.decisions.some(d => d.tagId === id && d.accepted) ?? false;
  const refs = (org: typeof organizations[number]) => new Set(org.references.filter(ref => ref.kind === 'resource').map(ref => ref.id));
  const systemNodes = (org: typeof organizations[number]) => {
    if (org.data.schemaVersion && org.data.schemaVersion !== 1) invalid('不支持的体系数据版本');
    return (org.data as unknown as SystemData).nodes ?? [];
  };
  if (url.pathname.endsWith('/collections')) {
    const entries = type === 'keyword'
      ? [...new Set(resources.flatMap(words))].sort().map(word => ({ id: word, name: word, description: '关键词', count: resources.filter(r => words(r).includes(word)).length }))
      : await Promise.all(organizations.map(async org => {
        const summary = {
          id: org.id, name: org.name, description: String(org.data.description ?? ''),
          count: type === 'tag' ? resources.filter(r => tagged(r, org.id)).length : type === 'project-development-tracking' ? (await exec('project-track documents', { projectId: org.id, limit: 1 })).total : resources.filter(r => refs(org).has(r.id)).length,
        };
        if (type !== 'session-transcript') return summary;
        const config = org.data.config as Record<string, any> | undefined;
        return { ...summary, projectDir: config?.projectDir ?? '', enabled: config?.enabled === true, intervalMinutes: config?.intervalMinutes ?? null };
      }));
    const filtered = entries.filter(item => !query || normalize(item.name).includes(query));
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
  }
  if (!ids.length) invalid('请选择组织条目');
  if (type !== 'keyword' && ids.some(id => !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id))) invalid('组织UUID无效');
  if (!['tag','keyword'].includes(type) && ids.length !== 1) invalid('该组织方式一次只能选择一个实例');
  if (type === 'project-development-tracking') {
    if (ids.length !== 1) invalid('项目一次只能选择一个');
    const input = { projectId: ids[0], offset, limit, ...(query ? { keywords: [query] } : {}), ...(url.searchParams.has('asOfVersion') ? { asOfVersion: url.searchParams.get('asOfVersion') } : {}) };
    const data = await exec('project-track documents', input);
    let baseline = null;
    for (let start = 0; ; start += 20) {
      const context = await exec('project-track documents', { ...input, keywords: undefined, offset: start, limit: 20 });
      baseline = context.items.find((x: any) => x.entry.role === 'baseline') ?? null;
      if (baseline || !context.hasMore) break;
    }
    return { ...data, baselineEntryId: baseline?.entry.id ?? null, baseline: baseline && !data.items.some((x: any) => x.entry.id === baseline.entry.id) ? baseline : null };
  }
  const chosen = organizations.filter(org => ids.includes(org.id));
  if (type !== 'keyword' && chosen.length !== ids.length) throw new KnowledgeError('NOT_FOUND', '组织实例不存在');
  const tagMatch = url.searchParams.get('tagMatch') ?? 'any';
  if (!['any','all'].includes(tagMatch)) invalid('tagMatch必须为any或all');
  const unordered = type === 'system' ? chosen.flatMap(systemNodes).sort((a,b) => a.order - b.order || a.id.localeCompare(b.id)) : [];
  const nodes: typeof unordered = [];
  const visited = new Set<string>();
  function visit(parentId?: string) { for (const n of unordered.filter(n=>n.parentId===parentId)) { if(visited.has(n.id)) invalid('体系节点循环或重复'); visited.add(n.id);nodes.push(n);visit(n.id); } }
  visit();
  if (nodes.length !== unordered.length) invalid('体系层级无效');
  const root = url.searchParams.get('nodeId');
  if (root && !nodes.some(n => n.id === root)) throw new KnowledgeError('NOT_FOUND', '体系节点不存在');
  const descendants = new Set<string>(root ? [root] : nodes.map(n => n.id));
  if (root) for (let changed = true; changed;) { changed = false; for (const n of nodes) if (n.parentId && descendants.has(n.parentId) && !descendants.has(n.id)) { descendants.add(n.id); changed = true; } }
  const resourceIds = new Set(type === 'system' ? nodes.filter(n => descendants.has(n.id)).map(n => n.resourceId) : chosen.flatMap(org => [...refs(org)]));
  const selected = resources.filter(r => type === 'tag' ? (tagMatch === 'all' ? ids.every(id => tagged(r,id)) : ids.some(id => tagged(r,id))) : type === 'keyword' ? ids.some(id => words(r).includes(normalize(id))) : resourceIds.has(r.id));
  const entries = await Promise.all(selected.map(async resource => {
    const content = ready('content') ? await exec('content get', { id: resource.id }) : undefined;
    const valid = content?.inputVersion === resource.contentVersion;
    const summaryResource = { id:resource.id, originalName:resource.originalName, extension:resource.extension, mediaType:resource.mediaType, size:resource.size, contentVersion:resource.contentVersion, updatedAt:resource.updatedAt };
    return { resource:summaryResource, title: resource.originalName.replace(/\.[^.]+$/, ''), summary: valid ? Array.from(content.text ?? '').slice(0,160).join('') : '', parseStatus: valid ? content.status : 'pending', tags: ready('tags') ? readPluginMeta<TagData>(resource,'tags')?.decisions.filter(d => d.accepted).map(d => d.tagId) ?? [] : [], matchReasons: [`${kind.name}：${type === 'keyword' ? ids.join('、') : chosen.map(o=>o.name).join('、')}`], paths: type === 'system' ? nodes.filter(n=>n.resourceId===resource.id).map(n=> { const names: string[]=[]; const seen=new Set<string>(); let item: typeof n | undefined=n; while(item && !seen.has(item.id)){seen.add(item.id);names.unshift(item.title);item=nodes.find(x=>x.id===item!.parentId);}return names.join(' / '); }) : [] };
  }));
  if (type === 'system') entries.sort((a,b)=>nodes.findIndex(n=>n.resourceId===a.resource.id)-nodes.findIndex(n=>n.resourceId===b.resource.id));
  const filtered = entries.filter(item => !query || normalize(item.title+' '+item.summary).includes(query));
  return { items: filtered.slice(offset,offset+limit), total: filtered.length, offset, limit, nodes, generic: !required, missingReferences: [...resourceIds].filter(id => id && !resources.some(r=>r.id===id)) };
}
