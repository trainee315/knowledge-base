import type { Json } from '../contracts/index.js';

export interface AgentMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** Profile只保存非秘密配置；凭证为环境变量引用，绝不序列化密钥。 */
export interface AgentProfile {
  id: string; revision: number; providerId: string; model: string; credentialEnv: string;
  timeoutMs: number; maxTokens: number; temperature: number; reasoning: 'off' | 'on';
}
export interface AgentProfileInput {
  id: string; providerId?: string; model?: string; credentialEnv?: string;
  timeoutMs?: number; maxTokens?: number; temperature?: number; reasoning?: 'off' | 'on';
  expectedRevision?: number;
}
export interface AgentUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface AgentIdentity {
  profileId: string; profileRevision: number; provider: { id: string; version: string };
  model: string; configurationHash: string;
}
export interface AgentResult<T> extends AgentIdentity {
  value: T; usage: AgentUsage; finishReason: 'stop'; requestId?: string; actualModel?: string;
}
export interface GenerateTextInput {
  profile?: string; messages: AgentMessage[]; signal?: AbortSignal;
  timeoutMs?: number; maxTokens?: number; temperature?: number; reasoning?: 'off' | 'on';
}
/** 首版受支持的JSON Schema子集；不支持的关键字必须明确报错。 */
export interface AgentJsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string; enum?: Json[]; const?: Json;
  properties?: Record<string, AgentJsonSchema>; required?: string[]; additionalProperties?: boolean;
  items?: AgentJsonSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
}
export interface GenerateObjectInput extends GenerateTextInput { schema: AgentJsonSchema }
export interface AgentStatus {
  providers: { id: string; version: string }[];
  profiles: { identity: AgentIdentity; credentialConfigured: boolean; credentialEnv: string }[];
  active: number; queued: number; requests: number; completed: number; failed: number;
}
export interface AgentApi {
  listProfiles(): AgentProfile[];
  getProfile(id?: string): AgentProfile;
  describeProfile(id?: string): AgentIdentity;
  status(): AgentStatus;
  configureProfile(input: AgentProfileInput): Promise<AgentProfile>;
  removeProfile(id: string): Promise<void>;
  generateText(input: GenerateTextInput): Promise<AgentResult<string>>;
  generateObject<T = Record<string, Json>>(input: GenerateObjectInput): Promise<AgentResult<T>>;
}
/** 适配器只接收通用请求，DeepSeek DTO不越过此边界。 */
export interface AgentProviderRequest {
  profile: AgentProfile; messages: AgentMessage[]; output: 'text' | 'object';
  maxTokens: number; temperature: number; reasoning: 'off' | 'on';
}
export interface AgentProviderResponse {
  text: string; model: string; usage: AgentUsage;
  finishReason: 'stop' | 'length' | 'content-filter' | 'unknown'; requestId?: string;
}
export interface AgentProvider {
  id: string; version: string;
  isConfigured?(credentialEnv: string): boolean;
  invoke(input: AgentProviderRequest, signal: AbortSignal): Promise<AgentProviderResponse>;
}
