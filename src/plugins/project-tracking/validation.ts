import { createHash } from 'node:crypto';
import { KnowledgeError } from '../../core/errors.js';
import type { Organization } from '../../contracts/index.js';
import type { AddProjectEntryInput, ProjectData, ProjectEntry } from './types.js';

// 项目条目结构版本与插件版本独立；未知版本不可降级覆盖。
export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_TYPE = 'project-development-tracking';
export const PROJECT_PLUGIN_ID = 'project-tracking';
export const ROLES = ['baseline', 'state', 'change', 'decision', 'verification'] as const;
export const STAGES = ['planned', 'confirmed', 'implemented', 'verified'] as const;
export function invalid(message: string): never { throw new KnowledgeError('INVALID_ARGUMENT', message, undefined, 2); }
export function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${name}必须为非空字符串`);
  return value;
}
export function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) invalid(`${name}必须为非空字符串数组`);
  return value as string[];
}
export function version(value: unknown): string {
  const text = nonempty(value, 'projectVersion');
  if (!/^v?\d+\.\d+\.\d+$/u.test(text)) invalid('projectVersion必须为三段数值版本，可带v前缀');
  const parts = text.replace(/^v/u, '').split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) invalid('版本分量超出安全整数范围');
  return parts.join('.');
}
export function compareVersion(a: string, b: string): number {
  const right = b.split('.').map(Number);
  for (const [index, part] of a.split('.').map(Number).entries()) { const delta = part - right[index]; if (delta) return delta; }
  return 0;
}
export function orderEntries(a: ProjectEntry, b: ProjectEntry): number {
  return compareVersion(b.projectVersion, a.projectVersion) || Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.id.localeCompare(b.id);
}
export function timestamp(value: unknown): string {
  const text = nonempty(value, 'recordedAt');
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/u.exec(text);
  if (!match || !Number.isFinite(Date.parse(text))) invalid('recordedAt必须为包含时区的ISO时间');
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year); const m = Number(month); const d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) invalid('recordedAt包含无效日期或时间');
  return new Date(text).toISOString();
}
export function projectData(project: Organization): ProjectData {
  if (project.type !== PROJECT_TYPE || project.pluginId !== PROJECT_PLUGIN_ID) throw new KnowledgeError('PROJECT_INVALID', '目标组织不是项目跟踪实例');
  if (project.data.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new KnowledgeError('UNSUPPORTED_PROJECT_SCHEMA', '不支持的项目数据版本，禁止读取或覆盖', { actual: project.data.schemaVersion, supported: PROJECT_SCHEMA_VERSION });
  if (!Array.isArray(project.data.entries) || typeof project.data.description !== 'string') throw new KnowledgeError('PROJECT_INVALID', '项目数据结构损坏');
  const data = project.data as unknown as ProjectData;
  const ids = new Set<string>();
  for (const entry of data.entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || !entry.resourceId || !Number.isSafeInteger(entry.contentVersion) || entry.contentVersion < 1 || !/^[a-f0-9]{64}$/u.test(entry.contentHash ?? '') || !entry.snapshot || !Array.isArray(entry.snapshot.keywords) || !entry.snapshot.tags || !Array.isArray(entry.snapshot.tags.items)) throw new KnowledgeError('PROJECT_INVALID', '项目条目结构损坏');
    version(entry.projectVersion); timestamp(entry.recordedAt);
    if (!ROLES.includes(entry.role) || !STAGES.includes(entry.stage)) throw new KnowledgeError('PROJECT_INVALID', '项目条目角色或阶段损坏');
    ids.add(entry.id);
  }
  return data;
}
/** 指纹只记录调用方显式字段，不读取时间、最新版本、标签定义等动态输入。 */
export function validateAdd(input: AddProjectEntryInput): { fingerprint: string; projectVersion: string } {
  nonempty(input.projectId, 'projectId'); nonempty(input.resourceId, 'resourceId'); nonempty(input.title, 'title');
  if (!ROLES.includes(input.role)) invalid('无效role');
  if (!STAGES.includes(input.stage)) invalid('无效stage');
  const projectVersion = version(input.projectVersion);
  if (input.contentVersion !== undefined && (!Number.isSafeInteger(input.contentVersion) || input.contentVersion < 1)) invalid('contentVersion必须为正整数');
  if (input.recordedAt !== undefined) timestamp(input.recordedAt);
  if (input.requestId !== undefined) nonempty(input.requestId, 'requestId');
  if (input.tags !== undefined) stringArray(input.tags, 'tags');
  if (input.replaces !== undefined) {
    if (!input.replaces || typeof input.replaces !== 'object') invalid('replaces必须为对象');
    if (!stringArray(input.replaces.entryIds, 'replaces.entryIds').length) invalid('替代目标不能为空');
    if (new Set(input.replaces.entryIds).size !== input.replaces.entryIds.length) invalid('替代目标不能重复');
    nonempty(input.replaces.scope, 'replaces.scope'); nonempty(input.replaces.effect, 'replaces.effect');
  }
  const explicit = { resourceId: input.resourceId, title: input.title, role: input.role, projectVersion: input.projectVersion, stage: input.stage, contentVersion: input.contentVersion, recordedAt: input.recordedAt, tags: input.tags, replaces: input.replaces && { entryIds: input.replaces.entryIds, scope: input.replaces.scope, effect: input.replaces.effect } };
  return { projectVersion, fingerprint: createHash('sha256').update(JSON.stringify(explicit)).digest('hex') };
}
