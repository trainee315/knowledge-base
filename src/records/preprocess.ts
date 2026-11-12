import { stripVTControlCharacters } from 'node:util';
import type { Message } from './source.js';
import { hash } from './common.js';
import { stripPayloads, payloadPathResolver } from './payloads.js';
import { aggressiveCall, aggressiveResult } from './aggressive.js';

export type PreprocessingMode = 'conservative' | 'off' | 'aggressive';
export const PREPROCESSOR_VERSION = 'payload-paths-5';
const MAX_WRAPPER_DEPTH = 8; // 仅展开已识别的工具传输包装，限制递归深度。
const TRUNCATED = /(?:output (?:was |is )?truncated|truncated output|output exceeded|内容已截断|输出.{0,4}截断)/iu;
const EXECUTION_KEYS = new Set(['output', 'exit_code', 'session_id', 'chunk_id', 'wall_time_seconds', 'original_token_count']);

export interface Size { characters: number; bytes: number }
export interface Change { position: number; rule: string; before: number; after: number }
/** 正文规模与逐消息规则账本独立于模型用量，保持来源指纹原样。 */
export interface CleaningStats {
  before: Size; after: Size;
  roles: Record<string, { before: Size; after: Size }>;
  changes: Change[];
}
export interface CleanedInput { messages: Message[]; context: Message[]; stats: CleaningStats; contextStats: CleaningStats; version: string; mode: PreprocessingMode }
export function textSize(value: string): Size {
  let characters = 0;
  for (const character of value) characters++;
  return { characters, bytes: Buffer.byteLength(value) };
}

/** 只识别纯文本内容块和命令结果，不猜测未知工具对象的含义。 */
function unwrap(value: string, depth = 0): string {
  if (depth >= MAX_WRAPPER_DEPTH) return value;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return value; }
  if (Array.isArray(parsed) && parsed.length && parsed.every(part => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string' && Object.keys(part).every(key => ['type', 'text'].includes(key)))) {
    return parsed.map(part => /^Script completed\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n$/u.test(part.text) ? '[工具执行完成]' : unwrap(part.text, depth + 1)).join('\n');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
  const object = parsed as Record<string, unknown>;
  if (typeof object.output === 'string' && (Number.isInteger(object.exit_code) || Number.isInteger(object.session_id)) && Object.keys(object).every(key => EXECUTION_KEYS.has(key))) {
    const status = object.exit_code === undefined ? `session_id=${object.session_id}（仍在执行）` : `exit_code=${object.exit_code}`;
    return `[${status}]\n${object.output}`;
  }
  if (object.status === 'fulfilled' && object.value !== undefined && Object.keys(object).every(key => ['status', 'value'].includes(key))) return unwrap(JSON.stringify(object.value), depth + 1);
  return value;
}

/** 完整成功的Node测试输出保留汇总，失败、取消和不完整日志保留全文。 */
function compactSuccessfulTests(value: string): string {
  if ([...value.matchAll(/^\[exit_code=(-?\d+)\]$/gmu)].some(match => match[1] !== '0') || /仍在执行/u.test(value)) return value;
  const fields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const counts = Object.fromEntries(fields.map(field => [field, new RegExp(`^ℹ ${field} (\\d+)\\r?$`, 'mu').exec(value)?.[1]]));
  if (fields.some(field => counts[field] === undefined) || counts.fail !== '0' || counts.cancelled !== '0' || !/^ℹ duration_ms [\d.]+\r?$/mu.test(value)) return value;
  const lines = value.split('\n');
  const successes = lines.filter(line => /^[✔✓] .+ \([\d.]+ms\)\r?$/u.test(line));
  if (successes.length !== Number(counts.pass)) return value;
  return lines.filter(line => !/^[✔✓] .+ \([\d.]+ms\)\r?$/u.test(line)).join('\n');
}

function addSize(target: Size, value: Size) { target.characters += value.characters; target.bytes += value.bytes; }

/** 每个输入段有独立去重空间；上下文先处理，引用始终指向本段已有内容。 */
export function cleanInput(context: Message[], messages: Message[], mode: PreprocessingMode = 'conservative'): CleanedInput {
  const seen = new Map<string, { position: number; content: string }>();
  const paths = payloadPathResolver([...context, ...messages]);
  function cleanGroup(group: Message[]) {
    const stats: CleaningStats = { before: { characters: 0, bytes: 0 }, after: { characters: 0, bytes: 0 }, roles: {}, changes: [] };
    const cleaned = group.map(message => {
      let content = message.content;
      const apply = (rule: string, next: string) => {
        if (next === content) return;
        stats.changes.push({ position: message.position, rule, before: textSize(content).characters, after: textSize(next).characters });
        content = next;
      };
      apply('payload-path', stripPayloads(content, paths(message)));
      if (mode !== 'off' && message.role === 'tool-result' && !TRUNCATED.test(content)) {
        apply('tool-wrapper', unwrap(content));
        apply('terminal-control', stripVTControlCharacters(content).replace(/^Progress \d{1,3}%\r(?!\n)/gmu, ''));
        apply('successful-test-lines', compactSuccessfulTests(content));
        const key = hash(content);
        const previous = seen.get(key);
        const reference = previous ? `[工具结果与消息 ${previous.position} 完全相同；本次原消息位置 ${message.position}，执行结果及状态同前文]` : '';
        if (previous && previous.content === content && reference.length < content.length) apply('duplicate-tool-result', reference);
        else seen.set(key, { position: message.position, content });
      }
      if (mode === 'aggressive' && message.role === 'tool-call') apply('aggressive-call', aggressiveCall(content, message.position));
      if (mode === 'aggressive' && message.role === 'tool-result') apply('aggressive-result', aggressiveResult(content, message.position));
      const before = textSize(message.content), after = textSize(content);
      const role = stats.roles[message.role] ??= { before: { characters: 0, bytes: 0 }, after: { characters: 0, bytes: 0 } };
      addSize(stats.before, before); addSize(stats.after, after); addSize(role.before, before); addSize(role.after, after);
      return { ...message, content };
    });
    return { cleaned, stats };
  }
  const prior = cleanGroup(context), added = cleanGroup(messages);
  return { context: prior.cleaned, messages: added.cleaned, stats: added.stats, contextStats: prior.stats, mode, version: PREPROCESSOR_VERSION };
}
