import type { JsonObject, PluginManifest, ResourceMeta } from '../contracts/index.js';
import { KnowledgeError } from '../core/errors.js';

// meta分区的结构版本独立于插件manifest和算法processorVersion；首期三分区均为v1。
export const PLUGIN_META_SCHEMA_VERSION = 1;
export function readPluginMeta<T>(resource: ResourceMeta, pluginId: string, supported = PLUGIN_META_SCHEMA_VERSION): T | undefined {
  const partition = resource.plugins[pluginId];
  if (!partition) return undefined;
  if (partition.schemaVersion !== supported) throw new KnowledgeError('UNSUPPORTED_PLUGIN_SCHEMA', `插件${pluginId}不支持meta结构版本${partition.schemaVersion}，禁止读取或覆盖`, { pluginId, supported, actual: partition.schemaVersion }, 1);
  return partition.data as unknown as T;
}

export function manifest(id: string, dependencies: string[] = []): PluginManifest {
  return { id, version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: Object.fromEntries(dependencies.map(id => [id, '^1.0.0'])) };
}
export function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
export function required(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`INVALID_INPUT: ${name} 必须为非空字符串`);
  return value;
}
export function strings(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => typeof item !== 'string' || !item.trim())) throw new Error('INVALID_INPUT: 必须为非空字符串或字符串数组');
  return values as string[];
}
export function number(value: unknown, fallback: number): number {
  if (value !== undefined && (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value))) throw new Error('INVALID_INPUT: 必须为数值');
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('INVALID_INPUT: 必须为有限数值');
  return parsed;
}
export function boolean(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('INVALID_INPUT: 必须为true或false');
}
