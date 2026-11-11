export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ResourceReference { kind: 'resource' | 'organization'; id: string; owner?: string }
export interface PluginMeta { schemaVersion: number; data: JsonObject }
/** 资源身份保持稳定，内容版本及插件分区分别演进。 */
export interface ResourceMeta {
  schemaVersion: 1; id: string; originalName: string; extension: string; mediaType: string;
  hash: string; size: number; contentVersion: number; revision: number;
  createdAt: string; updatedAt: string; deletedAt?: string;
  source?: string; file: string; references: ResourceReference[];
  plugins: Record<string, PluginMeta>;
  history: { contentVersion: number; hash: string; file: string; size: number; createdAt: string }[];
}
export interface Organization {
  schemaVersion: 1; id: string; type: string; name: string; revision: number;
  createdAt: string; updatedAt: string; references: ResourceReference[];
  data: JsonObject; pluginId?: string;
}
/** 组织方式定义与组织实例分离；处理器来自现有静态插件或通用处理器。 */
export interface OrganizationType {
  schemaVersion: 1; id: string; name: string; description: string;
  handlerPluginId?: string; config: JsonObject; enabled: boolean; revision: number;
  createdAt: string; updatedAt: string;
}
export interface OrganizationTypeInput { id: string; name: string; description?: string; handlerPluginId?: string; config?: JsonObject; enabled?: boolean }
export interface OrganizationTypePatch { name?: string; description?: string; config?: JsonObject; enabled?: boolean }
export interface CoreEvent { sequence: number; type: string; entityId: string; revision: number; at: string }
export interface ResourceQuery { text?: string; ids?: string[]; includeDeleted?: boolean; offset?: number; limit?: number }
export interface QueryItem { resource: ResourceMeta; reasons: string[]; parseStatus: string }
export interface CoreApi {
  listResources(query?: ResourceQuery): Promise<QueryItem[]>;
  getResource(id: string): Promise<ResourceMeta>;
  readContent(id: string, version?: number): Promise<Buffer>;
  updatePluginMeta(id: string, pluginId: string, data: JsonObject, options?: { schemaVersion?: number; expectedRevision?: number; expectedContentVersion?: number; references?: ResourceReference[] }): Promise<ResourceMeta>;
  listOrganizations(type?: string): Promise<Organization[]>;
  getOrganization(id: string): Promise<Organization>;
  createOrganization(input: { type: string; name: string; data?: JsonObject; references?: ResourceReference[]; pluginId?: string; id?: string }): Promise<Organization>;
  updateOrganization(id: string, patch: { name?: string; data?: JsonObject; references?: ResourceReference[] }, expectedRevision?: number): Promise<Organization>;
  deleteOrganization(id: string): Promise<void>;
  listOrganizationTypes(): Promise<OrganizationType[]>;
  getOrganizationType(id: string): Promise<OrganizationType>;
  registerOrganizationType(input: OrganizationTypeInput): Promise<OrganizationType>;
  updateOrganizationType(id: string, patch: OrganizationTypePatch, expectedRevision?: number): Promise<OrganizationType>;
  deleteOrganizationType(id: string): Promise<void>;
  events(after?: number): Promise<CoreEvent[]>;
}
/** 正式数据与缓存隔离；所有写入统一经过核心事务。 */
export interface PluginStore {
  read<T = Json>(key: string, fallback: T, category?: 'data' | 'cache'): Promise<T>;
  write(key: string, value: unknown, category?: 'data' | 'cache'): Promise<void>;
  remove(key: string, category?: 'data' | 'cache'): Promise<void>;
  list(category?: 'data' | 'cache'): Promise<string[]>;
}
export interface CommandContext { input: Record<string, unknown>; args: string[] }
export type CommandHandler = (context: CommandContext) => Promise<unknown>;
export interface PluginContext {
  core: CoreApi; store: PluginStore;
  getDependency<T = unknown>(id: string): T;
  registerCommand(name: string, handler: CommandHandler): void;
  log(message: string): void;
}
export interface PluginManifest {
  id: string; version: string; apiVersion: 1; dataVersion: number;
  dependencies: Record<string, string>; description?: string;
  organizationTypes?: { id: string; name: string; description?: string; config?: JsonObject }[];
}
export interface PluginRuntime {
  api?: unknown;
  migrate?(fromVersion: number, toVersion: number): Promise<void>;
  refresh?(events: CoreEvent[]): Promise<void>;
  stop?(): Promise<void>;
}
/** 先收集全部静态声明，依赖校验通过后才调用 load。 */
export interface PluginDefinition { manifest: PluginManifest; load(context: PluginContext): Promise<PluginRuntime> }
export interface CliResult { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } }
