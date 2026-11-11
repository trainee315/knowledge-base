export class KnowledgeError extends Error {
  constructor(public code: string, message: string, public details?: unknown, public exitCode = 1) { super(message); this.name = 'KnowledgeError'; }
}
export function assert(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new KnowledgeError(code, message, details);
}
