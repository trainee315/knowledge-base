import { createHash } from 'node:crypto';
import type { AgentProfile, AgentProfileInput } from './types.js';
import { AgentError, agentAssert } from './errors.js';

export const DEFAULT_PROFILE_ID = 'deepseek-default'; // 显式generate未指定profile时使用的唯一默认配置。
export const DEFAULT_TIMEOUT_MS = 30_000; // 总时限覆盖排队与网络。
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 32_768; // 首版客户端安全上限，不沿用供应商的大额默认输出。
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_REFERENCE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FIELDS = new Set(['id', 'providerId', 'model', 'credentialEnv', 'timeoutMs', 'maxTokens', 'temperature', 'reasoning', 'reasoningEffort', 'expectedRevision']);
export function defaultProfiles(): AgentProfile[] { return [{ id: DEFAULT_PROFILE_ID, revision: 1, providerId: 'deepseek', model: 'deepseek-flash', credentialEnv: 'DEEPSEEK_API_KEY', timeoutMs: DEFAULT_TIMEOUT_MS, maxTokens: 1024, temperature: 0, reasoning: 'off' }]; }
export function validateGenerationOptions(value: { timeoutMs?: unknown; maxTokens?: unknown; temperature?: unknown; reasoning?: unknown }): void {
  agentAssert(value.timeoutMs === undefined || Number.isSafeInteger(value.timeoutMs) && Number(value.timeoutMs) >= 1 && Number(value.timeoutMs) <= MAX_TIMEOUT_MS, 'AGENT_INVALID_INPUT');
  agentAssert(value.maxTokens === undefined || Number.isSafeInteger(value.maxTokens) && Number(value.maxTokens) >= 1 && Number(value.maxTokens) <= MAX_OUTPUT_TOKENS, 'AGENT_INVALID_INPUT');
  agentAssert(value.temperature === undefined || typeof value.temperature === 'number' && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2, 'AGENT_INVALID_INPUT');
  agentAssert(value.reasoning === undefined || value.reasoning === 'off' || value.reasoning === 'on', 'AGENT_INVALID_INPUT');
}
export function validateProfile(value: AgentProfile): void {
  agentAssert(value && typeof value === 'object' && !Array.isArray(value), 'AGENT_INVALID_INPUT');
  agentAssert(Object.keys(value).every(key => FIELDS.has(key) && key !== 'expectedRevision' || key === 'revision'), 'AGENT_INVALID_INPUT');
  agentAssert(typeof value.id === 'string' && ID.test(value.id) && typeof value.providerId === 'string' && ID.test(value.providerId) && typeof value.model === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.model) && typeof value.credentialEnv === 'string' && (value.providerId === 'codex-cli' ? value.credentialEnv === '' : ENVIRONMENT_REFERENCE.test(value.credentialEnv)) && Number.isSafeInteger(value.revision) && value.revision >= 1, 'AGENT_INVALID_INPUT');
  agentAssert(value.reasoningEffort === undefined || ['low', 'medium', 'high'].includes(value.reasoningEffort), 'AGENT_INVALID_INPUT');
  agentAssert(value.providerId !== 'codex-cli' || value.temperature === 0 && value.reasoning === 'off', 'AGENT_UNSUPPORTED_OPTION');
  validateGenerationOptions(value);
  agentAssert(value.timeoutMs !== undefined && value.maxTokens !== undefined && value.temperature !== undefined && value.reasoning !== undefined, 'AGENT_INVALID_INPUT');
}
/** 只挑选允许字段，未知键立即拒绝，防止秘密进入PluginStore和备份。 */
export function mergeProfile(input: AgentProfileInput, previous?: AgentProfile): AgentProfile {
  agentAssert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => FIELDS.has(key)), 'AGENT_INVALID_INPUT');
  agentAssert(input.expectedRevision === undefined || Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 1, 'AGENT_INVALID_INPUT');
  validateGenerationOptions(input);
  agentAssert(input.reasoningEffort === undefined || ['low', 'medium', 'high'].includes(input.reasoningEffort), 'AGENT_INVALID_INPUT');
  agentAssert(['providerId', 'model', 'credentialEnv'].every(key => !Object.hasOwn(input, key) || typeof input[key as keyof AgentProfileInput] === 'string'), 'AGENT_INVALID_INPUT');
  if (input.expectedRevision !== undefined && previous?.revision !== input.expectedRevision) throw new AgentError('AGENT_PROFILE_CONFLICT');
  const defaults = previous ?? defaultProfiles()[0];
  const result: AgentProfile = { id: input.id, revision: previous ? previous.revision + 1 : 1, providerId: input.providerId ?? defaults.providerId, model: input.model ?? defaults.model, credentialEnv: (input.providerId ?? defaults.providerId) === 'codex-cli' ? input.credentialEnv ?? '' : input.credentialEnv ?? (defaults.credentialEnv || 'DEEPSEEK_API_KEY'), timeoutMs: input.timeoutMs ?? defaults.timeoutMs, maxTokens: input.maxTokens ?? defaults.maxTokens, temperature: input.temperature ?? defaults.temperature, reasoning: input.reasoning ?? defaults.reasoning, ...((input.reasoningEffort ?? defaults.reasoningEffort) ? { reasoningEffort: input.reasoningEffort ?? defaults.reasoningEffort } : {}) };
  validateProfile(result); return result;
}
export function profileHash(profile: AgentProfile, providerVersion: string): string {
  // 仅生成语义影响缓存身份；凭证引用、profile修订、超时和调度不使评分失效。
  return createHash('sha256').update(JSON.stringify({ providerId: profile.providerId, providerVersion, model: profile.model, temperature: profile.temperature, maxTokens: profile.maxTokens, reasoning: profile.reasoning, ...(profile.providerId === 'codex-cli' ? { reasoningEffort: profile.reasoningEffort ?? 'low' } : {}) })).digest('hex');
}
