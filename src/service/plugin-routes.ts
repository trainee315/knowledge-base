import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentError } from '../agent/errors.js';
import { assert, KnowledgeError } from '../core/errors.js';
import { UUID_PATTERN } from '../core/schema.js';
import { CoreManager } from '../core/manager.js';
import { PluginHost } from '../core/plugins.js';
import { openApplication } from '../index.js';
import { builtinPlugins } from '../plugins/index.js';
import { previewJson } from '../preview/readonly.js';
import type { createCronService } from './cron-service.js';
import { detailDefinitions } from './plugin-detail-catalog.js';
import { hasForm, pluginConfiguration, savePluginConfig } from './plugin-detail-config.js';

export interface PluginRouteContext {
  dataDir: string;
  dispatch(words: string[], input: Record<string, unknown>): Promise<unknown>;
  cron: Awaited<ReturnType<typeof createCronService>>;
}

// 配置请求只需要标量字段，超出上限的输入由路由拒绝。
const CONFIG_BYTES_LIMIT = 32 * 1024;
const PAGE_DEFAULT = 30;
const PAGE_LIMIT = 100;
type PluginEntry = ReturnType<PluginHost['list']>[number];

function selectedPlugin(plugins: PluginHost, id: string): PluginEntry {
  const item = plugins.list().find(item => item.manifest.id === id);
  assert(item, 'NOT_FOUND', '插件不存在');
  return item;
}

function failureMessage(item: PluginEntry): string {
  if (item.failure?.pluginId !== item.manifest.id) return '依赖插件失败，请检查插件状态。';
  return item.failure.phase === 'refresh' ? '插件刷新失败，请检查 CLI 并重试。' : '插件加载失败，请检查 CLI。';
}

function canConfigure(plugins: PluginHost, id: string): boolean {
  const required = id === 'project-tracking' ? [id, 'transcripts'] : [id];
  return required.every(requiredId => {
    const item = selectedPlugin(plugins, requiredId);
    return item.enabled && item.ready && !item.failure;
  });
}

async function detail(manager: CoreManager, plugins: PluginHost, id: string, key?: string) {
  const item = selectedPlugin(plugins, id);
  const { manifest, enabled, ready, failure } = item;
  const definition = detailDefinitions.get(manifest.id)!;
  const configuration = await pluginConfiguration(manager, manifest.id, canConfigure(plugins, id), key).catch(error => {
    if (ready || error instanceof KnowledgeError && ['NOT_FOUND', 'INVALID_ARGUMENT'].includes(error.code)) throw error;
    return { kind: 'none', editable: false, message: '当前配置不可读取。' };
  });
  return {
    id: manifest.id, name: definition.name, description: definition.description, maintains: definition.maintains,
    version: manifest.version, status: !enabled ? 'disabled' : failure ? 'failed' : ready ? 'ready' : 'pending',
    enabled, ready, dependencies: manifest.dependencies,
    ...(enabled && failure ? { failure: failureMessage(item) } : {}),
    configuration,
    collections: definition.collections.map(({ id, label }) => ({ id, label })),
  };
}

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', '配置请求必须是 JSON 对象');
  return value as Record<string, unknown>;
}

async function readConfig(request: IncomingMessage, origin: string, id: string) {
  assert(request.headers.origin === origin, 'LOCAL_ONLY', '配置请求必须来自本地同源页面');
  assert(request.headers['content-type']?.split(';')[0].trim() === 'application/json', 'INVALID_ARGUMENT', '配置请求须为 application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > CONFIG_BYTES_LIMIT) {
      request.resume();
      throw new KnowledgeError('REQUEST_TOO_LARGE', '配置请求不能超过 32 KiB');
    }
    chunks.push(data);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new KnowledgeError('INVALID_ARGUMENT', '配置请求须为有效的 UTF-8 JSON'); }
  const body = object(parsed);
  assert(Object.keys(body).every(key => ['values', 'expectedConfigVersion', 'configKey'].includes(key)), 'INVALID_ARGUMENT', '配置请求包含未知字段');
  assert(typeof body.expectedConfigVersion === 'string' && /^[a-f0-9]{64}$/.test(body.expectedConfigVersion), 'INVALID_ARGUMENT', '配置版本无效');
  assert(body.configKey === undefined || typeof body.configKey === 'string' && (id === 'project-tracking' ? UUID_PATTERN : /^[a-z][a-z0-9-]{0,63}$/).test(body.configKey), 'INVALID_ARGUMENT', '配置标识无效');
  assert(id !== 'project-tracking' || body.configKey !== undefined, 'INVALID_ARGUMENT', '请选择Session实例');
  return { values: object(body.values), expected: body.expectedConfigVersion, key: body.configKey as string | undefined };
}

