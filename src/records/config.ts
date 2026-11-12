import path from 'node:path';
import { homedir } from 'node:os';
import { normalize, requireValue, text } from './common.js';
export interface Filters { sessionIds: string[]; titleKeywords: string[]; bodyKeywords: string[] }
export interface Config {
  alias: string; source: 'codex'; sourceRoot: string; startDate: string; timezone: string; projectDir?: string;
  additionalDirectories: string[]; includeSubdirectories: boolean; include: Filters; exclude: Filters;
  enabled: boolean; intervalMinutes?: number; focus: string; profile: string;
  maxSessions: number; maxInputBytes: number; maxChunkBytes: number; maxCalls: number; maxDurationMs: number;
}
/** 只有发现范围变化才建立新边界，展示、生成和调度设置保留既有增量范围。 */
export function discoveryChanged(previous: Config, next: Config): boolean {
  const fields = ['source', 'sourceRoot', 'projectDir', 'additionalDirectories', 'includeSubdirectories', 'startDate', 'timezone', 'include', 'exclude'] as const;
  return fields.some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}
const EMPTY = (): Filters => ({ sessionIds: [], titleKeywords: [], bodyKeywords: [] });
const DEFAULTS = { source: 'codex' as const, timezone: 'Asia/Shanghai', sourceRoot: path.join(homedir(), '.codex'), additionalDirectories: [], includeSubdirectories: false, enabled: false, focus: '', profile: 'deepseek-default', maxSessions: 10, maxInputBytes: 200_000, maxChunkBytes: 40_000, maxCalls: 0, maxDurationMs: 120_000 };
export function configuration(input: Record<string, unknown>, previous?: Config): Config {
  const fields = new Set([...Object.keys(DEFAULTS), 'alias', 'startDate', 'projectDir', 'include', 'exclude', 'intervalMinutes']);
  const clean = Object.fromEntries(Object.entries(input).filter(([key]) => !['id', 'json', 'input', 'dataDir', 'expectedRevision'].includes(key)));
  requireValue(Object.keys(clean).every(key => fields.has(key)), '未知配置字段');
  const c = { ...DEFAULTS, include: EMPTY(), exclude: EMPTY(), ...previous, ...clean } as Config;
  // JSON null 显式清除可选设置；省略字段继续沿用旧值。
  for (const key of ['projectDir', 'intervalMinutes'] as const) {
    if ((c[key] as unknown) === null) delete c[key];
  }
  c.alias = text(c.alias, 'alias').trim(); c.sourceRoot = path.resolve(text(c.sourceRoot, 'sourceRoot'));
  requireValue(c.source === 'codex', '首版只支持 codex 来源');
  text(c.startDate, 'startDate'); text(c.timezone, 'timezone'); text(c.profile, 'profile');
  try { new Intl.DateTimeFormat('en', { timeZone: c.timezone }); } catch { requireValue(false, '无效时区'); }
  startTime(c.startDate, c.timezone);
  requireValue(typeof c.focus === 'string', 'focus 必须字符串');
  for (const key of ['maxSessions', 'maxInputBytes', 'maxChunkBytes', 'maxCalls', 'maxDurationMs', 'intervalMinutes'] as const) {
    if (c[key] !== undefined) { c[key] = Number(c[key]); requireValue(Number.isSafeInteger(c[key]) && c[key]! >= (key === 'maxCalls' ? 0 : 1), `${key} 必须为有效整数`); }
  }
  requireValue(c.maxDurationMs <= 300_000 && c.maxChunkBytes <= c.maxInputBytes, '时限最多300000ms，单段不能超过总输入预算');
  for (const key of ['enabled', 'includeSubdirectories'] as const) { if ((c[key] as unknown) === 'true') c[key] = true; if ((c[key] as unknown) === 'false') c[key] = false; requireValue(typeof c[key] === 'boolean', `${key} 必须 boolean`); }
  requireValue(Array.isArray(c.additionalDirectories) && c.additionalDirectories.every(item => typeof item === 'string' && item.trim()), 'additionalDirectories 必须目录数组');
  c.additionalDirectories = c.additionalDirectories.map(item => path.resolve(item));
  if (c.projectDir !== undefined) c.projectDir = path.resolve(text(c.projectDir, 'projectDir'));
  requireValue(!c.enabled || c.projectDir && c.intervalMinutes, '周期启用必须设置 projectDir 与 intervalMinutes');
  for (const filter of [c.include, c.exclude]) { requireValue(filter && typeof filter === 'object' && Object.keys(filter).every(key => ['sessionIds', 'titleKeywords', 'bodyKeywords'].includes(key)), '筛选字段非法'); for (const key of ['sessionIds', 'titleKeywords', 'bodyKeywords'] as const) { filter[key] ??= []; requireValue(Array.isArray(filter[key]) && filter[key].every(item => typeof item === 'string' && item.trim()), '筛选条件必须字符串数组'); } }
  return c;
}
/** 日期按配置时区零点解释；显式 ISO 必须带时区。 */
export function startTime(value: string, timezone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { requireValue(/(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), '时间须日期或带时区 ISO'); return Date.parse(value); }
  let stamp = Date.parse(value + 'T00:00:00Z'); requireValue(Number.isFinite(stamp) && new Date(stamp).toISOString().startsWith(value), '无效日期');
  const target = stamp;
  for (let i = 0; i < 3; i++) { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(stamp).map(p => [p.type, p.value])); stamp += target - Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`); }
  return stamp;
}
export function directoryMatches(c: Config, directories: string[]): boolean {
  if (!c.projectDir && !c.additionalDirectories.length) return true;
  const identity = (dir: string) => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  return [c.projectDir, ...c.additionalDirectories].filter(Boolean).some(root => directories.some(dir => { const relative = path.relative(identity(root!), identity(dir)); return relative === '' || c.includeSubdirectories && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }));
}
export function filterMatches(filter: Filters, id: string, title: string, body: string, exclusion: boolean): boolean {
  const matches = [filter.sessionIds.length ? filter.sessionIds.includes(id) : undefined, filter.titleKeywords.length ? filter.titleKeywords.some(word => normalize(title).includes(normalize(word))) : undefined, filter.bodyKeywords.length ? filter.bodyKeywords.some(word => normalize(body).includes(normalize(word))) : undefined].filter(value => value !== undefined);
  return exclusion ? matches.some(Boolean) : matches.every(Boolean);
}
