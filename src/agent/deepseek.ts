import type { AgentProvider, AgentProviderRequest, AgentProviderResponse } from './types.js';
import { AgentError, agentAssert } from './errors.js';

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions'; // 官方非流式文本接口，唯一生产默认。
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 有界读取，避免错误/无限响应耗尽内存。
export interface DeepSeekProviderOptions {
  fetch?: typeof fetch; endpoint?: string;
  resolveCredential?(environmentName: string): string | undefined;
}
/** 供应商DTO仅存在此文件；不向上暴露响应正文、reasoning或认证头。 */
export class DeepSeekProvider implements AgentProvider {
  readonly id = 'deepseek';
  readonly version = '1.0.0';
  private readonly transport: typeof fetch;
  private readonly endpoint: string;
  private readonly credential: (name: string) => string | undefined;
  constructor(options: DeepSeekProviderOptions = {}) {
    this.transport = options.fetch ?? fetch; this.credential = options.resolveCredential ?? (name => process.env[name]);
    let url: URL; try { url = new URL(options.endpoint ?? DEFAULT_ENDPOINT); } catch { throw new AgentError('AGENT_INVALID_INPUT'); }
    agentAssert(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 'AGENT_INVALID_INPUT');
    if (!url.pathname.replace(/\/$/, '').endsWith('/chat/completions')) url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
    this.endpoint = url.href;
  }
  isConfigured(name: string): boolean { try { return Boolean(this.credential(name)?.trim()); } catch { return false; } }
  async invoke(input: AgentProviderRequest, signal: AbortSignal): Promise<AgentProviderResponse> {
    let key: string | undefined; try { key = this.credential(input.profile.credentialEnv)?.trim(); } catch { throw new AgentError('AGENT_CREDENTIAL_MISSING'); }
    if (!key) throw new AgentError('AGENT_CREDENTIAL_MISSING');
    const body = { model: input.profile.model, messages: input.messages, stream: false, max_tokens: input.maxTokens, temperature: input.temperature, thinking: { type: input.reasoning === 'on' ? 'enabled' : 'disabled' }, ...(input.output === 'object' ? { response_format: { type: 'json_object' } } : {}) };
    let response: Response;
    try { response = await this.transport(this.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' }); }
    catch { throw new AgentError(signal.aborted ? 'AGENT_ABORTED' : 'AGENT_PROVIDER_UNAVAILABLE'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const code = [401, 403].includes(response.status) ? 'AGENT_AUTH_FAILED' : response.status === 429 ? 'AGENT_RATE_LIMITED' : response.status >= 500 ? 'AGENT_PROVIDER_UNAVAILABLE' : 'AGENT_PROVIDER_ERROR';
      throw new AgentError(code, { status: response.status });
    }
    let raw = ''; let length = 0;
    try {
      if (!response.body) throw new AgentError('AGENT_INVALID_RESPONSE');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const chunk of response.body) { length += chunk.byteLength; if (length > MAX_RESPONSE_BYTES) { await response.body.cancel().catch(() => {}); throw new AgentError('AGENT_INVALID_RESPONSE'); } raw += decoder.decode(chunk, { stream: true }); }
      raw += decoder.decode();
    } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError(signal.aborted ? 'AGENT_ABORTED' : 'AGENT_INVALID_RESPONSE'); }
    let payload: any; try { payload = JSON.parse(raw); } catch { throw new AgentError('AGENT_INVALID_RESPONSE'); }
    const choice = payload?.choices?.[0];
    agentAssert(Array.isArray(payload?.choices) && payload.choices.length === 1 && choice?.message?.role === 'assistant' && typeof choice.message.content === 'string' && !choice.message.tool_calls && typeof payload.model === 'string' && payload.usage, 'AGENT_INVALID_RESPONSE');
    const finishReason = choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'content_filter' ? 'content-filter' : 'unknown';
    // 不读取/返回reasoning_content或供应商其它扩展字段。
    return { text: choice.message.content, model: payload.model, finishReason, usage: { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens, totalTokens: payload.usage.total_tokens }, ...(typeof payload.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.id) ? { requestId: payload.id } : {}) };
  }
}