function pagination(url: URL) {
  const rawOffset = url.searchParams.get('offset') ?? '0';
  const rawLimit = url.searchParams.get('limit') ?? String(PAGE_DEFAULT);
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  assert(/^\d+$/.test(rawOffset) && Number.isSafeInteger(offset) && /^\d+$/.test(rawLimit) && Number.isSafeInteger(limit) && limit >= 1 && limit <= PAGE_LIMIT, 'INVALID_ARGUMENT', '分页参数无效');
  return { offset, limit };
}

function pluginError(response: ServerResponse, error: unknown): void {
  const value = error as { code?: string; message?: string } | null;
  let code = typeof value?.code === 'string' ? value.code : 'PLUGIN_DETAIL_FAILED';
  let status: number;
  let message: string;
  if (code === 'LOCAL_ONLY') { status = 403; message = '仅允许本地同源访问'; }
  else if (code === 'NOT_FOUND') { status = 404; message = value!.message ?? '未找到插件数据'; }
  else if (code === 'METHOD_NOT_ALLOWED') { status = 405; message = '此插件接口不支持该请求方式'; }
  else if (code === 'REQUEST_TOO_LARGE') { status = 413; message = '配置请求不能超过 32 KiB'; }
  else if (code === 'CONFIG_CONFLICT' || code === 'AGENT_PROFILE_CONFLICT') {
    status = 409; code = 'CONFIG_CONFLICT'; message = '配置已被修改，请核对最新配置后重试';
  } else if (['PLUGIN_UNAVAILABLE', 'PLUGIN_BLOCKED', 'WRITER_LOCKED', 'TRANSCRIPT_BUSY'].includes(code)) {
    status = 409; message = '插件配置当前不可用，请检查插件状态后重试';
  } else if (code === 'INVALID_ARGUMENT' || code === 'INVALID_RELATION_CONFIG' || code === 'AGENT_INVALID_INPUT' || code === 'AGENT_PROFILE_NOT_FOUND') {
    status = 400; message = code === 'INVALID_ARGUMENT' ? value!.message ?? '参数无效' : '配置字段值无效，请核对后重试';
  } else if (error instanceof AgentError) { status = 400; message = error.message; } else { status = 500; code = 'PLUGIN_DETAIL_FAILED'; message = '插件数据暂时无法读取或保存'; }
  previewJson(response, status, { ok: false, error: { code, message } });
}

/** 单独打开只读宿主，保留失败插件状态，详情仍能查看。 */
async function inspectPlugins<T>(context: PluginRouteContext, read: (manager: CoreManager, plugins: PluginHost) => T | Promise<T>): Promise<T> {
  const manager = await CoreManager.open(context.dataDir, { readOnly: true });
  const plugins = new PluginHost(manager, builtinPlugins);
  try {
    try { await plugins.start(); }
    catch (error) { if (!plugins.list().some(item => item.failure)) throw error; }
    return await read(manager, plugins);
  } finally { try { await plugins.stop(); } finally { await manager.close(); } }
}

function dataResult(response: ServerResponse, data: unknown): void { previewJson(response, 200, { ok: true, data }); }

