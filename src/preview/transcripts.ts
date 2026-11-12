import type { IncomingMessage, ServerResponse } from 'node:http';
import { openApplication } from '../index.js';
import { configuration } from '../records/config.js';
import { requireValue } from '../records/common.js';
import { transcriptCommand, transcriptDetail, transcriptDraftPreview } from '../records/transcript.js';
import type { Organization } from '../contracts/index.js';
import { previewError, previewJson } from './readonly.js';

const BODY_LIMIT = 128 * 1024; // 配置请求上限，避免无限读取请求体。
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  requireValue(request.headers['content-type']?.split(';')[0].trim() === 'application/json', '请求须为 application/json');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > BODY_LIMIT) request.resume();
    requireValue(length <= BODY_LIMIT, '配置请求超过128KiB');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    requireValue(value && typeof value === 'object' && !Array.isArray(value), '请求体须为 JSON 对象');
    return value;
  } catch { requireValue(false, '请求体须为有效 UTF-8 JSON 对象'); }
}
/** 开发和构建预览共用，仅显式配置请求打开短写会话。 */
export async function handleTranscripts(request: IncomingMessage, response: ServerResponse, url: URL, dataDir: string, origin: string): Promise<boolean> {
  if (!url.pathname.startsWith('/api/transcripts')) return false;
  try {
    const idMatch = /^\/api\/transcripts\/([^/]+)$/.exec(url.pathname);
    const id = idMatch?.[1];
    const method = request.method;
    if (method === 'GET') {
      const app = await openApplication(dataDir, { readOnly: true });
      try {
        requireValue(app.plugins.list().some(plugin => plugin.manifest.id === 'transcripts' && plugin.ready), '转录插件不可用', 'PLUGIN_UNAVAILABLE');
        let data;
        if (url.pathname === '/api/transcripts/profiles') {
          const status = await app.plugins.execute('agent status', {}) as { profiles: { identity: { profileId: string; model: string }; credentialConfigured: boolean }[] };
          data = status.profiles.map(profile => ({ id: profile.identity.profileId, model: profile.identity.model, credentialConfigured: profile.credentialConfigured }));
        } else if (url.pathname === '/api/transcripts/defaults') {
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
          data = configuration({ alias: '新实例', startDate: today });
        } else if (url.pathname === '/api/transcripts') data = (await app.manager.listOrganizations('session-transcript')).map(transcriptDetail);
        else {
          requireValue(id && UUID.test(id), '实例 ID 无效');
          data = transcriptDetail(await app.manager.getOrganization(id));
        }
        previewJson(response, 200, { ok: true, data });
      } finally { await app.close(); }
      return true;
    }
    if (!['POST', 'PATCH'].includes(method ?? '')) { previewJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '配置接口不支持此方法' } }); return true; }
    requireValue(request.headers.origin === origin, '配置请求必须来自本地同源页面', 'LOCAL_ONLY');
    const input = await body(request);
    if (url.pathname === '/api/transcripts/preview' && method === 'POST') {
      requireValue(Object.keys(input).every(key => ['id', 'config', 'mode', 'from', 'to'].includes(key)), '未知预览字段');
      if (input.id !== undefined) requireValue(typeof input.id === 'string' && UUID.test(input.id), '实例 ID 无效');
      previewJson(response, 200, { ok: true, data: await transcriptDraftPreview(dataDir, input as Parameters<typeof transcriptDraftPreview>[1]) });
      return true;
    }
    requireValue(input.config && typeof input.config === 'object' && !Array.isArray(input.config), 'config 必须对象');
    requireValue(Object.keys(input).every(key => ['config', 'expectedRevision'].includes(key)), '未知保存字段');
    let org: Organization;
    if (url.pathname === '/api/transcripts' && method === 'POST') {
      org = await transcriptCommand(dataDir, 'create', input.config) as Organization;
    } else {
      requireValue(method === 'PATCH' && id && UUID.test(id), '配置保存路径或方法无效');
      requireValue(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, '保存须提供 expectedRevision');
      org = await transcriptCommand(dataDir, 'configure', { ...input.config, id, expectedRevision: input.expectedRevision }) as Organization;
    }
    previewJson(response, 200, { ok: true, data: transcriptDetail(org) });
    return true;
  } catch (error) { previewError(response, error); return true; }
}
