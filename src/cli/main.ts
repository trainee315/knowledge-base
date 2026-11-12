#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreManager } from '../core/manager.js';
import { KnowledgeError } from '../core/errors.js';
import { openApplication } from '../index.js';
import { handlePreview } from '../preview/index.js';
import { noteCommand } from '../records/note.js';
import { transcriptCommand } from '../records/transcript.js';
import type { JsonObject, ResourceReference, ResourceQuery, OrganizationTypePatch } from '../contracts/index.js';

// 数据位置与工作目录解耦，便于 PPC 从其他目录调用。
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data');
function argumentError(message: string): never { throw new KnowledgeError('INVALID_ARGUMENT', message, undefined, 2); }
function string(input: Record<string, unknown>, key: string, required = true): string | undefined { const value = input[key]; if (value === undefined && !required) return undefined; if (typeof value !== 'string' || !value.trim()) argumentError(`参数 ${key} 必须为非空字符串`); return value; }
function number(input: Record<string, unknown>, key: string): number | undefined { if (input[key] === undefined) return undefined; const value = Number(input[key]); if (!Number.isInteger(value) || value < 0) argumentError(`参数 ${key} 必须为非负整数`); return value; }
function flag(input: Record<string, unknown>, key: string): boolean { return input[key] === true || input[key] === 'true'; }
function boolean(input: Record<string, unknown>, key: string): boolean { const value = input[key]; if (value === true || value === 'true') return true; if (value === false || value === 'false') return false; argumentError(`参数 ${key} 必须为boolean`); }
function object(input: Record<string, unknown>, key: string, fallback: JsonObject = {}): JsonObject { const value = input[key] ?? fallback; if (value === null || typeof value !== 'object' || Array.isArray(value)) argumentError(`参数 ${key} 必须为JSON对象`); return value as JsonObject; }
function array(input: Record<string, unknown>, key: string): string[] | undefined { const value = input[key]; if (value === undefined) return undefined; if (typeof value === 'string') return value.split(','); if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) argumentError(`参数 ${key} 必须为字符串数组`); return value; }
async function stdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }
/** 解析统一输入：文件/stdin 对象先读，再用显式命令行选项覆盖。 */
async function parse(argv: string[]) {
  const words: string[] = []; const options: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith('--')) { const equal = token.indexOf('='); const key = (equal < 0 ? token.slice(2) : token.slice(2, equal)).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); if (!key) argumentError('空选项'); let value: unknown = true; if (equal >= 0) value = token.slice(equal + 1); else if (!['json', 'help', 'copy', 'cascade', 'includeDeleted', 'content'].includes(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) value = argv[++index]; options[key] = value; } else words.push(token);
  }
  let input: Record<string, unknown> = {};
  if (options.input !== undefined) { if (typeof options.input !== 'string') argumentError('--input 需要文件路径或 -'); const source = options.input === '-' ? await stdin() : await fs.readFile(path.resolve(options.input), 'utf8'); try { const data: unknown = JSON.parse(source.replace(/^\uFEFF/, '')); if (data === null || typeof data !== 'object' || Array.isArray(data)) argumentError('--input 顶层必须为JSON对象'); input = data as Record<string, unknown>; } catch (error) { if (error instanceof KnowledgeError) throw error; argumentError('--input 不是有效UTF8 JSON'); } }
  return { words, input: { ...input, ...options }, dataDir: path.resolve(typeof options.dataDir === 'string' ? options.dataDir : DEFAULT_DATA_DIR) };
}
async function run(): Promise<unknown> {
  const { words, input, dataDir } = await parse(process.argv.slice(2)); const [group, action] = words;
  if (!group || group === 'help' || flag(input, 'help')) return { version: '0.0.4', usage: 'cli.bat <command> [action] --input file|- --data-dir path --json', commands: ['resource import/list/get/update/delete/restore/purge/history', 'note add/list/get', 'transcript create/list/get/configure/preview/run/tick/records/retry/backfill', 'meta get/set', 'organization create/list/get/update/delete', 'organization-type register/list/get/update/enable/disable/delete', 'plugin list/enable/disable/refresh', 'project-track create/list/get/add/documents/read/query', 'agent status / profile list|get|set|delete / config get|set / generate text|object', 'backup --file path', 'restore --file path', 'check', 'reindex', 'preview start/stop/status', 'content/keyword/tag/relation/system/task/organize/schedule (插件命令)'] };
  if (group === 'preview') return handlePreview([...words.slice(1), ...(input.port !== undefined ? ['--port', String(input.port)] : [])], dataDir);
  if (group === 'note') return noteCommand(dataDir, action, input, async () => { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); });
  if (group === 'transcript') return transcriptCommand(dataDir, action, input);
  // 恢复先于插件初始化，避免初始化数据使目标目录不再为空。
  if (group === 'restore') { const manager = await CoreManager.open(dataDir); try { return await manager.restore(string(input, 'file')!); } finally { await manager.close(); } }
  const readOnly = group === 'resource' && ['list', 'get', 'history'].includes(action) || group === 'meta' && action === 'get' || ['organization', 'org', 'organization-type'].includes(group) && ['list', 'get'].includes(action) || group === 'plugin' && action === 'list' || group === 'backup' || group === 'check' || ['get', 'get-config', 'list', 'query', 'candidates', 'material', 'history', 'providers'].includes(action) && !['resource', 'organization', 'org', 'meta', 'plugin', 'organization-type'].includes(group);
  const agentReadOnly = group === 'agent' && (action === 'status' || ['profile', 'config'].includes(action) && ['list', 'get'].includes(words[2]));
  const application = await openApplication(dataDir, { readOnly: readOnly || agentReadOnly || group === 'project-track' && ['list', 'get', 'documents', 'read', 'query'].includes(action) }); const { manager, plugins } = application;
  let changed = false; let result: unknown;
  try {
    if (group === 'resource') {
      const id = () => string(input, 'id')!;
      switch (action) {
        case 'import': result = await manager.importResource(string(input, 'file')!, { copy: flag(input, 'copy'), source: string(input, 'source', false), originalName: string(input, 'originalName', false) }); changed = !(result as { duplicate: boolean }).duplicate; break;
        case 'list': result = await manager.listResources({ text: string(input, 'text', false), ids: array(input, 'ids'), includeDeleted: flag(input, 'includeDeleted'), offset: number(input, 'offset'), limit: number(input, 'limit') } as ResourceQuery); break;
        case 'get': { const resource = await manager.getResource(id()); result = flag(input, 'content') ? { resource, content: (await manager.readContent(resource.id, number(input, 'version'))).toString('utf8') } : resource; break; }
        case 'update': result = await manager.updateResource(id(), string(input, 'file')!, number(input, 'expectedContentVersion')); changed = true; break;
        case 'delete': result = await manager.deleteResource(id()); changed = true; break;
        case 'restore': result = await manager.restoreResource(id()); changed = true; break;
        case 'purge': await manager.purgeResource(id()); result = { purged: true, id: id() }; changed = true; break;
        case 'history': { const resource = await manager.getResource(id()); result = { id: resource.id, contentVersion: resource.contentVersion, history: resource.history }; break; }
        default: argumentError('未知resource操作');
      }
    } else if (group === 'meta') {
      if (action === 'get') result = await manager.getResource(string(input, 'id')!);
      else if (action === 'set') { result = await manager.updatePluginMeta(string(input, 'id')!, string(input, 'pluginId')!, object(input, 'data'), { schemaVersion: number(input, 'schemaVersion'), expectedRevision: number(input, 'expectedRevision'), expectedContentVersion: number(input, 'expectedContentVersion'), references: input.references as ResourceReference[] | undefined }); changed = true; }
      else argumentError('未知meta操作');
    } else if (group === 'organization' || group === 'org') {
      switch (action) {
        case 'create': result = await manager.createOrganization({ type: string(input, 'type')!, name: string(input, 'name')!, data: object(input, 'data'), references: input.references as ResourceReference[] | undefined, pluginId: string(input, 'pluginId', false) }); changed = true; break;
        case 'list': result = await manager.listOrganizations(string(input, 'type', false)); break;
        case 'get': result = await manager.getOrganization(string(input, 'id')!); break;
        case 'update': { const patch: { name?: string; data?: JsonObject; references?: ResourceReference[] } = {}; if (input.name !== undefined) patch.name = string(input, 'name'); if (input.data !== undefined) patch.data = object(input, 'data'); if (input.references !== undefined) patch.references = input.references as ResourceReference[]; result = await manager.updateOrganization(string(input, 'id')!, patch, number(input, 'expectedRevision')); changed = true; break; }
        case 'delete': await manager.deleteOrganization(string(input, 'id')!); result = { deleted: true }; changed = true; break;
        default: argumentError('未知organization操作');
      }
    } else if (group === 'organization-type') {
      switch (action) {
        case 'register': result = await manager.registerOrganizationType({ id: string(input, 'id')!, name: string(input, 'name')!, description: string(input, 'description', false), handlerPluginId: string(input, 'handlerPluginId', false), config: object(input, 'config'), ...(input.enabled !== undefined ? { enabled: boolean(input, 'enabled') } : {}) }); break;
        case 'list': result = await manager.listOrganizationTypes(); break;
        case 'get': result = await manager.getOrganizationType(string(input, 'id')!); break;
        case 'update': { const patch: OrganizationTypePatch = {}; if (input.name !== undefined) patch.name = string(input, 'name'); if (input.description !== undefined) patch.description = typeof input.description === 'string' ? input.description : argumentError('description必须为字符串'); if (input.config !== undefined) patch.config = object(input, 'config'); if (input.enabled !== undefined) patch.enabled = boolean(input, 'enabled'); result = await manager.updateOrganizationType(string(input, 'id')!, patch, number(input, 'expectedRevision')); break; }
        case 'enable': case 'disable': result = await manager.updateOrganizationType(string(input, 'id')!, { enabled: action === 'enable' }, number(input, 'expectedRevision')); break;
        case 'delete': await manager.deleteOrganizationType(string(input, 'id')!); result = { deleted: true }; break;
        default: argumentError('未知organization-type操作');
      }
    } else if (group === 'plugin') {
      if (action === 'list') result = plugins.list();
      else if (action === 'enable' || action === 'disable') result = await plugins.setEnabled(string(input, 'id')!, action === 'enable', flag(input, 'cascade'));
      else if (action === 'refresh') result = await plugins.refresh();
      else argumentError('未知plugin操作');
    } else if (group === 'backup') result = await manager.backup(string(input, 'file')!);
    else if (group === 'check') { result = await manager.check(); if (!(result as { valid: boolean }).valid) process.exitCode = 1; }
    else if (group === 'reindex') result = await manager.reindex();
    else { const names = plugins.commandNames().sort((a, b) => b.split(' ').length - a.split(' ').length); const name = names.find(candidate => words.slice(0, candidate.split(' ').length).join(' ') === candidate); if (!name) argumentError(`未知命令 ${words.join(' ')}`); result = await plugins.execute(name, input, words.slice(name.split(' ').length)); changed = group === 'tag' && ['create', 'update', 'delete', 'clear', 'decide'].includes(action); }
    if (changed) await plugins.refresh();
    return result;
  } finally { await application.close(); }
}
try { const data = await run(); process.stdout.write(JSON.stringify({ ok: true, data }) + '\n'); }
catch (error) { const known = error instanceof KnowledgeError; process.exitCode = known ? error.exitCode : 1; const output = { ok: false, error: { code: known ? error.code : 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), ...(known && error.details !== undefined ? { details: error.details } : {}) } }; process.stdout.write(JSON.stringify(output) + '\n'); }
