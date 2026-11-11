import type { AgentApi, AgentIdentity, AgentProfile, AgentProfileInput, AgentProvider, AgentProviderRequest, AgentProviderResponse, AgentResult, AgentStatus, GenerateObjectInput, GenerateTextInput } from './types.js';
import { AgentError, agentAssert, type AgentErrorCode } from './errors.js';
import { defaultProfiles, DEFAULT_PROFILE_ID, mergeProfile, profileHash, validateGenerationOptions, validateProfile } from './profiles.js';
import { parseObject, validateSchema } from './schema.js';
import { KnowledgeError } from '../core/errors.js';

const DEFAULT_CONCURRENCY = 2; // 同一service最大实际在途调用，不以取消响应提前释放。
const DEFAULT_QUEUE_LIMIT = 100;
const INPUT_KEYS = new Set(['profile', 'messages', 'signal', 'timeoutMs', 'maxTokens', 'temperature', 'reasoning', 'schema']);
interface Waiter { resolve(): void; reject(error: Error): void; signal: AbortSignal; abort(): void }
export interface AgentServiceOptions {
  providers: AgentProvider[]; profiles?: AgentProfile[]; maxConcurrent?: number; maxQueue?: number;
  saveProfiles?(profiles: AgentProfile[]): Promise<void>;
}
/** 通用Agent调用协调器，独立于插件存储、业务prompt和供应商DTO。 */
export class AgentService implements AgentApi {
  private readonly providers = new Map<string, AgentProvider>();
  private profiles: AgentProfile[];
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private queue: Waiter[] = [];
  private controllers = new Set<AbortController>();
  private active = 0;
  private requests = 0;
  private completed = 0;
  private failed = 0;
  private stopped = false;
  private mutations = Promise.resolve();
  constructor(private options: AgentServiceOptions) {
    for (const provider of options.providers) { agentAssert(provider && typeof provider.id === 'string' && typeof provider.version === 'string' && typeof provider.invoke === 'function' && !this.providers.has(provider.id), 'AGENT_INVALID_INPUT'); this.providers.set(provider.id, provider); }
    this.profiles = structuredClone(options.profiles ?? defaultProfiles());
    agentAssert(Array.isArray(this.profiles) && new Set(this.profiles.map(profile => profile.id)).size === this.profiles.length, 'AGENT_INVALID_INPUT');
    for (const profile of this.profiles) validateProfile(profile);
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_CONCURRENCY; this.maxQueue = options.maxQueue ?? DEFAULT_QUEUE_LIMIT;
    agentAssert(Number.isSafeInteger(this.maxConcurrent) && this.maxConcurrent >= 1 && this.maxConcurrent <= 32 && Number.isSafeInteger(this.maxQueue) && this.maxQueue >= 0 && this.maxQueue <= 1000, 'AGENT_INVALID_INPUT');
  }
  listProfiles(): AgentProfile[] { return structuredClone(this.profiles); }
  getProfile(id = DEFAULT_PROFILE_ID): AgentProfile { const profile = this.profiles.find(item => item.id === id); if (!profile) throw new AgentError('AGENT_PROFILE_NOT_FOUND'); return structuredClone(profile); }
  describeProfile(id?: string): AgentIdentity {
    const profile = this.getProfile(id); const provider = this.providers.get(profile.providerId); if (!provider) throw new AgentError('AGENT_PROVIDER_NOT_FOUND');
    return { profileId: profile.id, profileRevision: profile.revision, provider: { id: provider.id, version: provider.version }, model: profile.model, configurationHash: profileHash(profile, provider.version) };
  }
  status(): AgentStatus {
    return { providers: [...this.providers.values()].map(provider => ({ id: provider.id, version: provider.version })), profiles: this.profiles.map(profile => { let credentialConfigured = false; try { credentialConfigured = this.providers.get(profile.providerId)?.isConfigured?.(profile.credentialEnv) ?? false; } catch { /* 凭证检查失败不能泄露provider异常或阻止离线检查。 */ } return { identity: this.describeProfile(profile.id), credentialEnv: profile.credentialEnv, credentialConfigured }; }), active: this.active, queued: this.queue.length, requests: this.requests, completed: this.completed, failed: this.failed };
  }
  private async mutate<T>(action: () => Promise<T>): Promise<T> { const result = this.mutations.then(action); this.mutations = result.then(() => {}, () => {}); return result; }
  private async saveProfiles(profiles: AgentProfile[]): Promise<void> { try { await this.options.saveProfiles?.(structuredClone(profiles)); } catch (error) { if ((error as { code?: string })?.code === 'READ_ONLY') throw new KnowledgeError('READ_ONLY', '只读会话不能保存Agent配置'); throw new AgentError('AGENT_CONFIG_WRITE_FAILED'); } }
  async configureProfile(input: AgentProfileInput): Promise<AgentProfile> {
    return this.mutate(async () => { const profile = mergeProfile(input, this.profiles.find(item => item.id === input?.id)); agentAssert(this.providers.has(profile.providerId), 'AGENT_PROVIDER_NOT_FOUND'); const next = this.profiles.filter(item => item.id !== profile.id).concat(profile).sort((a, b) => a.id.localeCompare(b.id)); await this.saveProfiles(next); this.profiles = next; return structuredClone(profile); });
  }
  async removeProfile(id: string): Promise<void> { return this.mutate(async () => { this.getProfile(id); const next = this.profiles.filter(item => item.id !== id); await this.saveProfiles(next); this.profiles = next; }); }
  async generateText(input: GenerateTextInput): Promise<AgentResult<string>> { return this.generate(input, 'text', text => text); }
  async generateObject<T = Record<string, import('../contracts/index.js').Json>>(input: GenerateObjectInput): Promise<AgentResult<T>> {
    validateSchema(input?.schema); agentAssert(input.schema.type === 'object', 'AGENT_UNSUPPORTED_SCHEMA');
    const schema = structuredClone(input.schema);
    return this.generate({ ...input, schema } as GenerateObjectInput, 'object', text => parseObject<T>(text, schema));
  }
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new AgentError('AGENT_ABORTED'));
    if (this.active < this.maxConcurrent) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new AgentError('AGENT_QUEUE_FULL'));
    return new Promise((resolve, reject) => { const waiter: Waiter = { signal, resolve, reject, abort: () => { this.queue = this.queue.filter(item => item !== waiter); reject(new AgentError('AGENT_ABORTED')); } }; this.queue.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true }); });
  }
  private release(): void {
    this.active--;
    while (this.queue.length) { const next = this.queue.shift()!; next.signal.removeEventListener('abort', next.abort); if (next.signal.aborted) { next.reject(new AgentError('AGENT_ABORTED')); continue; } this.active++; next.resolve(); break; }
  }
  private raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new AgentError('AGENT_ABORTED'));
    return new Promise((resolve, reject) => { const abort = () => reject(new AgentError('AGENT_ABORTED')); signal.addEventListener('abort', abort, { once: true }); operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); }); });
  }
  /** 捕获配置快照；排队和HTTP共用总时限，取消不让未结束adapter突破实际并发上限。 */
  private async generate<T>(input: GenerateTextInput, output: 'text' | 'object', convert: (text: string) => T): Promise<AgentResult<T>> {
    agentAssert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => INPUT_KEYS.has(key) && (output === 'object' || key !== 'schema')), 'AGENT_INVALID_INPUT');
    agentAssert(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 100 && input.messages.every(message => message && typeof message === 'object' && Object.keys(message).every(key => key === 'role' || key === 'content') && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content.trim().length > 0), 'AGENT_INVALID_INPUT');
    agentAssert(input.signal === undefined || input.signal instanceof AbortSignal, 'AGENT_INVALID_INPUT'); validateGenerationOptions(input);
    if (this.stopped) throw new AgentError('AGENT_STOPPED');
    const profile = this.getProfile(input.profile); const identity = this.describeProfile(profile.id); const provider = this.providers.get(profile.providerId)!;
    const request: AgentProviderRequest = { profile, messages: structuredClone(input.messages), output, maxTokens: input.maxTokens ?? profile.maxTokens, temperature: input.temperature ?? profile.temperature, reasoning: input.reasoning ?? profile.reasoning };
    // 覆盖项属于本次生成语义，结果hash与实际调用参数一致。
    identity.configurationHash = profileHash({ ...profile, maxTokens: request.maxTokens, temperature: request.temperature, reasoning: request.reasoning }, provider.version);
    if (output === 'object') request.messages.unshift({ role: 'system', content: `Return exactly one valid JSON object matching this JSON schema. Do not include markdown fences. JSON schema: ${JSON.stringify((input as GenerateObjectInput).schema)}` });
    const controller = new AbortController(); this.controllers.add(controller); let timedOut = false;
    const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs ?? profile.timeoutMs);
    try {
      await this.acquire(controller.signal);
      if (controller.signal.aborted) { this.release(); throw new AgentError('AGENT_ABORTED'); }
      this.requests++;
      const operation = Promise.resolve().then(() => provider.invoke(request, controller.signal));
      void operation.finally(() => this.release()).catch(() => {});
      const result = await this.raceAbort(operation, controller.signal);
      if (controller.signal.aborted) throw new AgentError('AGENT_ABORTED');
      this.validateResponse(result);
      if (result.finishReason === 'length') throw new AgentError('AGENT_TRUNCATED');
      if (result.finishReason !== 'stop') throw new AgentError('AGENT_INVALID_RESPONSE');
      if (!result.text.trim()) throw new AgentError('AGENT_EMPTY_OUTPUT');
      const value = convert(result.text); this.completed++;
      return { ...identity, actualModel: result.model, value, usage: result.usage, finishReason: 'stop', ...(result.requestId ? { requestId: result.requestId } : {}) };
    } catch (error) { this.failed++; if (timedOut) throw new AgentError('AGENT_TIMEOUT'); if (controller.signal.aborted) throw new AgentError(this.stopped ? 'AGENT_STOPPED' : 'AGENT_ABORTED'); if (error instanceof AgentError) throw new AgentError(error.code as AgentErrorCode, error.details as { status?: number }); throw new AgentError('AGENT_PROVIDER_ERROR'); }
    finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }
  private validateResponse(value: AgentProviderResponse): void {
    agentAssert(value && typeof value === 'object' && typeof value.text === 'string' && typeof value.model === 'string' && value.model.length > 0 && value.usage && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(value.usage[key as keyof typeof value.usage]) && value.usage[key as keyof typeof value.usage] >= 0), 'AGENT_INVALID_RESPONSE');
    agentAssert(value.usage.totalTokens === value.usage.inputTokens + value.usage.outputTokens, 'AGENT_INVALID_RESPONSE');
  }
  stop(): void { this.stopped = true; for (const controller of this.controllers) controller.abort(); }
}
