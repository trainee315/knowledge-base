import { isDeepStrictEqual } from 'node:util';
import type { AgentJsonSchema } from './types.js';
import { AgentError, agentAssert } from './errors.js';

const MAX_SCHEMA_DEPTH = 20; // 限制递归复杂度，避免结构化输入耗尽栈。
const KEYS = new Set(['type', 'description', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'minLength', 'maxLength']);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function jsonLiteral(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || !value || depth > MAX_SCHEMA_DEPTH || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value); const valid = Object.values(value).every(item => jsonLiteral(item, seen, depth + 1)); seen.delete(value); return valid;
}
/** 校验schema本身，在任何网络调用前拒绝未知/不适用的规则。 */
export function validateSchema(schema: AgentJsonSchema, depth = 0): void {
  agentAssert(depth <= MAX_SCHEMA_DEPTH && isObject(schema) && Object.keys(schema).every(key => KEYS.has(key)), 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(schema.description === undefined || typeof schema.description === 'string', 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(schema.enum === undefined || Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(item => jsonLiteral(item)), 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(!Object.hasOwn(schema, 'const') || jsonLiteral(schema.const), 'AGENT_UNSUPPORTED_SCHEMA');
  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    agentAssert(schema.type === 'object' && (schema.properties === undefined || isObject(schema.properties)) && (schema.required === undefined || Array.isArray(schema.required) && schema.required.every(key => typeof key === 'string') && new Set(schema.required).size === schema.required.length) && (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean'), 'AGENT_UNSUPPORTED_SCHEMA');
    for (const value of Object.values(schema.properties ?? {})) validateSchema(value, depth + 1);
    agentAssert((schema.required ?? []).every(key => Object.hasOwn(schema.properties ?? {}, key)), 'AGENT_UNSUPPORTED_SCHEMA');
  }
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) if (schema[key] !== undefined) agentAssert(Number.isSafeInteger(schema[key]) && schema[key]! >= 0 && (key.endsWith('Items') ? schema.type === 'array' : schema.type === 'string'), 'AGENT_UNSUPPORTED_SCHEMA');
  for (const key of ['minimum', 'maximum'] as const) if (schema[key] !== undefined) agentAssert(Number.isFinite(schema[key]) && ['number', 'integer'].includes(schema.type), 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(schema.minItems === undefined || schema.maxItems === undefined || schema.minItems <= schema.maxItems, 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(schema.minLength === undefined || schema.maxLength === undefined || schema.minLength <= schema.maxLength, 'AGENT_UNSUPPORTED_SCHEMA');
  agentAssert(schema.minimum === undefined || schema.maximum === undefined || schema.minimum <= schema.maximum, 'AGENT_UNSUPPORTED_SCHEMA');
  if (schema.items !== undefined) { agentAssert(schema.type === 'array', 'AGENT_UNSUPPORTED_SCHEMA'); validateSchema(schema.items, depth + 1); }
  agentAssert(schema.uniqueItems === undefined || schema.type === 'array' && typeof schema.uniqueItems === 'boolean', 'AGENT_UNSUPPORTED_SCHEMA');
}
/** 通用结构约束；业务语义和词对覆盖等仍由调用方检查。 */
export function matchesSchema(value: unknown, schema: AgentJsonSchema): boolean {
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value)) || Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) return false;
  switch (schema.type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string' && (schema.minLength === undefined || [...value].length >= schema.minLength) && (schema.maxLength === undefined || [...value].length <= schema.maxLength);
    case 'integer': if (!Number.isSafeInteger(value)) return false;
    case 'number': return typeof value === 'number' && Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    case 'array': return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && (!schema.items || value.every(item => matchesSchema(item, schema.items!))) && (!schema.uniqueItems || value.every((item, index) => !value.slice(0, index).some(previous => isDeepStrictEqual(previous, item))));
    case 'object': return isObject(value) && (schema.required ?? []).every(key => Object.hasOwn(value, key)) && Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties ?? {}, key) ? matchesSchema(item, schema.properties![key]) : schema.additionalProperties !== false);
  }
}
export function parseObject<T>(text: string, schema: AgentJsonSchema): T {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new AgentError('AGENT_INVALID_JSON'); }
  if (!matchesSchema(value, schema)) throw new AgentError('AGENT_SCHEMA_MISMATCH'); return value as T;
}
