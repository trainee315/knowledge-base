import type { PluginDefinition } from '../../contracts/index.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KnowledgeError } from '../../core/errors.js';
import { json, manifest, required, readPluginMeta, PLUGIN_META_SCHEMA_VERSION } from '../shared.js';
import { extractContent, type ExtractedContent } from './extract.js';

export interface ContentData extends ExtractedContent {
  inputVersion: number; processorVersion: string;
  referenceStatus: 'none' | 'valid' | 'broken'; diagnostics: string[];
}
// 更改提取算法时提升此版本，使旧派生内容重新计算。
const PROCESSOR_VERSION = '2';
/** 固定原件版本的只读派生；历史文件名缺失时明确使用中性名称。 */
export interface ContentVersionData extends ExtractedContent {
  resourceId: string; contentVersion: number; contentHash: string; extension: string;
  parserVersion: string; originalNameKnown: boolean; rawText: string | null;
}
export interface ContentApi {
  processorVersion: string;
  get(id: string): Promise<ContentData | undefined>;
  extract(id: string): Promise<ContentData>;
  readVersion(id: string, contentVersion: number): Promise<ContentVersionData>;
}

export const contentPlugin: PluginDefinition = {
  manifest: manifest('content'),
  async load(context) {
    const api: ContentApi = {
      processorVersion: PROCESSOR_VERSION,
      async get(id) { return readPluginMeta<ContentData>(await context.core.getResource(id), 'content'); },
      async readVersion(id, contentVersion) {
        if (!Number.isSafeInteger(contentVersion) || contentVersion < 1) throw new KnowledgeError('INVALID_ARGUMENT', 'contentVersion必须为正整数', undefined, 2);
        const resource = await context.core.getResource(id);
        readPluginMeta<ContentData>(resource, 'content');
        const current = contentVersion === resource.contentVersion;
        const selected = current ? resource : resource.history.find(item => item.contentVersion === contentVersion);
        if (!selected) throw new KnowledgeError('NOT_FOUND', `资源版本不存在: ${id}@${contentVersion}`);
        // 历史格式以固定原件路径为准，不能借用最新名称或meta解释旧内容。
        const extension = path.extname(selected.file).toLowerCase();
        const filename = current ? resource.originalName : `version-${contentVersion}${extension}`;
        const bytes = await context.core.readContent(id, contentVersion);
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        if (contentHash !== selected.hash) throw new KnowledgeError('CONTENT_HASH_MISMATCH', '固定版本原件与记录hash不一致', { id, contentVersion });
        const extracted = extractContent(`version-${contentVersion}${extension}`, bytes);
        let rawText: string | null = null;
        try { rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { /* 二进制或损坏UTF8没有可信原文。 */ }
        return { ...extracted, filename, resourceId: id, contentVersion, contentHash, extension, parserVersion: PROCESSOR_VERSION, originalNameKnown: current, rawText };
      },
      async extract(id) {
        const resource = await context.core.getResource(id);
        const current = readPluginMeta<ContentData>(resource, 'content');
        if (current?.inputVersion === resource.contentVersion && current.processorVersion === PROCESSOR_VERSION) return current;
        const extracted = extractContent(resource.originalName, await context.core.readContent(id));
        const validIds = new Set<string>();
        const diagnostics: string[] = [];
        for (const reference of extracted.markdownReferences) {
          if (!reference.resourceId) { diagnostics.push(`BROKEN_RESOURCE_REFERENCE: 非法资源URI ${reference.uri}`); continue; }
          try { await context.core.getResource(reference.resourceId); validIds.add(reference.resourceId); }
          catch { diagnostics.push(`BROKEN_RESOURCE_REFERENCE: 目标不存在或不可读取 ${reference.uri}`); }
        }
        const result: ContentData = { ...extracted, inputVersion: resource.contentVersion, processorVersion: PROCESSOR_VERSION, referenceStatus: diagnostics.length ? 'broken' : validIds.size ? 'valid' : 'none', diagnostics };
        await context.core.updatePluginMeta(id, 'content', json(result), { schemaVersion: PLUGIN_META_SCHEMA_VERSION, expectedRevision: resource.revision, expectedContentVersion: resource.contentVersion, references: [...validIds].map(id => ({ kind: 'resource', id })) });
        return result;
      },
    };
    context.registerCommand('content get', async ({ input }) => api.get(required(input, 'id')));
    context.registerCommand('content extract', async ({ input }) => api.extract(required(input, 'id')));
    return { api, async refresh(events) {
      // 入库/内容更新优先登记引用，防止正文任务积压期间误清理链接目标。
      const changed = new Set(events.filter(event => ['resource.imported', 'resource.updated', 'resource.restored'].includes(event.type)).map(event => event.entityId));
      for (const id of changed) {
        try { const resource = await context.core.getResource(id); if (!resource.deletedAt) await api.extract(id); }
        catch (error) {
          // 同一事件批次内资源可能已彻底清理，其余解析/写入错误仍须报告。
          if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
        }
      }
    } };
  },
};
export default contentPlugin;