export async function handlePluginRoutes(request: IncomingMessage, response: ServerResponse, url: URL, origin: string, context: PluginRouteContext): Promise<boolean> {
  if (url.pathname !== '/api/plugins' && !url.pathname.startsWith('/api/plugins/')) return false;
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  try {
    if (url.pathname === '/api/plugins') {
      assert(request.method === 'GET' || request.method === 'HEAD', 'METHOD_NOT_ALLOWED', '插件列表只支持读取');
      const data = await inspectPlugins(context, (_manager, plugins) => plugins.list().map(item => ({
        ...item.manifest, enabled: item.enabled, status: item.failure ? 'failed' : !item.enabled ? 'disabled' : item.ready ? 'ready' : 'pending',
        dataVersion: item.dataVersion, failure: item.failure ? { ...item.failure, message: failureMessage(item) } : undefined,
      })));
      previewJson(response, 200, { ok: true, data });
      return true;
    }
    // 只在显式 POST 时检测本机登录或调用模型；只读宿主不持有文件库写锁。
    const action = /^\/api\/plugins\/agent\/(check|test|profiles)$/.exec(url.pathname)?.[1];
    if (action) {
      assert(request.method === 'POST', 'METHOD_NOT_ALLOWED', '请使用 POST');
      const { values, expected, key } = await readConfig(request, origin, 'agent');
      if (action === 'profiles') {
        assert(typeof values.id === 'string' && typeof values.model === 'string' && values.model.trim().length > 0 && Object.keys(values).every(key => ['id', 'model'].includes(key)), 'INVALID_ARGUMENT', '新建配置字段无效');
        const app = await openApplication(context.dataDir);
        try {
          assert(canConfigure(app.plugins, 'agent'), 'PLUGIN_UNAVAILABLE', 'Agent 不可用');
          const profiles = await app.plugins.execute('agent profile list', {}) as { id: string }[];
          assert(!profiles.some(profile => profile.id === values.id), 'CONFIG_CONFLICT', '配置 ID 已存在');
          dataResult(response, await app.plugins.execute('agent profile set', { ...values, providerId: 'codex-cli', timeoutMs: 120000, maxTokens: 4096, temperature: 0, reasoning: 'off', reasoningEffort: 'low' }));
        } finally { await app.close(); }
      } else {
        assert(Object.keys(values).length === 0, 'INVALID_ARGUMENT', '请先保存配置再检测');
        const app = await openApplication(context.dataDir, { readOnly: true });
        try {
          assert(canConfigure(app.plugins, 'agent'), 'PLUGIN_UNAVAILABLE', 'Agent 不可用');
          const configuration = await pluginConfiguration(app.manager, 'agent', true, key);
          assert(configuration.kind === 'form' && configuration.configVersion === expected, 'CONFIG_CONFLICT', '配置已修改');
          dataResult(response, await app.plugins.execute('agent ' + action, { profile: key }));
        } finally { await app.close(); }
      }
      return true;
    }
    const match = /^\/api\/plugins\/([a-z][a-z0-9-]*)(?:\/(config)|\/data\/([a-z][a-z0-9-]*))?$/.exec(url.pathname);
    assert(match && detailDefinitions.has(match[1]), 'NOT_FOUND', '插件详情接口不存在');
    const [, id, config, collection] = match;
    let data: unknown;
    if (config && request.method === 'PATCH') {
      assert(hasForm(id), 'PLUGIN_UNAVAILABLE', '此插件配置当前不可编辑');
      const { values, expected, key } = await readConfig(request, origin, id);
      const app = await openApplication(context.dataDir);
      try {
        const configuration = await pluginConfiguration(app.manager, id, canConfigure(app.plugins, id), key);
        await savePluginConfig(app, id, configuration, expected, values);
        data = await detail(app.manager, app.plugins, id, key);
      } finally { await app.close(); }
    } else if (!config && request.method === 'GET') {
      if (collection) {
        const { offset, limit } = pagination(url);
        const definition = detailDefinitions.get(id)!.collections.find(item => item.id === collection);
        assert(definition, 'NOT_FOUND', '数据集合不存在');
        const manager = await CoreManager.open(context.dataDir, { readOnly: true });
        try { data = await definition.load(manager, context, offset, limit); }
        finally { await manager.close(); }
      } else data = await inspectPlugins(context, (manager, plugins) => detail(manager, plugins, id, url.searchParams.get('configKey') ?? undefined));
    } else throw new KnowledgeError('METHOD_NOT_ALLOWED', '不支持该请求方式');
    previewJson(response, 200, { ok: true, data });
  } catch (error) { pluginError(response, error); }
  return true;
}
