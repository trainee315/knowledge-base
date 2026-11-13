import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CoreApi, CoreEvent, JsonObject, Organization, OrganizationType, OrganizationTypeInput, OrganizationTypePatch, PluginStore, ResourceMeta, ResourceQuery, ResourceReference, QueryItem } from '../contracts/index.js';
import { FileStorage, type StorageMutation } from './storage.js';
import { assert, KnowledgeError } from './errors.js';
import { validateFormalPath, validateResource, validateOrganization, validateOrganizationType, validateReferenceShape } from './schema.js';
import { acquireQueuedWriter } from './writer-queue.js';

const SCHEMA_VERSION = 1; // 首期正式数据结构版本。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // 拒绝资源标识中夹带文件路径。
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const SERVICE_RESTORE_MARKER = 'plugins/service/data/restore-pending.json';

/** 核心正式数据入口，禁止插件绕过此处修改资源及组织。 */
export class CoreManager implements CoreApi {
  readonly storage: FileStorage;
  private poisoned = false;
  private serial = Promise.resolve();
  private metasCache?: Map<string, ResourceMeta>;
  private organizationsCache?: Map<string, Organization>;
  private organizationHandlers = new Set<string>();
  private releaseQueuedWriter?: () => void;
  constructor(public readonly dataDir: string, options: { readOnly?: boolean; failAfterWrites?: number } = {}) { this.storage = new FileStorage(path.resolve(dataDir), options.readOnly, options.failAfterWrites); }
  static async open(dataDir: string, options: { readOnly?: boolean; failAfterWrites?: number } = {}): Promise<CoreManager> {
    const manager = new CoreManager(path.resolve(dataDir), options);
    if (!options.readOnly) manager.releaseQueuedWriter = await acquireQueuedWriter();
    try { await manager.storage.init(); return manager; }
    catch (error) { manager.releaseQueuedWriter?.(); throw error; }
  }
  async close(): Promise<void> {
    try { await this.serial; await this.storage.close(); }
    finally { this.releaseQueuedWriter?.(); this.releaseQueuedWriter = undefined; }
  }
  setOrganizationHandlers(pluginIds: string[]): void { this.organizationHandlers = new Set(pluginIds); }
  private validateId(id: string): void { assert(UUID.test(id), 'INVALID_ID', '资源/组织标识必须为 UUID', { id }); }
  private async allMetas(): Promise<ResourceMeta[]> {
    if (!this.storage.readOnly && this.metasCache) return structuredClone([...this.metasCache.values()]);
    const values = await Promise.all((await this.storage.files('metadata')).filter(file => file.endsWith('.meta')).map(async file => { const value: unknown = await this.storage.readJson(file); validateResource(value, file); return value; }));
    if (!this.storage.readOnly) this.metasCache = new Map(values.map(value => [value.id, structuredClone(value)]));
    return values;
  }
  private metaPath(meta: ResourceMeta): string { return `metadata/${meta.id}.meta`; }
  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(async () => { assert(!this.poisoned, 'RECOVERY_REQUIRED', '上次写入未完成，请关闭后重新打开以恢复'); return action(); });
    this.serial = result.then(() => {}, () => {}); return result;
  }
  private async commit(writes: StorageMutation[], event?: { type: string; entityId: string; revision: number }): Promise<void> {
    for (const write of writes) await this.storage.assertSafePath(write.file);
    for (const write of writes) if (write.value !== null) {
      if (write.file.startsWith('metadata/')) validateResource(JSON.parse(write.value.toString()), write.file);
      if (write.file.startsWith('organizations/')) validateOrganization(JSON.parse(write.value.toString()), write.file);
      if (write.file.startsWith('organization-types/')) validateOrganizationType(JSON.parse(write.value.toString()), write.file);
    }
    if (event) {
      const events = await this.storage.readJson<CoreEvent[]>('state/events.json', []);
      events.push({ ...event, sequence: (events.at(-1)?.sequence ?? 0) + 1, at: now() });
      writes.push({ file: 'state/events.json', value: json(events) });
      // 关键词读路径只检查此标记；资源变化与正式事务同时使旧索引失效。
      if (event.type.startsWith('resource.')) writes.push({ file: 'state/keyword-generation.json', value: json(randomUUID()) });
    }
    try {
      await this.storage.transaction(writes);
      for (const write of writes) {
        if (write.file.startsWith('metadata/') && this.metasCache) { const id = path.basename(write.file, '.meta'); if (write.value === null) this.metasCache.delete(id); else this.metasCache.set(id, JSON.parse(write.value.toString()) as ResourceMeta); }
        if (write.file.startsWith('organizations/') && this.organizationsCache) { const id = path.basename(write.file, '.json'); if (write.value === null) this.organizationsCache.delete(id); else this.organizationsCache.set(id, JSON.parse(write.value.toString()) as Organization); }
      }
    } catch (error) { this.poisoned = true; throw error; }
  }
  async getResource(id: string): Promise<ResourceMeta> {
    this.validateId(id);
    return this.storage.snapshot(async () => { const found = (await this.allMetas()).find(item => item.id === id); assert(found, 'NOT_FOUND', '资源不存在', { id }); return found; });
  }
  async listResources(query: ResourceQuery = {}): Promise<QueryItem[]> {
    return this.storage.snapshot(async () => {
      const result: QueryItem[] = [];
      for (const resource of await this.allMetas()) {
        if (!query.includeDeleted && resource.deletedAt || query.ids && !query.ids.includes(resource.id)) continue;
        const terms = query.text ? normalize(query.text).split(/\s+/).filter(Boolean) : [];
        const reasons: string[] = [];
        if (terms.length) {
          const haystack = normalize(resource.originalName);
          if (!terms.every(term => haystack.includes(term))) continue;
          if (terms.some(term => normalize(resource.originalName).includes(term))) reasons.push('filename');
        }
        result.push({ resource, reasons, parseStatus: 'unprocessed' });
      }
      result.sort((a, b) => b.resource.createdAt.localeCompare(a.resource.createdAt) || a.resource.id.localeCompare(b.resource.id));
      return result.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? result.length));
    });
  }
  async resolveContentPath(id: string, version?: number): Promise<string> {
    const resource = await this.getResource(id);
    const file = version === undefined || version === resource.contentVersion ? resource.file : resource.history.find(item => item.contentVersion === version)?.file;
    assert(file, 'NOT_FOUND', '内容版本不存在', { id, version }); await this.storage.assertSafePath(file); return this.storage.resolve(file);
  }
  async readContent(id: string, version?: number): Promise<Buffer> { return this.storage.snapshot(async () => fs.readFile(await this.resolveContentPath(id, version))); }
  async importResource(file: string, options: { copy?: boolean; source?: string; originalName?: string } = {}): Promise<{ resource: ResourceMeta; duplicate: boolean }> {
    const content = await fs.readFile(path.resolve(file));
    return this.mutate(async () => {
      const hash = digest(content); const duplicate = (await this.allMetas()).find(meta => meta.hash === hash && !meta.deletedAt);
      if (duplicate && !options.copy) return { resource: duplicate, duplicate: true };
      const id = randomUUID(); const originalName = options.originalName ?? path.basename(file); const extension = this.extension(originalName);
      const timestamp = now();
      const resource: ResourceMeta = { schemaVersion: SCHEMA_VERSION, id, originalName, extension, mediaType: this.mediaType(extension), hash, size: content.length, contentVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp, file: `resources/${extension || 'unknown'}/${id}${extension ? '.' + extension : ''}`, references: [], plugins: {}, history: [], ...(options.source ? { source: options.source } : {}) };
      await this.commit([{ file: resource.file, value: content }, { file: this.metaPath(resource), value: json(resource) }], { type: 'resource.imported', entityId: id, revision: 1 });
      return { resource, duplicate: false };
    });
  }
  async updateResource(id: string, file: string, expectedContentVersion?: number): Promise<ResourceMeta> {
    const content = await fs.readFile(path.resolve(file));
    return this.mutate(async () => {
      const resource = await this.getResource(id); this.checkVersion(resource.contentVersion, expectedContentVersion);
      assert(!resource.deletedAt, 'RESOURCE_DELETED', '请先恢复资源');
      const hash = digest(content); if (hash === resource.hash) return resource;
      const old = await this.storage.readBytes(resource.file);
      const historyFile = `resources/history/${id}/${resource.contentVersion}${resource.extension ? '.' + resource.extension : ''}`;
      resource.history.push({ contentVersion: resource.contentVersion, hash: resource.hash, file: historyFile, size: resource.size, createdAt: resource.updatedAt });
      resource.contentVersion++; resource.revision++; resource.hash = hash; resource.size = content.length; resource.updatedAt = now();
      await this.commit([{ file: historyFile, value: old }, { file: resource.file, value: content }, { file: this.metaPath(resource), value: json(resource) }], { type: 'resource.updated', entityId: id, revision: resource.revision }); return resource;
    });
  }
  /** 记录、组织引用及调用方进度同一日志提交；不按正文去重。 */
  async appendRecord(input: { id: string; content: Buffer; title: string; source?: string; plugins: ResourceMeta['plugins']; references?: ResourceReference[]; organization?: Organization; state?: { key: string; value: unknown } }): Promise<ResourceMeta> {
    return this.mutate(async () => {
      this.validateId(input.id);
      assert(!(await this.allMetas()).some(item => item.id === input.id), 'ALREADY_EXISTS', '记录已存在');
      const timestamp = now();
      const resource: ResourceMeta = { schemaVersion: 1, id: input.id, originalName: input.title + '.md', extension: 'md', mediaType: 'text/markdown', hash: digest(input.content), size: input.content.length, contentVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp, file: `resources/md/${input.id}.md`, references: input.references ?? [], plugins: input.plugins, history: [], ...(input.source ? { source: input.source } : {}) };
      await this.validateReferences(resource.references);
      const writes: StorageMutation[] = [{ file: resource.file, value: input.content }, { file: this.metaPath(resource), value: json(resource) }];
      if (input.organization) {
        const organization = structuredClone(input.organization);
        this.checkVersion((await this.getOrganization(organization.id)).revision, organization.revision);
        assert(organization.type === 'session-transcript', 'INVALID_INPUT', '仅支持转录组织追加');
        organization.references.push({ kind: 'resource', id: resource.id });
        await this.validateReferences(organization.references.filter(ref => ref.id !== resource.id || ref.kind !== 'resource'));
        organization.revision++; organization.updatedAt = timestamp;
        writes.push({ file: `organizations/${organization.id}.json`, value: json(organization) });
      }
      if (input.state) {
        assert(/^[a-zA-Z0-9_-]+$/.test(input.state.key), 'INVALID_KEY', '记录状态键非法');
        writes.push({ file: `plugins/records/data/${input.state.key}.json`, value: json(input.state.value) });
      }
      await this.commit(writes, { type: 'resource.imported', entityId: resource.id, revision: 1 });
      return resource;
    });
  }
  async deleteResource(id: string): Promise<ResourceMeta> { return this.changeDeleted(id, true); }
  async restoreResource(id: string): Promise<ResourceMeta> { return this.changeDeleted(id, false); }
  private async changeDeleted(id: string, deleted: boolean): Promise<ResourceMeta> {
    return this.mutate(async () => { const resource = await this.getResource(id); if (!!resource.deletedAt === deleted) return resource; if (deleted) resource.deletedAt = now(); else delete resource.deletedAt; resource.revision++; resource.updatedAt = now(); await this.commit([{ file: this.metaPath(resource), value: json(resource) }], { type: deleted ? 'resource.deleted' : 'resource.restored', entityId: id, revision: resource.revision }); return resource; });
  }
  async purgeResource(id: string): Promise<void> {
    return this.mutate(async () => { const resource = await this.getResource(id); assert(resource.deletedAt, 'NOT_DELETED', '仅可清理回收状态资源'); await this.assertNotReferenced('resource', id); await this.commit([{ file: resource.file, value: null }, { file: this.metaPath(resource), value: null }, ...resource.history.map(item => ({ file: item.file, value: null }))], { type: 'resource.purged', entityId: id, revision: resource.revision }); });
  }
  async updatePluginMeta(id: string, pluginId: string, data: JsonObject, options: { schemaVersion?: number; expectedRevision?: number; expectedContentVersion?: number; references?: ResourceReference[] } = {}): Promise<ResourceMeta> {
    assert(/^[a-z][a-z0-9-]*$/.test(pluginId), 'INVALID_PLUGIN_ID', '插件标识非法');
    return this.mutate(async () => { const resource = await this.getResource(id); this.checkVersion(resource.revision, options.expectedRevision); this.checkVersion(resource.contentVersion, options.expectedContentVersion); if (options.references) { await this.validateReferences(options.references); resource.references = [...resource.references.filter(ref => ref.owner !== pluginId), ...options.references.map(ref => ({ ...ref, owner: pluginId }))]; } resource.plugins[pluginId] = { schemaVersion: options.schemaVersion ?? 1, data }; resource.revision++; resource.updatedAt = now(); await this.commit([{ file: this.metaPath(resource), value: json(resource) }], { type: 'resource.meta.updated', entityId: id, revision: resource.revision }); return resource; });
  }
  async listOrganizations(type?: string): Promise<Organization[]> { return this.storage.snapshot(async () => {
    let values: Organization[];
    if (!this.storage.readOnly && this.organizationsCache) values = structuredClone([...this.organizationsCache.values()]);
    else { values = await Promise.all((await this.storage.files('organizations')).filter(file => file.endsWith('.json')).map(async file => { const value: unknown = await this.storage.readJson(file); validateOrganization(value, file); return value; })); if (!this.storage.readOnly) this.organizationsCache = new Map(values.map(item => [item.id, structuredClone(item)])); }
    return values.filter(item => !type || item.type === type).sort((a, b) => a.name.localeCompare(b.name));
  }); }
  async getOrganization(id: string): Promise<Organization> { this.validateId(id); return this.storage.snapshot(async () => { const file = `organizations/${id}.json`; const value = await this.storage.readJson<unknown>(file, null); assert(value, 'NOT_FOUND', '组织不存在', { id }); validateOrganization(value, file); return value; }); }
  private organizationScheduleWrites(organization: Organization, operation?: JsonObject): StorageMutation[] {
    const writes: StorageMutation[] = [{ file: `organizations/${organization.id}.json`, value: json(organization) }];
    if (!operation) return writes;
    assert(organization.type === 'session-transcript' && organization.pluginId === 'transcripts', 'INVALID_CRON_CONFIG', '只能为转录实例保存周期变更');
    writes.push({ file: `plugins/cron/data/intent-${organization.id}.json`, value: json({ ...operation, target: organization.id }) });
    return writes;
  }
  async createOrganization(input: { type: string; name: string; data?: JsonObject; references?: ResourceReference[]; pluginId?: string; id?: string }, scheduleOperation?: JsonObject): Promise<Organization> {
    return this.mutate(async () => { assert(input.type && input.name, 'INVALID_INPUT', '组织需要 type 和 name'); if (input.type === 'session-transcript') assert(!(await this.listOrganizations(input.type)).some(item => normalize(item.name) === normalize(input.name)), 'ALIAS_CONFLICT', '转录别名已存在'); const organizationType = (await this.listOrganizationTypes()).find(item => item.id === input.type); assert(!organizationType || organizationType.enabled, 'ORGANIZATION_TYPE_DISABLED', '组织方式已停用，不能新增组织实例', { type: input.type }); const id = input.id ?? randomUUID(); this.validateId(id); assert(!(await this.listOrganizations()).some(item => item.id === id), 'ALREADY_EXISTS', '组织已存在'); await this.validateReferences(input.references ?? []); const timestamp = now(); const organization: Organization = { schemaVersion: 1, id, type: input.type, name: input.name, revision: 1, createdAt: timestamp, updatedAt: timestamp, references: input.references ?? [], data: input.data ?? {}, ...(input.pluginId ? { pluginId: input.pluginId } : {}) }; await this.commit(this.organizationScheduleWrites(organization, scheduleOperation), { type: 'organization.created', entityId: id, revision: 1 }); return organization; });
  }
  async updateOrganization(id: string, patch: { name?: string; data?: JsonObject; references?: ResourceReference[] }, expectedRevision?: number, scheduleOperation?: JsonObject): Promise<Organization> {
    return this.mutate(async () => { const organization = await this.getOrganization(id); this.checkVersion(organization.revision, expectedRevision); if (patch.references) await this.validateReferences(patch.references); if (patch.name !== undefined) { assert(typeof patch.name === 'string' && patch.name.trim(), 'INVALID_INPUT', '组织名称不能为空'); if (organization.type === 'session-transcript') assert(!(await this.listOrganizations(organization.type)).some(item => item.id !== id && normalize(item.name) === normalize(patch.name!)), 'ALIAS_CONFLICT', '转录别名已存在'); organization.name = patch.name; } if (patch.data !== undefined) organization.data = patch.data; if (patch.references !== undefined) organization.references = patch.references; organization.revision++; organization.updatedAt = now(); await this.commit(this.organizationScheduleWrites(organization, scheduleOperation), { type: 'organization.updated', entityId: id, revision: organization.revision }); return organization; });
  }
  async deleteOrganization(id: string): Promise<void> { return this.mutate(async () => { const organization = await this.getOrganization(id); await this.assertNotReferenced('organization', id); await this.commit([{ file: `organizations/${id}.json`, value: null }], { type: 'organization.deleted', entityId: id, revision: organization.revision }); }); }
  async listOrganizationTypes(): Promise<OrganizationType[]> {
    return this.storage.snapshot(async () => Promise.all((await this.storage.files('organization-types')).filter(file => file.endsWith('.json')).map(async file => { const value: unknown = await this.storage.readJson(file); validateOrganizationType(value, file); return value; })));
  }
  async getOrganizationType(id: string): Promise<OrganizationType> {
    assert(/^[a-z][a-z0-9-]{0,63}$/.test(id), 'INVALID_ORGANIZATION_TYPE', '组织方式id必须为小写字母数字短横线');
    return this.storage.snapshot(async () => { const file = `organization-types/${id}.json`; const value: unknown = await this.storage.readJson(file, null); assert(value, 'NOT_FOUND', '组织方式不存在', { id }); validateOrganizationType(value, file); return value; });
  }
  /** 默认方式登记幂等，已有配置与启停状态不被插件初始化覆盖。 */
  async registerOrganizationType(input: OrganizationTypeInput): Promise<OrganizationType> {
    return this.mutate(async () => {
      assert(typeof input.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(input.id), 'INVALID_ORGANIZATION_TYPE', '组织方式id非法');
      const existing = (await this.listOrganizationTypes()).find(item => item.id === input.id);
      if (existing) { assert(existing.handlerPluginId === input.handlerPluginId, 'ORGANIZATION_TYPE_CONFLICT', '该组织方式已绑定不同处理器', { id: input.id }); return existing; }
      assert(!input.handlerPluginId || this.organizationHandlers.has(input.handlerPluginId), 'UNKNOWN_ORGANIZATION_HANDLER', '绑定的处理器插件不存在', { handlerPluginId: input.handlerPluginId });
      const timestamp = now(); const value: OrganizationType = { schemaVersion: 1, id: input.id, name: input.name, description: input.description ?? '', config: input.config ?? {}, enabled: input.enabled ?? true, revision: 1, createdAt: timestamp, updatedAt: timestamp, ...(input.handlerPluginId ? { handlerPluginId: input.handlerPluginId } : {}) };
      await this.commit([{ file: `organization-types/${value.id}.json`, value: json(value) }], { type: 'organization-type.registered', entityId: value.id, revision: 1 }); return value;
    });
  }
  async updateOrganizationType(id: string, patch: OrganizationTypePatch, expectedRevision?: number): Promise<OrganizationType> {
    return this.mutate(async () => { const value = await this.getOrganizationType(id); this.checkVersion(value.revision, expectedRevision); if (patch.name !== undefined) value.name = patch.name; if (patch.description !== undefined) value.description = patch.description; if (patch.config !== undefined) value.config = patch.config; if (patch.enabled !== undefined) value.enabled = patch.enabled; value.revision++; value.updatedAt = now(); await this.commit([{ file: `organization-types/${id}.json`, value: json(value) }], { type: 'organization-type.updated', entityId: id, revision: value.revision }); return value; });
  }
  async deleteOrganizationType(id: string): Promise<void> {
    return this.mutate(async () => { const value = await this.getOrganizationType(id); const used = (await this.listOrganizations()).filter(item => item.type === id).map(item => item.id); assert(!used.length, 'ORGANIZATION_TYPE_IN_USE', '组织方式仍有实例，必须先迁移或清理组织', { id, organizations: used }); await this.commit([{ file: `organization-types/${id}.json`, value: null }], { type: 'organization-type.deleted', entityId: id, revision: value.revision }); });
  }
  async events(after = 0): Promise<CoreEvent[]> { return this.storage.snapshot(async () => (await this.storage.readJson<CoreEvent[]>('state/events.json', [])).filter(event => event.sequence > after)); }
  pluginStore(pluginId: string): PluginStore {
    assert(/^[a-z][a-z0-9-]*$/.test(pluginId), 'INVALID_PLUGIN_ID', '插件标识非法');
    const file = (key: string, category: 'data' | 'cache' = 'data') => { assert(/^[a-zA-Z0-9._-]+$/.test(key) && !key.startsWith('.'), 'INVALID_KEY', '存储键只允许字母数字点下划线短横线'); const name = key.endsWith('.json') ? key : `${key}.json`; return category === 'data' ? `plugins/${pluginId}/data/${name}` : `cache/${pluginId}/${name}`; };
    return { read: <T>(key: string, fallback: T, category?: 'data' | 'cache') => this.storage.snapshot(() => this.storage.readJson<T>(file(key, category), fallback)), write: (key, value, category) => this.mutate(() => this.commit([{ file: file(key, category), value: json(value) }])), remove: (key, category) => this.mutate(() => this.commit([{ file: file(key, category), value: null }])), list: async category => (await this.storage.files(category === 'cache' ? `cache/${pluginId}` : `plugins/${pluginId}/data`)).filter(value => value.endsWith('.json')).map(value => path.basename(value, '.json')) };
  }
  private async validateReferences(references: ResourceReference[]): Promise<void> { validateReferenceShape(references); for (const ref of references) { if (ref.kind === 'resource') await this.getResource(ref.id); else await this.getOrganization(ref.id); } }
  private async assertNotReferenced(kind: ResourceReference['kind'], id: string): Promise<void> {
    const incoming: string[] = [];
    // 身份由kind与UUID共同确定；跨类型同UUID仍是外部入站引用。
    const sources = [
      ...(await this.allMetas()).map(item => ({ kind: 'resource' as const, item })),
      ...(await this.listOrganizations()).map(item => ({ kind: 'organization' as const, item })),
    ];
    for (const source of sources) {
      const self = source.kind === kind && source.item.id === id;
      if (!self && source.item.references.some(ref => ref.kind === kind && ref.id === id)) incoming.push(source.item.id);
    }
    assert(incoming.length === 0, 'REFERENCED', '对象仍被引用，必须先迁移或清理关联', { incoming });
  }
  private checkVersion(actual: number, expected?: number): void { if (expected !== undefined) assert(actual === expected, 'VERSION_CONFLICT', '输入版本已过期', { actual, expected }); }
  private extension(name: string): string { const extension = path.extname(name).slice(1).toLowerCase(); return /^[a-z0-9]{1,16}$/.test(extension) ? extension : ''; }
  private mediaType(extension: string): string { return ({ md: 'text/markdown', txt: 'text/plain', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf', svg: 'image/svg+xml' } as Record<string, string>)[extension] ?? 'application/octet-stream'; }
  /** 检查正式数据，不依赖可重建索引；返回全部问题便于修复。 */
  async check(): Promise<{ valid: boolean; issues: { code: string; file?: string; id?: string; message: string }[]; resources: number; organizations: number; organizationTypes: number }> {
    return this.storage.snapshot(async () => {
      const issues: { code: string; file?: string; id?: string; message: string }[] = []; const metas: ResourceMeta[] = []; const organizations: Organization[] = [];
      for (const file of (await this.storage.files('metadata')).filter(file => file.endsWith('.meta'))) { try { const meta = await this.storage.readJson<ResourceMeta>(file); assert(meta.schemaVersion === 1 && UUID.test(meta.id), 'INVALID_META', 'meta结构或版本非法'); metas.push(meta); for (const entry of [{ file: meta.file, hash: meta.hash }, ...meta.history]) { const bytes = await this.storage.readBytes(entry.file); assert(digest(bytes) === entry.hash, 'HASH_MISMATCH', '内容哈希不一致'); } } catch (error) { issues.push({ code: error instanceof KnowledgeError ? error.code : 'INVALID_RESOURCE', file, message: String(error) }); } }
      for (const file of await this.storage.files('organizations')) { try { const organization = await this.storage.readJson<Organization>(file); assert(organization.schemaVersion === 1 && UUID.test(organization.id), 'INVALID_ORGANIZATION', '组织结构非法'); organizations.push(organization); } catch (error) { issues.push({ code: 'INVALID_ORGANIZATION', file, message: String(error) }); } }
      let organizationTypes = 0;
      for (const file of (await this.storage.files('organization-types')).filter(file => file.endsWith('.json'))) { try { const value: unknown = await this.storage.readJson(file); validateOrganizationType(value, file); organizationTypes++; } catch (error) { issues.push({ code: error instanceof KnowledgeError ? error.code : 'INVALID_ORGANIZATION_TYPE', file, message: String(error) }); } }
      const resourceIds = new Set(metas.map(item => item.id)); const organizationIds = new Set(organizations.map(item => item.id));
      for (const item of [...metas, ...organizations]) for (const ref of item.references ?? []) if (!(ref.kind === 'resource' ? resourceIds : organizationIds).has(ref.id)) issues.push({ code: 'DANGLING_REFERENCE', id: item.id, message: `${ref.kind}:${ref.id}` });
      const known = new Set(metas.flatMap(meta => [meta.file, this.metaPath(meta), ...meta.history.map(item => item.file)]));
      for (const file of await this.storage.files('resources')) if (!known.has(file) && !file.endsWith('.tmp')) issues.push({ code: 'ORPHAN_FILE', file, message: '原件缺少元数据引用' });
      return { valid: !issues.length, issues, resources: metas.length, organizations: organizations.length, organizationTypes };
    });
  }
  async reindex(): Promise<{ resources: number; organizations: number }> { const resources = await this.listResources({ includeDeleted: true }); const organizations = await this.listOrganizations(); await this.mutate(() => this.commit([{ file: 'cache/index.json', value: json({ schemaVersion: 1, resources: resources.map(item => ({ id: item.resource.id, hash: item.resource.hash })), organizations: organizations.map(item => ({ id: item.id, type: item.type })) }) }])); return { resources: resources.length, organizations: organizations.length }; }
  async backup(target: string): Promise<{ file: string; files: number }> {
    const absolute = path.resolve(target); assert(!absolute.startsWith(this.dataDir + path.sep), 'INVALID_BACKUP_PATH', '备份文件不能放入数据目录内部');
    return this.storage.snapshot(async () => { const files = [...await this.storage.files('resources'), ...await this.storage.files('metadata'), ...await this.storage.files('organizations'), ...await this.storage.files('organization-types'), ...await this.storage.files('plugins'), ...await this.storage.files('state')].filter(file => !file.endsWith('.tmp')); files.forEach(validateFormalPath); const entries = await Promise.all(files.map(async file => { const bytes = await this.storage.readBytes(file); return { file, hash: digest(bytes), content: bytes.toString('base64') }; })); const backup = { schemaVersion: 1, createdAt: now(), entries }; await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, json(backup), { flag: 'wx' }); return { file: absolute, files: entries.length }; });
  }
  async restore(source: string, serviceRestore?: JsonObject): Promise<{ files: number }> {
    const backup = JSON.parse(await fs.readFile(path.resolve(source), 'utf8')) as { schemaVersion: number; entries: { file: string; hash: string; content: string }[] };
    assert(backup.schemaVersion === 1 && Array.isArray(backup.entries), 'INVALID_BACKUP', '备份结构不支持');
    return this.mutate(async () => {
      const existing = [...await this.storage.files('resources'), ...await this.storage.files('metadata'), ...await this.storage.files('organizations'), ...await this.storage.files('organization-types'), ...await this.storage.files('plugins')];
      assert(!existing.length, 'RESTORE_NOT_EMPTY', '恢复要求目标没有正式业务数据');
      const seen = new Set<string>(); const resources: ResourceMeta[] = []; const organizations: Organization[] = [];
      // 全量预检完成前不得写 journal 或任何正式文件。
      const writes = backup.entries.map(entry => {
        assert(entry && typeof entry === 'object', 'INVALID_BACKUP', '备份条目必须为对象');
        validateFormalPath(entry.file); this.storage.resolve(entry.file);
        const canonical = entry.file.toLowerCase(); assert(!seen.has(canonical), 'INVALID_BACKUP', '备份规范路径重复', { file: entry.file }); seen.add(canonical);
        assert(canonical !== SERVICE_RESTORE_MARKER, 'INVALID_BACKUP', '备份不得包含服务恢复事务');
        assert(typeof entry.content === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content), 'INVALID_BACKUP', '备份内容必须为规范base64');
        const value = Buffer.from(entry.content, 'base64'); assert(digest(value) === entry.hash, 'INVALID_BACKUP', '备份校验失败', { file: entry.file });
        if (!entry.file.startsWith('resources/')) {
          let parsed: unknown; try { parsed = JSON.parse(value.toString('utf8')); } catch { throw new KnowledgeError('INVALID_BACKUP', '备份正式JSON文件损坏', { file: entry.file }); }
          if (entry.file.startsWith('metadata/')) { validateResource(parsed, entry.file); resources.push(parsed); }
          else if (entry.file.startsWith('organizations/')) { validateOrganization(parsed, entry.file); organizations.push(parsed); }
          else if (entry.file.startsWith('organization-types/')) validateOrganizationType(parsed, entry.file);
          else if (entry.file === 'state/generation.json') assert(Number.isSafeInteger(parsed) && Number(parsed) >= 0, 'INVALID_BACKUP', '提交序号非法');
          else if (entry.file === 'state/keyword-generation.json') assert(typeof parsed==='string'&&UUID.test(parsed),'INVALID_BACKUP','关键词变更标记非法');
          else if (entry.file === 'state/events.json') assert(Array.isArray(parsed) && parsed.every((event, index) => event && Number.isSafeInteger(event.sequence) && event.sequence > 0 && (!index || event.sequence > parsed[index - 1].sequence) && typeof event.type === 'string' && typeof event.entityId === 'string' && (event.type.startsWith('organization-type.') ? /^[a-z][a-z0-9-]{0,63}$/.test(event.entityId) : UUID.test(event.entityId)) && Number.isSafeInteger(event.revision) && event.revision > 0 && Number.isFinite(Date.parse(event.at))), 'INVALID_BACKUP', '持久事件结构非法');
        }
        return { file: entry.file, value };
      });
      const contents = new Map(writes.map(write => [write.file, write.value]));
      const resourceIds = new Set(resources.map(item => item.id)); const organizationIds = new Set(organizations.map(item => item.id)); const referencedFiles = new Set<string>();
      for (const resource of resources) for (const content of [{ file: resource.file, hash: resource.hash, size: resource.size }, ...resource.history]) {
        const bytes = contents.get(content.file); assert(bytes && digest(bytes) === content.hash && bytes.length === content.size, 'INVALID_BACKUP', '资源原件缺失或与meta不一致', { file: content.file }); referencedFiles.add(content.file);
      }
      for (const write of writes) if (write.file.startsWith('resources/')) assert(referencedFiles.has(write.file), 'INVALID_BACKUP', '原件缺少meta引用', { file: write.file });
      for (const item of [...resources, ...organizations]) for (const ref of item.references) assert((ref.kind === 'resource' ? resourceIds : organizationIds).has(ref.id), 'INVALID_BACKUP', '备份含悬空引用', { id: item.id, reference: ref });
      await this.commit(serviceRestore === undefined ? writes : [...writes, { file: SERVICE_RESTORE_MARKER, value: json(serviceRestore) }]);
      return { files: writes.length };
    });
  }
}
