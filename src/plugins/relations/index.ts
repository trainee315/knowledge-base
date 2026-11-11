import type { PluginDefinition } from '../../contracts/index.js';
import type { TagsApi, TagDefinition } from '../tags/index.js';
import type { KeywordsApi } from '../keywords/index.js';
import { manifest, required, strings } from '../shared.js';
import { lexicalProvider, type RelationScore, type ScoringProvider } from './lexical.js';

export interface ScoredRelations {
  tagId: string; tagRevision: number; provider: { id: string; version: string; kind: string };
  scores: RelationScore[]; at: string;
}
export interface RelationsApi {
  score(tagId: string, keywords: string[], signal?: AbortSignal): Promise<ScoredRelations>;
  get(tagId: string): Promise<ScoredRelations | undefined>; setProvider(provider: ScoringProvider): void;
  provider(): { id: string; version: string; kind: string };
}

export const relationsPlugin: PluginDefinition = {
  manifest: manifest('relations', ['tags', 'keywords']),
  async load(context) {
    const tags = context.getDependency<TagsApi>('tags');
    const keywords = context.getDependency<KeywordsApi>('keywords');
    let provider = lexicalProvider;
    const api: RelationsApi = {
      provider() { return { id: provider.id, version: provider.version, kind: provider.kind }; },
      setProvider(value) {
        if (!value || typeof value.id !== 'string' || !value.id.trim() || typeof value.version !== 'string' || !value.version.trim() || !['heuristic', 'model'].includes(value.kind) || typeof value.score !== 'function') throw new Error('INVALID_PROVIDER: 实现需要id/version/kind/score');
        provider = value;
      },
      async get(tagId) { return (await context.store.read<ScoredRelations | null>(tagId, null)) ?? undefined; },
      async score(tagId, words, signal) {
        if (!Array.isArray(words) || words.some(word => typeof word !== 'string' || !word.trim())) throw new Error('INVALID_INPUT: keywords必须为非空字符串数组');
        const scoringProvider = provider;
        const identity = { id: scoringProvider.id, version: scoringProvider.version, kind: scoringProvider.kind };
        const checkProvider = () => { if (provider !== scoringProvider || provider.id !== identity.id || provider.version !== identity.version || provider.kind !== identity.kind) throw new Error('STALE_PROVIDER: 评分实现已变化，丢弃旧处理器结果'); };
        const tag = await tags.get(tagId);
        const data = tag.data as unknown as TagDefinition;
        const scores = await scoringProvider.score({ name: tag.name, aliases: data.aliases, description: data.description }, [...new Set(words)], signal);
        signal?.throwIfAborted();
        checkProvider();
        if (scores.length !== new Set(words).size || scores.some(score => !words.includes(score.keyword) || !Number.isFinite(score.score) || score.score < 0 || score.score > 1) || new Set(scores.map(score => score.keyword)).size !== scores.length) throw new Error('INVALID_SCORE: provider 必须对每个关键词返回唯一的0..1分数');
        if ((await tags.get(tagId)).revision !== tag.revision) throw new Error('STALE_INPUT: 标签定义已变化');
        const previous = await api.get(tag.id);
        checkProvider();
        const merged = new Map(previous?.tagRevision === tag.revision && previous.provider.id === identity.id && previous.provider.version === identity.version && previous.provider.kind === identity.kind ? previous.scores.map(score => [score.keyword, score]) : []);
        for (const score of scores) merged.set(score.keyword, score);
        const result: ScoredRelations = { tagId: tag.id, tagRevision: tag.revision, provider: identity, scores: [...merged.values()], at: new Date().toISOString() };
        await context.store.write(tag.id, result);
        return { ...result, scores };
      },
    };
    context.registerCommand('relation get', async ({ input }) => api.get(required(input, 'id')));
    context.registerCommand('relation providers', async () => api.provider());
    context.registerCommand('relation score', async ({ input }) => api.score(required(input, 'id'), input.keywords ? strings(input.keywords) : await keywords.vocabulary()));
    return { api };
  },
};
export default relationsPlugin;
