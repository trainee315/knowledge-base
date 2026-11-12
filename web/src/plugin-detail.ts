export type ConfigValue = string | number | boolean | null;
export type Values = Record<string, ConfigValue>;
export interface Choice { value: string; label: string }
export interface Field { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'select'; options?: Choice[] }
export interface Configuration {
  kind: 'none' | 'form' | 'link' | 'cron';
  editable: boolean;
  message?: string;
  href?: string;
  fields?: Field[];
  values?: Values;
  configVersion?: string;
  key?: string;
  choices?: Choice[];
}
export interface PluginDetail {
  id: string;
  name: string;
  description: string;
  maintains: string;
  version: string;
  status: string;
  enabled: boolean;
  ready: boolean;
  dependencies: Record<string, string>;
  failure?: string;
  configuration: Configuration;
  collections: { id: string; label: string }[];
}
export interface Page<T> { items: T[]; total: number; offset: number; limit: number }
export interface DataRow { id: string; label: string; summary?: string; href?: string }
export type View = 'overview' | 'config' | 'data';
export const DETAIL_PAGE_SIZE = 20;

export class PluginRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); }
}

export async function pluginRequest<T>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const response = await fetch(path, {
    method: options?.method,
    ...(options?.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
    signal: options?.signal,
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new PluginRequestError(result.error?.message ?? '插件请求失败', response.status, result.error?.code);
  return result.data;
}

export function pluginHash(id: string, view: View = 'overview', params: Record<string, string> = {}): string {
  return '#plugins?' + new URLSearchParams({ id, view, ...params });
}

export function localHref(value?: string): string | undefined {
  return value && /^#(?:plugins(?:[?]|$)|browse(?:[?]|$)|resource\/)/.test(value) ? value : undefined;
}
