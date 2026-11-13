import path from 'node:path';
import type { Organization, OrganizationType, ResourceMeta, ResourceReference } from '../contracts/index.js';
import { assert } from './errors.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // 稳定资源与组织身份。
const HASH_PATTERN = /^[0-9a-f]{64}$/; // 原件及历史内容仅接受 SHA256。
const PLUGIN_PATTERN = /^[a-z][a-z0-9-]*$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const size = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validateReferenceShape(value: unknown): asserts value is ResourceReference[] {
  assert(Array.isArray(value), 'INVALID_REFERENCES', '引用必须为数组');
  for (const reference of value) assert(record(reference) && ['resource', 'organization'].includes(String(reference.kind)) && typeof reference.id === 'string' && UUID_PATTERN.test(reference.id) && (reference.owner === undefined || typeof reference.owner === 'string' && PLUGIN_PATTERN.test(reference.owner)), 'INVALID_REFERENCE', '正式引用结构非法');
}
/** 文件路径必须原样符合正式数据白名单，禁止规范化后逃入锁/日志。 */
export function validateFormalPath(file: unknown): asserts file is string {
  assert(typeof file === 'string' && !file.includes('\\') && !file.includes(':') && !file.includes('\0') && path.posix.normalize(file) === file && file.split('/').every(segment => segment !== '.' && segment !== '..' && !segment.startsWith('.')), 'INVALID_BACKUP_PATH', '备份包含非规范路径', { file });
  const id = '[0-9a-fA-F-]{36}';
  assert(new RegExp(`^(resources/(?:[a-z0-9]{1,16}|unknown)/${id}(?:\\.[a-z0-9]{1,16})?|resources/history/${id}/[1-9][0-9]*(?:\\.[a-z0-9]{1,16})?|metadata/${id}\\.meta|organizations/${id}\\.json|organization-types/[a-z][a-z0-9-]{0,63}\\.json|plugins/[a-z][a-z0-9-]*/data/[a-zA-Z0-9][a-zA-Z0-9._-]*\\.json|state/(?:events|generation|keyword-generation)\\.json)$`).test(file) && !file.endsWith('.tmp'), 'INVALID_BACKUP_PATH', '备份路径不属于正式数据白名单', { file });
}
export function validateResource(value: unknown, file?: string): asserts value is ResourceMeta {
  assert(record(value), 'INVALID_META', '资源meta必须为对象');
  assert(value.schemaVersion === 1, 'UNSUPPORTED_SCHEMA', '不支持此资源meta结构版本，禁止读取和写回', { schemaVersion: value.schemaVersion, file });
  assert(typeof value.id === 'string' && UUID_PATTERN.test(value.id) && typeof value.originalName === 'string' && value.originalName.length > 0 && typeof value.extension === 'string' && /^(?:[a-z0-9]{1,16})?$/.test(value.extension) && typeof value.mediaType === 'string', 'INVALID_META', '资源身份/名称/格式非法', { file });
  const expected = `resources/${value.extension || 'unknown'}/${value.id}${value.extension ? '.' + value.extension : ''}`;
  assert(value.file === expected && (file === undefined || file === `metadata/${value.id}.meta`), 'INVALID_META', '资源原件或meta路径与身份不一致', { file });
  assert(typeof value.hash === 'string' && HASH_PATTERN.test(value.hash) && size(value.size) && positive(value.contentVersion) && positive(value.revision) && timestamp(value.createdAt) && timestamp(value.updatedAt) && (value.deletedAt === undefined || timestamp(value.deletedAt)), 'INVALID_META', '资源版本/哈希/时间非法', { file });
  validateReferenceShape(value.references);
  assert(record(value.plugins) && Array.isArray(value.history), 'INVALID_META', '资源插件分区或历史非法', { file });
  for (const [id, partition] of Object.entries(value.plugins)) assert(PLUGIN_PATTERN.test(id) && record(partition) && positive(partition.schemaVersion) && record(partition.data), 'INVALID_META', '插件分区结构非法', { id, file });
  const versions = new Set<number>();
  for (const entry of value.history) {
    assert(record(entry) && positive(entry.contentVersion) && Number(entry.contentVersion) < Number(value.contentVersion) && !versions.has(Number(entry.contentVersion)) && entry.file === `resources/history/${value.id}/${entry.contentVersion}${value.extension ? '.' + value.extension : ''}` && typeof entry.hash === 'string' && HASH_PATTERN.test(entry.hash) && size(entry.size) && timestamp(entry.createdAt), 'INVALID_META', '资源历史结构非法', { file });
    versions.add(Number(entry.contentVersion));
  }
}
export function validateOrganization(value: unknown, file?: string): asserts value is Organization {
  assert(record(value), 'INVALID_ORGANIZATION', '组织必须为对象');
  assert(value.schemaVersion === 1, 'UNSUPPORTED_SCHEMA', '不支持此组织结构版本，禁止读取和写回', { schemaVersion: value.schemaVersion, file });
  assert(typeof value.id === 'string' && UUID_PATTERN.test(value.id) && (file === undefined || file === `organizations/${value.id}.json`) && typeof value.type === 'string' && value.type.trim().length > 0 && typeof value.name === 'string' && value.name.trim().length > 0 && positive(value.revision) && timestamp(value.createdAt) && timestamp(value.updatedAt) && record(value.data) && (value.pluginId === undefined || typeof value.pluginId === 'string' && PLUGIN_PATTERN.test(value.pluginId)), 'INVALID_ORGANIZATION', '组织结构非法', { file });
  validateReferenceShape(value.references);
}
export function validateOrganizationType(value: unknown, file?: string): asserts value is OrganizationType {
  assert(record(value), 'INVALID_ORGANIZATION_TYPE', '组织方式必须为对象');
  assert(value.schemaVersion === 1, 'UNSUPPORTED_SCHEMA', '不支持此组织方式结构版本', { schemaVersion: value.schemaVersion, file });
  assert(typeof value.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.id) && (file === undefined || file === `organization-types/${value.id}.json`) && typeof value.name === 'string' && value.name.trim().length > 0 && typeof value.description === 'string' && typeof value.enabled === 'boolean' && record(value.config) && positive(value.revision) && timestamp(value.createdAt) && timestamp(value.updatedAt) && (value.handlerPluginId === undefined || typeof value.handlerPluginId === 'string' && PLUGIN_PATTERN.test(value.handlerPluginId)), 'INVALID_ORGANIZATION_TYPE', '组织方式结构非法', { file });
}
