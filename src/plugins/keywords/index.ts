import type { PluginDefinition } from '../../contracts/index.js';
import type { ContentApi } from '../content/index.js';
import { json, manifest, required, readPluginMeta, PLUGIN_META_SCHEMA_VERSION } from '../shared.js';
import { extractKeywords, type Keyword } from './extract.js';

export interface KeywordData { inputVersion: number; processorVersion: string; items: Keyword[] }
// 分词算法升级后，与正文处理器版本一起失效旧关键词结果。
const PROCESSOR_VERSION = '1';
export interface KeywordsApi { processorVersion: string; get(id: string): Promise<KeywordData | undefined>; extract(id: string): Promise<KeywordData>; vocabulary(): Promise<string[]> }

export const keywordsPlugin: PluginDefinition = {
  manifest: { ...manifest('keywords', ['content']), organizationTypes: [{ id: 'keyword', name: '关键词', config: {} }] },
  async load(context) {
    const content = context.getDependency<ContentApi>('content');
    const api: KeywordsApi = {
      processorVersion: PROCESSOR_VERSION,
      async get(id) { return readPluginMeta<KeywordData>(await context.core.getResource(id), 'keywords'); },
      async extract(id) {
        const resource = await context.core.getResource(id);
        const current = await api.get(id);
        const version = `${PROCESSOR_VERSION}:content-${content.processorVersion}`;
        if (current?.inputVersion === resource.contentVersion && current.processorVersion === version) return current;
        const parsed = await content.extract(id);
        const result = { inputVersion: parsed.inputVersion, processorVersion: version, items: extractKeywords(parsed.text, resource.originalName) };
        const latest = await context.core.getResource(id);
        await context.core.updatePluginMeta(id, 'keywords', json(result), { schemaVersion: PLUGIN_META_SCHEMA_VERSION, expectedRevision: latest.revision, expectedContentVersion: parsed.inputVersion });
        return result;
      },
      async vocabulary() {
        const words = new Set<string>();
        for (const { resource } of await context.core.listResources()) for (const keyword of (await api.get(resource.id))?.items ?? []) words.add(keyword.value);
        return [...words].sort();
      },
    };
    context.registerCommand('keyword get', async ({ input }) => api.get(required(input, 'id')));
    context.registerCommand('keyword extract', async ({ input }) => api.extract(required(input, 'id')));
    context.registerCommand('keyword list', async () => api.vocabulary());
    return { api };
  },
};
export default keywordsPlugin;
