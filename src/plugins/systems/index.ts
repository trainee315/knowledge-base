import { randomUUID } from 'node:crypto';
import type { Organization, PluginDefinition } from '../../contracts/index.js';
import { json, manifest, required } from '../shared.js';

export interface SystemNode { id: string; title: string; parentId?: string; resourceId?: string; order: number }
export interface SystemData { description: string; nodes: SystemNode[] }
export interface SystemsApi {
  list(): Promise<Organization[]>; get(id: string): Promise<Organization>;
  create(name: string, description?: string): Promise<Organization>;
  update(id: string, input: { name?: string; description?: string; nodes?: SystemNode[] }): Promise<Organization>;
  delete(id: string): Promise<void>; addNode(id: string, node: Omit<SystemNode, 'id'> & { id?: string }): Promise<Organization>;
}

export const systemsPlugin: PluginDefinition = {
  manifest: { ...manifest('systems'), organizationTypes: [{ id: 'system', name: '体系', config: {} }] },
  async load(context) {
    async function validate(nodes: SystemNode[]) {
      const ids = new Set(nodes.map(node => node.id));
      if (ids.size !== nodes.length) throw new Error('SYSTEM_INVALID: 节点ID重复');
      for (const node of nodes) {
        if (!node.id || !node.title?.trim() || !Number.isFinite(node.order)) throw new Error('SYSTEM_INVALID: 节点需要id/title/有限order');
        if (node.parentId && !ids.has(node.parentId)) throw new Error('SYSTEM_INVALID: 父节点不存在');
        if (node.resourceId) await context.core.getResource(node.resourceId);
        const visited = new Set([node.id]);
        let parent = node.parentId;
        while (parent) {
          if (visited.has(parent)) throw new Error('SYSTEM_CYCLE: 节点不能循环引用');
          visited.add(parent); parent = nodes.find(value => value.id === parent)?.parentId;
        }
      }
    }
    const api: SystemsApi = {
      async list() { return context.core.listOrganizations('system'); },
      async get(id) {
        const value = await context.core.getOrganization(id);
        if (value.type !== 'system') throw new Error('SYSTEM_INVALID: 组织不是体系');
        return value;
      },
      async create(name, description = '') {
        return context.core.createOrganization({ type: 'system', pluginId: 'systems', name, data: json({ description, nodes: [] }) });
      },
      /** 节点顺序显式保存；资源引用由核心统一校验，名称变化不影响UUID。 */
      async update(id, input) {
        const system = await api.get(id);
        const data = system.data as unknown as SystemData;
        const nodes = (input.nodes ?? data.nodes).map(node => ({ ...node })).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        await validate(nodes);
        return context.core.updateOrganization(id, { name: input.name ?? system.name, data: json({ description: input.description ?? data.description, nodes }), references: [...new Set(nodes.map(node => node.resourceId).filter((id): id is string => Boolean(id)))].map(id => ({ kind: 'resource', id })) }, system.revision);
      },
      async addNode(id, node) {
        const system = await api.get(id);
        return api.update(id, { nodes: [...(system.data as unknown as SystemData).nodes, { ...node, id: node.id ?? randomUUID() }] });
      },
      async delete(id) { await api.get(id); await context.core.deleteOrganization(id); },
    };
    context.registerCommand('system list', async () => api.list());
    context.registerCommand('system get', async ({ input }) => api.get(required(input, 'id')));
    context.registerCommand('system create', async ({ input }) => api.create(required(input, 'name'), typeof input.description === 'string' ? input.description : ''));
    context.registerCommand('system update', async ({ input }) => api.update(required(input, 'id'), input as unknown as Parameters<SystemsApi['update']>[1]));
    context.registerCommand('system add-node', async ({ input }) => api.addNode(required(input, 'id'), (input.node ?? input) as Parameters<SystemsApi['addNode']>[1]));
    context.registerCommand('system delete', async ({ input }) => api.delete(required(input, 'id')));
    return { api };
  },
};
export default systemsPlugin;
