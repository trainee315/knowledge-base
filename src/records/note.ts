import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openApplication } from '../index.js';
import type { JsonObject, ResourceMeta, ResourceReference } from '../contracts/index.js';
import { decode, hash, normalize, requireValue, text, title } from './common.js';

/** 自由记录固定原件版本；请求账本独立于资源删除状态。 */
export async function noteCommand(dataDir: string, action: string, input: Record<string, unknown>, readStdin: () => Promise<Buffer>) {
  const app = await openApplication(dataDir, { readOnly: action !== 'add' });
  try {
    const { manager } = app;
    if (action === 'list') return (await manager.listResources({ includeDeleted: input.includeDeleted === true || input.includeDeleted === 'true' })).filter(item => item.resource.plugins.notes).map(item => item.resource);
    if (action === 'get') { const resource = await manager.getResource(text(input.id, 'id')); requireValue(resource.plugins.notes, '不是自由记录'); return { resource, content: decode(await manager.readContent(resource.id, 1)) }; }
    requireValue(action === 'add', '未知 note 操作');
    requireValue([input.text !== undefined, input.file !== undefined, input.stdin === true || input.stdin === 'true'].filter(Boolean).length === 1, 'text/file/stdin 必须三选一');
    requireValue(!(input.stdin && input.input === '-'), '不能重复消费 stdin');
    const bytes = input.file !== undefined ? await fs.readFile(path.resolve(text(input.file, 'file'))) : input.text !== undefined ? Buffer.from(text(input.text, 'text')) : await readStdin();
    const body = decode(bytes); requireValue(body.trim(), '正文不能为空');
    const name = input.title === undefined ? title(body) : text(input.title, 'title');
    const tags = input.tags === undefined ? [] : Array.isArray(input.tags) ? input.tags : [input.tags];
    requireValue(tags.every(item => typeof item === 'string' && item.trim()), 'tags 必须字符串数组');
    const requestId = input.requestId === undefined ? undefined : text(input.requestId, 'requestId');
    const source = input.source === undefined ? undefined : text(input.source, 'source');
    const projectDir = input.projectDir === undefined ? undefined : path.resolve(text(input.projectDir, 'projectDir'));
    const recordedAt = input.recordedAt === undefined ? undefined : text(input.recordedAt, 'recordedAt');
    requireValue(!recordedAt || /(?:Z|[+-]\d\d:\d\d)$/.test(recordedAt) && Number.isFinite(Date.parse(recordedAt)), 'recordedAt 须为带时区 ISO 时间');
    const fingerprint = hash(JSON.stringify({ body: hash(bytes), title: name, source, projectDir, tags, recordedAt }));
    const store = manager.pluginStore('records');
    const key = requestId ? 'note-' + hash(requestId) : undefined;
    const previous = key ? await store.read<{ fingerprint: string; resourceId: string } | null>(key, null) : null;
    if (previous) { requireValue(previous.fingerprint === fingerprint, 'requestId 参数冲突', 'REQUEST_CONFLICT'); return { resourceId: previous.resourceId, replayed: true }; }
    const decisions: JsonObject[] = []; const references: ResourceReference[] = [];
    const allTags = await manager.listOrganizations('tag');
    for (const name of tags as string[]) {
      const tag = allTags.find(item => item.id === name || [item.name, ...(item.data.aliases as string[] ?? [])].some(value => normalize(value) === normalize(name)));
      requireValue(tag, `标签不存在：${name}`);
      if (references.some(ref => ref.id === tag.id)) continue;
      references.push({ kind: 'organization', id: tag.id, owner: 'tags' });
      decisions.push({ tagId: tag.id, accepted: true, source: 'manual', reason: '自由记录显式标签', contentVersion: 1, tagRevision: tag.revision, at: new Date().toISOString() });
    }
    const id = randomUUID();
    const plugins: ResourceMeta['plugins'] = { notes: { schemaVersion: 1, data: { recordedAt: recordedAt ?? new Date().toISOString(), ...(projectDir ? { projectDir } : {}), ...(requestId ? { requestId } : {}) } }, tags: { schemaVersion: 1, data: { decisions } } };
    const resource = await manager.appendRecord({ id, content: bytes, title: name, source, plugins, references, ...(key ? { state: { key, value: { fingerprint, resourceId: id } } } : {}) });
    await app.plugins.refresh();
    return { resourceId: resource.id, resource, replayed: false };
  } finally { await app.close(); }
}
