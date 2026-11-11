import type { CommandHandler, CoreApi, CoreEvent, PluginDefinition, PluginRuntime, PluginManifest } from '../contracts/index.js';
import { CoreManager } from './manager.js';
import { assert, KnowledgeError } from './errors.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// 插件 API 与数据版本独立；此宿主仅实现第一版 API。
const API_VERSION = 1;
interface PluginState { disabled: string[]; dataVersions: Record<string, number>; refreshSequence: number; organizationTypeDefaults?: string[]; commandOwners?: Record<string, string>; blockedPlugins?: string[]; failure?: { pluginId: string; phase: string; message: string; at: string } }
const initialState = (): PluginState => ({ disabled: [], dataVersions: {}, refreshSequence: 0 });
function parseVersion(version: string): number[] { assert(/^\d+\.\d+\.\d+$/.test(version), 'INVALID_VERSION', '插件版本必须为三段语义版本', { version }); return version.split('.').map(Number); }
export function satisfies(version: string, range: string): boolean {
  const actual = parseVersion(version); if (range === '*') return true;
  const operator = /^[~^]/.test(range) ? range[0] : ''; const wanted = parseVersion(operator ? range.slice(1) : range);
  const compare = actual[0] - wanted[0] || actual[1] - wanted[1] || actual[2] - wanted[2];
  if (!operator) return compare === 0;
  if (compare < 0) return false;
  if (operator === '~') return actual[0] === wanted[0] && actual[1] === wanted[1];
  if (wanted[0] > 0) return actual[0] === wanted[0];
  if (wanted[1] > 0) return actual[0] === 0 && actual[1] === wanted[1];
  return compare === 0;
}
/** 在执行任何插件代码前完成全部依赖检查和稳定拓扑排序。 */
export function pluginOrder(definitions: PluginDefinition[], disabled: string[] = []): PluginDefinition[] {
  const manifests = new Map<string, PluginDefinition>();
  const typeOwners = new Map<string, string>();
  for (const { manifest } of definitions) for (const type of manifest.organizationTypes ?? []) { assert(/^[a-z][a-z0-9-]{0,63}$/.test(type.id) && typeof type.name === 'string' && type.name.trim(), 'INVALID_ORGANIZATION_TYPE', '插件组织方式静态声明非法', { pluginId: manifest.id, typeId: type.id }); assert(!typeOwners.has(type.id), 'DUPLICATE_ORGANIZATION_TYPE', '插件组织方式声明重复', { typeId: type.id, owners: [typeOwners.get(type.id), manifest.id] }); typeOwners.set(type.id, manifest.id); }
  for (const definition of definitions) { const m = definition.manifest; assert(/^[a-z][a-z0-9-]*$/.test(m.id), 'INVALID_PLUGIN_ID', '插件标识非法'); assert(!manifests.has(m.id), 'DUPLICATE_PLUGIN', '插件标识重复', { id: m.id }); assert(m.apiVersion === API_VERSION, 'PLUGIN_API_VERSION', '插件 API 不兼容', { id: m.id }); parseVersion(m.version); assert(Number.isInteger(m.dataVersion) && m.dataVersion >= 1, 'INVALID_DATA_VERSION', '插件数据版本必须为正整数'); manifests.set(m.id, definition); }
  const enabled = [...manifests.keys()].filter(id => !disabled.includes(id)).sort();
  for (const id of enabled) for (const [dependency, range] of Object.entries(manifests.get(id)!.manifest.dependencies)) { const found = manifests.get(dependency); assert(found, 'MISSING_DEPENDENCY', '缺少依赖插件', { pluginId: id, dependency }); assert(!disabled.includes(dependency), 'DISABLED_DEPENDENCY', '依赖插件已停用', { pluginId: id, dependency }); assert(satisfies(found.manifest.version, range), 'DEPENDENCY_VERSION', '依赖版本不兼容', { pluginId: id, dependency, range, actual: found.manifest.version }); }
  const complete = new Set<string>(); const visiting: string[] = []; const order: PluginDefinition[] = [];
  const visit = (id: string) => { if (complete.has(id)) return; const cycle = visiting.indexOf(id); assert(cycle === -1, 'PLUGIN_CYCLE', '插件依赖存在循环', { path: [...visiting.slice(cycle), id] }); visiting.push(id); for (const dependency of Object.keys(manifests.get(id)!.manifest.dependencies).sort()) visit(dependency); visiting.pop(); complete.add(id); order.push(manifests.get(id)!); };
  for (const id of enabled) visit(id); return order;
}

