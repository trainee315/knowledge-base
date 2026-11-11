import { KnowledgeError } from '../core/errors.js';

// 错误只暴露固定文案和安全状态；不保留provider正文、prompt、凭证或原始cause。
const MESSAGES = {
  AGENT_INVALID_INPUT: 'Agent输入或配置无效', AGENT_PROFILE_NOT_FOUND: 'Agent profile不存在',
  AGENT_PROVIDER_NOT_FOUND: 'Agent provider不可用', AGENT_PROFILE_CONFLICT: 'Agent profile版本已变化',
  AGENT_CREDENTIAL_MISSING: 'Agent凭证未配置', AGENT_AUTH_FAILED: 'Agent认证失败',
  AGENT_RATE_LIMITED: 'Agent服务限流', AGENT_PROVIDER_UNAVAILABLE: 'Agent服务暂不可用',
  AGENT_PROVIDER_ERROR: 'Agent请求失败', AGENT_INVALID_RESPONSE: 'Agent响应结构无效',
  AGENT_EMPTY_OUTPUT: 'Agent返回空白内容', AGENT_TRUNCATED: 'Agent输出被截断',
  AGENT_INVALID_JSON: 'Agent输出不是合法JSON', AGENT_SCHEMA_MISMATCH: 'Agent输出不符合schema',
  AGENT_UNSUPPORTED_SCHEMA: 'Agent schema包含不支持或无效的规则',
  AGENT_ABORTED: 'Agent调用已取消', AGENT_TIMEOUT: 'Agent调用超时',
  AGENT_QUEUE_FULL: 'Agent调用队列已满', AGENT_STOPPED: 'Agent服务已停止',
  AGENT_CONFIG_WRITE_FAILED: 'Agent配置保存失败',
} as const;
export type AgentErrorCode = keyof typeof MESSAGES;
export class AgentError extends KnowledgeError {
  constructor(code: AgentErrorCode, details?: { status?: number }) {
    const safeCode: AgentErrorCode = Object.hasOwn(MESSAGES, code) ? code : 'AGENT_PROVIDER_ERROR';
    const safeDetails = Number.isInteger(details?.status) && details!.status! >= 100 && details!.status! <= 599 ? { status: details!.status } : undefined;
    super(safeCode, MESSAGES[safeCode], safeDetails, safeCode === 'AGENT_INVALID_INPUT' || safeCode === 'AGENT_UNSUPPORTED_SCHEMA' ? 2 : 1);
  }
}
export function agentAssert(condition: unknown, code: AgentErrorCode): asserts condition { if (!condition) throw new AgentError(code); }