/** 宿主统一协调加载/迁移/刷新；依赖失败立即停止本轮。 */
export class PluginHost {
  private state: PluginState = initialState();
  private order: PluginDefinition[] = [];
  private runtimes = new Map<string, PluginRuntime>();
  private commands = new Map<string, { pluginId: string; handler: CommandHandler }>();
  private active = false;
  private refreshing = false;
  private blocked = new Set<string>();
  private recovered = new Set<string>();
  private lifecycle = new AsyncLocalStorage<{ active: boolean }>();
  constructor(public readonly manager: CoreManager, public readonly definitions: PluginDefinition[]) { manager.setOrganizationHandlers(definitions.map(definition => definition.manifest.id)); }
  private async save(): Promise<void> { if (!this.manager.storage.readOnly) await this.manager.pluginStore('core-host').write('state', this.state); }
  private async withLifecycle<T>(action: () => Promise<T>): Promise<T> { const lease = { active: true }; try { return await this.lifecycle.run(lease, action); } finally { lease.active = false; } }
  private blockFailure(): void {
    this.blocked = new Set(this.state.blockedPlugins ?? []);
    if (!this.state.failure) return;
    this.blocked.add(this.state.failure.pluginId);
    let changed = true;
    while (changed) { changed = false; for (const definition of this.definitions) if (!this.blocked.has(definition.manifest.id) && Object.keys(definition.manifest.dependencies).some(id => this.blocked.has(id))) { this.blocked.add(definition.manifest.id); changed = true; } }
  }
  private assertReady(pluginId: string): void { assert(!this.blocked.has(pluginId), 'PLUGIN_BLOCKED', '插件或其依赖上次更新失败，请成功执行plugin refresh后再使用', { pluginId, failure: this.state.failure }); }
  private dependencyApi<T>(owner: string, id: string, api: T): T {
    const guard = () => { if (this.lifecycle.getStore()?.active) { assert(!this.blocked.has(id) || this.recovered.has(id), 'DEPENDENCY_NOT_READY', '依赖尚未完成本轮恢复', { owner, dependency: id }); } else { assert(this.active && !this.refreshing, 'PLUGINS_NOT_READY', '插件正在刷新或已停止'); this.assertReady(owner); this.assertReady(id); } };
    if ((typeof api !== 'object' || api === null) && typeof api !== 'function') { guard(); return api; }
    return new Proxy(api as object, { get: (target, key, receiver) => { guard(); const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? (...args: unknown[]) => { guard(); return value.apply(target, args); } : value; } }) as T;
  }
  private async loadDefinition(definition: PluginDefinition): Promise<void> {
    const pluginId = definition.manifest.id;
    const version = this.state.dataVersions[pluginId] ?? 0;
    assert(version <= definition.manifest.dataVersion, 'PLUGIN_DOWNGRADE', '插件数据版本高于代码，不支持降级', { pluginId, version });
    if (!this.manager.storage.readOnly) for (const description of definition.manifest.organizationTypes ?? []) {
      const marker = `${pluginId}:${description.id}`;
      if ((this.state.organizationTypeDefaults ?? []).includes(marker)) continue;
      await this.manager.registerOrganizationType({ ...description, handlerPluginId: pluginId });
      (this.state.organizationTypeDefaults ??= []).push(marker); await this.save();
    }
    const core = new Proxy(this.manager, { get: (target, key) => {
      if (key === 'updatePluginMeta') return async (id: string, owner: string, ...args: unknown[]) => { assert(owner === pluginId, 'PLUGIN_PERMISSION', '插件只能更新自己的meta分区', { pluginId, owner }); return (target.updatePluginMeta as (...values: unknown[]) => Promise<unknown>)(id, owner, ...args); };
      if (key === 'createOrganization') return async (input: Parameters<CoreManager['createOrganization']>[0]) => { assert(!input.pluginId || input.pluginId === pluginId, 'PLUGIN_PERMISSION', '插件不能伪造组织归属'); return target.createOrganization({ ...input, pluginId }); };
      if (key === 'updateOrganization') return async (...args: Parameters<CoreManager['updateOrganization']>) => { assert((await target.getOrganization(args[0])).pluginId === pluginId, 'PLUGIN_PERMISSION', '插件只能更新自己的组织'); return target.updateOrganization(...args); };
      if (key === 'deleteOrganization') return async (id: string) => { assert((await target.getOrganization(id)).pluginId === pluginId, 'PLUGIN_PERMISSION', '插件只能删除自己的组织'); return target.deleteOrganization(id); };
      if (key === 'registerOrganizationType') return async (input: Parameters<CoreManager['registerOrganizationType']>[0]) => { assert(!input.handlerPluginId || input.handlerPluginId === pluginId, 'PLUGIN_PERMISSION', '插件不能伪造组织方式处理器'); return target.registerOrganizationType({ ...input, handlerPluginId: pluginId }); };
      if (key === 'updateOrganizationType') return async (...args: Parameters<CoreManager['updateOrganizationType']>) => { assert((await target.getOrganizationType(args[0])).handlerPluginId === pluginId, 'PLUGIN_PERMISSION', '插件只能修改自己的组织方式'); return target.updateOrganizationType(...args); };
      if (key === 'deleteOrganizationType') return async (id: string) => { assert((await target.getOrganizationType(id)).handlerPluginId === pluginId, 'PLUGIN_PERMISSION', '插件只能删除自己的组织方式'); return target.deleteOrganizationType(id); };
      const allowed = new Set(['listResources', 'getResource', 'readContent', 'listOrganizations', 'getOrganization', 'createOrganization', 'updateOrganization', 'deleteOrganization', 'listOrganizationTypes', 'getOrganizationType', 'registerOrganizationType', 'updateOrganizationType', 'deleteOrganizationType', 'events']);
      assert(typeof key === 'string' && allowed.has(key), 'PLUGIN_PERMISSION', '插件无权访问核心内部能力', { pluginId, key: String(key) });
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) as CoreApi;
    const runtime = await this.withLifecycle(() => definition.load({ core, store: this.manager.pluginStore(pluginId), getDependency: <T>(id: string) => { assert(Object.hasOwn(definition.manifest.dependencies, id), 'UNDECLARED_DEPENDENCY', '只能访问显式声明的直接依赖', { pluginId, dependency: id }); const dependency = this.runtimes.get(id); assert(dependency, 'DEPENDENCY_NOT_READY', '依赖尚未就绪', { pluginId, dependency: id }); return this.dependencyApi(pluginId, id, dependency.api as T); }, registerCommand: (name, handler) => { assert(!this.commands.has(name), 'DUPLICATE_COMMAND', '插件命令重复', { name }); this.commands.set(name, { pluginId, handler }); (this.state.commandOwners ??= {})[name] = pluginId; }, log: message => process.stderr.write(`[${pluginId}] ${message}\n`) }));
    this.runtimes.set(pluginId, runtime);
    if (!this.manager.storage.readOnly && version !== definition.manifest.dataVersion) { if (runtime.migrate) await this.withLifecycle(() => runtime.migrate!(version, definition.manifest.dataVersion)); this.state.dataVersions[pluginId] = definition.manifest.dataVersion; await this.save(); }
  }
  async start(): Promise<void> {
    this.state = await this.manager.pluginStore('core-host').read('state', initialState());
    this.order = pluginOrder(this.definitions, this.state.disabled);
    this.blockFailure();
    let current = '';
    try {
      for (const definition of this.order) {
        current = definition.manifest.id;
        if (!this.blocked.has(current)) await this.loadDefinition(definition);
      }
      await this.save();
      this.active = true;
    } catch (error) { this.state.failure = { pluginId: current, phase: 'load', message: String(error), at: new Date().toISOString() }; this.blockFailure(); await this.save(); await this.stop(); throw error; }
  }
  list(): { manifest: PluginManifest; enabled: boolean; ready: boolean; dataVersion: number; failure?: PluginState['failure'] }[] { return this.definitions.map(definition => ({ manifest: definition.manifest, enabled: !this.state.disabled.includes(definition.manifest.id), ready: this.runtimes.has(definition.manifest.id) && !this.blocked.has(definition.manifest.id), dataVersion: this.state.dataVersions[definition.manifest.id] ?? 0, ...(this.blocked.has(definition.manifest.id) ? { failure: this.state.failure } : {}) })); }
  commandNames(): string[] { return [...new Set([...this.commands.keys(), ...Object.entries(this.state.commandOwners ?? {}).filter(([, id]) => this.blocked.has(id) && !this.state.disabled.includes(id)).map(([name]) => name)])].sort(); }
  async execute(name: string, input: Record<string, unknown>, args: string[] = []): Promise<unknown> { assert(this.active && !this.refreshing, 'PLUGINS_NOT_READY', '插件宿主未就绪或正在刷新'); const command = this.commands.get(name); const owner = command?.pluginId ?? this.state.commandOwners?.[name]; if (owner) this.assertReady(owner); assert(command, 'UNKNOWN_COMMAND', '未知命令或对应插件已停用', { name, available: this.commandNames() }); this.assertReady(command.pluginId); return command.handler({ input, args }); }
  async refresh(events?: CoreEvent[]): Promise<{ updated: string[]; sequence: number }> {
    assert(!this.manager.storage.readOnly, 'READ_ONLY', '只读会话不能刷新插件');
    assert(this.active && !this.refreshing, 'PLUGINS_NOT_READY', '插件宿主未就绪或正在刷新');
    this.recovered.clear();
    const changes = events ?? await this.manager.events(this.state.refreshSequence); const updated: string[] = []; let current = '';
    this.refreshing = true;
    try {
      for (const definition of this.order) { current = definition.manifest.id; if (!this.runtimes.has(current)) await this.loadDefinition(definition); const runtime = this.runtimes.get(current)!; if (runtime.refresh) { await this.withLifecycle(() => runtime.refresh!(changes)); updated.push(current); } this.recovered.add(current); }
      this.state.refreshSequence = Math.max(this.state.refreshSequence, ...changes.map(event => event.sequence)); delete this.state.failure; delete this.state.blockedPlugins; this.blockFailure(); await this.save(); return { updated, sequence: this.state.refreshSequence };
    } catch (error) { this.state.blockedPlugins = [...this.blocked].filter(id => !this.recovered.has(id)); this.state.failure = { pluginId: current, phase: 'refresh', message: String(error), at: new Date().toISOString() }; this.blockFailure(); this.state.blockedPlugins = [...this.blocked]; await this.save(); throw new KnowledgeError('PLUGIN_REFRESH_FAILED', '核心变更已提交，但插件刷新未完成', { committed: true, pluginId: current, updated, cause: String(error) }); }
    finally { this.refreshing = false; }
  }
  async setEnabled(id: string, enabled: boolean, cascade = false): Promise<{ disabled: string[] }> {
    assert(this.definitions.some(item => item.manifest.id === id), 'PLUGIN_NOT_FOUND', '插件不存在');
    const disabled = new Set(this.state.disabled);
    if (enabled) disabled.delete(id); else {
      const affected = new Set([id]); let changed = true;
      while (changed) { changed = false; for (const definition of this.definitions) if (!disabled.has(definition.manifest.id) && Object.keys(definition.manifest.dependencies).some(dep => affected.has(dep)) && !affected.has(definition.manifest.id)) { affected.add(definition.manifest.id); changed = true; } }
      assert(cascade || affected.size === 1, 'PLUGIN_IN_USE', '存在依赖方，需显式cascade停用', { dependents: [...affected].filter(value => value !== id) }); for (const item of affected) disabled.add(item);
    }
    pluginOrder(this.definitions, [...disabled]); await this.stop(); this.state.disabled = [...disabled].sort(); await this.save(); await this.start(); return { disabled: this.state.disabled };
  }
  async stop(): Promise<void> { let firstError: unknown; for (const definition of [...this.order].reverse()) { try { await this.runtimes.get(definition.manifest.id)?.stop?.(); } catch (error) { firstError ??= error; } } this.runtimes.clear(); this.commands.clear(); this.active = false; if (firstError) throw firstError; }
}
