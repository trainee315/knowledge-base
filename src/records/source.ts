import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decode, hash, requireValue } from './common.js';

export const ADAPTER_VERSION = 'codex-rollout-3';
const QUIET_MS = 600_000; // 没有可靠轮次状态时的静默窗口。
export interface Message { position: number; fingerprint: string; at: string; role: string; content: string; toolCallId?: string }
export interface Turn { messages: Message[]; complete: boolean; id?: string; completedPosition?: number }
export interface Session { id: string; title: string; directories: string[]; child: boolean; turns: Turn[]; file: string; ordinalStart?: number; ordinalEnd?: number; historyBase?: number; afterCutoff?: boolean }
/** 原始私有 DTO 只在适配器内使用；只接受已识别 rollout 事件。 */
export async function readSession(file: string, cutoff: number): Promise<Session> {
  const stat = await fs.stat(file);
  const handle = await fs.open(file, 'r');
  let bytes: Buffer;
  try { bytes = Buffer.alloc(stat.size); const read = await handle.read(bytes, 0, stat.size, 0); bytes = bytes.subarray(0, read.bytesRead); } finally { await handle.close(); }
  const raw = decode(bytes); const lines = raw.split('\n');
  if (!raw.endsWith('\n')) lines.pop(); // 写入中的尾行留给下一次。
  let session: Session | undefined; let current: Turn = { messages: [], complete: false }; let reliable = false;
  const flush = () => { if (current.messages.length || current.id && current.complete) session?.turns.push(current); current = { messages: [], complete: false }; };
  for (let position = 0; position < lines.length; position++) {
    if (!lines[position].trim()) continue;
    let row: { timestamp: string; type: string; ordinal?: number; payload: Record<string, any> };
    try { row = JSON.parse(lines[position]); } catch { throw new Error(`SOURCE_FORMAT: JSONL 非法，行 ${position + 1}`); }
    requireValue(row && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)), '来源事件缺少有效时间', 'SOURCE_FORMAT');
    if (Date.parse(row.timestamp) > cutoff && (row.type !== 'session_meta' || session)) continue;
    const p = row.payload;
    requireValue(p && typeof p === 'object', '来源事件缺少 payload', 'SOURCE_FORMAT');
    if (row.type === 'session_meta') {
      requireValue(!session && typeof (p.id ?? p.session_id) === 'string' && typeof p.cwd === 'string', 'session_meta 不受支持', 'SOURCE_FORMAT');
      const sourceIdentity = JSON.stringify([p.source, p.thread_source]).toLowerCase();
      const child = sourceIdentity.includes('subagent');
      requireValue(child || [p.source, p.thread_source].some(value => typeof value === 'string' && ['cli', 'vscode', 'exec', 'appserver', 'app-server', 'desktop', 'app'].includes(value.toLowerCase())), '无法识别主/子 session 来源', 'SOURCE_FORMAT');
      session = { id: p.id ?? p.session_id, title: typeof p.title === 'string' ? p.title : '', directories: [p.cwd], child, turns: [], file };
      if (Date.parse(row.timestamp) > cutoff) return { ...session, afterCutoff: true };
      // 子会话可能内嵌父会话元数据，默认排除时无需解析继承正文。
      if (child) return session;
      if (row.ordinal !== undefined) {
        requireValue(Number.isSafeInteger(row.ordinal) && row.ordinal >= 0, '来源 ordinal 非法', 'SOURCE_FORMAT');
        session.ordinalStart = row.ordinal;
      }
      if (p.history_base) {
        requireValue(typeof p.history_base.thread_id === 'string' && Number.isSafeInteger(p.history_base.end_ordinal_exclusive) && p.history_base.end_ordinal_exclusive === row.ordinal, '续存文件 history_base 不受支持', 'SOURCE_FORMAT');
        session.historyBase = p.history_base.end_ordinal_exclusive;
      }
    } else if (row.type === 'turn_context' && typeof p.cwd === 'string') { session?.directories.push(p.cwd); }
    else if (row.type === 'event_msg' && p.type === 'task_started') { reliable = true; flush(); current.id = p.turn_id ?? p.root_turn_id; }
    else if (row.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'task_aborted')) { reliable = true; current.id ??= p.turn_id ?? p.root_turn_id; current.complete = true; current.completedPosition = row.ordinal ?? position; flush(); }
    else if (row.type === 'response_item') {
      let content = ''; let role = p.role;
      if (p.type === 'message' && ['user', 'assistant'].includes(role)) {
        requireValue(Array.isArray(p.content), 'message content 结构不受支持', 'SOURCE_FORMAT');
        requireValue(p.content.every((part: any) => ['input_text', 'output_text', 'text', 'input_image', 'image'].includes(part.type)), '不支持的消息内容格式', 'SOURCE_FORMAT');
        content = p.content.filter((part: any) => typeof part.text === 'string').map((part: any) => part.text).join('\n');
      } else if (['function_call', 'custom_tool_call'].includes(p.type)) { role = 'tool-call'; content = `${p.name}\n${p.arguments ?? p.input ?? ''}`; }
      else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) { role = 'tool-result'; content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output); }
      if (content?.trim()) {
        requireValue(session, '消息早于 session_meta', 'SOURCE_FORMAT');
        const messagePosition = row.ordinal ?? position;
        requireValue(Number.isSafeInteger(messagePosition) && messagePosition >= 0, '消息位置非法', 'SOURCE_FORMAT');
        const toolCallId = typeof p.call_id === 'string' ? p.call_id : undefined;
        current.messages.push({ position: messagePosition, at: row.timestamp, role, content, fingerprint: hash(JSON.stringify({ position: messagePosition, at: row.timestamp, role, content })), ...(toolCallId ? { toolCallId } : {}) });
        if (!session.title && role === 'user') session.title = content.split('\n')[0].slice(0, 200);
      }
    }
    if (session?.ordinalStart !== undefined) {
      requireValue(Number.isSafeInteger(row.ordinal) && row.ordinal! >= session.ordinalStart, '续存文件缺少全局 ordinal', 'SOURCE_FORMAT');
      session.ordinalEnd = row.ordinal! + 1;
    }
  }
  requireValue(session, '不是受支持的 Codex rollout JSONL', 'SOURCE_FORMAT');
  if (!reliable && current.messages.length) current.complete = cutoff - Math.max(stat.mtimeMs, ...current.messages.map(item => Date.parse(item.at))) >= QUIET_MS;
  flush(); return session;
}
/** Codex 续存片段通过 history_base 与全局 ordinal 串接，保留完整轮次。 */
export function joinSessions(fragments: Session[]): Session[] {
  const groups = new Map<string, Session[]>();
  for (const fragment of fragments) groups.set(fragment.id, [...(groups.get(fragment.id) ?? []), fragment]);
  return [...groups.values()].map(parts => {
    parts.sort((a, b) => (a.ordinalStart ?? 0) - (b.ordinalStart ?? 0));
    const merged = structuredClone(parts[0]);
    let previousStart = parts[0].ordinalStart ?? 0;
    for (const part of parts.slice(1)) {
      requireValue(part.historyBase !== undefined && part.historyBase > previousStart && merged.ordinalEnd !== undefined && merged.ordinalEnd >= part.historyBase && part.child === merged.child, '同ID来源缺少连续的续存依据', 'SOURCE_DUPLICATE');
      // history_base 明确声明继承前缀，旧文件在检查点之后的尾部不属于新快照。
      merged.turns = merged.turns.map(turn => ({ ...turn, messages: turn.messages.filter(message => message.position < part.historyBase!), complete: turn.complete && (turn.completedPosition === undefined || turn.completedPosition < part.historyBase!) })).filter(turn => turn.messages.length);
      merged.directories.push(...part.directories);
      const tail = merged.turns.at(-1);
      const head = part.turns[0];
      if (tail && !tail.complete && tail.id && tail.id === head?.id) {
        tail.messages.push(...head.messages); tail.complete = head.complete;
        merged.turns.push(...part.turns.slice(1));
      } else merged.turns.push(...part.turns);
      merged.ordinalEnd = part.ordinalEnd;
      previousStart = part.ordinalStart!;
    }
    return merged;
  });
}
export async function discover(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const file = path.join(dir, entry.name); if (entry.isDirectory()) await visit(file); else if (entry.name.endsWith('.jsonl') && entry.name !== 'session_index.jsonl') result.push(file); } }
  await visit(root); return result.sort();
}
/** 可选标题索引只提供展示名称，不决定增量或正文；私有格式变更明确失败。 */
export async function sessionTitles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let bytes: Buffer;
  try { bytes = await fs.readFile(path.join(root, 'session_index.jsonl')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  const raw = decode(bytes); const lines = raw.split('\n'); if (!raw.endsWith('\n')) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: { id: string; thread_name: string; updated_at: string };
    try { row = JSON.parse(line); } catch { requireValue(false, '标题索引 JSONL 非法', 'SOURCE_FORMAT'); }
    requireValue(typeof row.id === 'string' && typeof row.thread_name === 'string' && typeof row.updated_at === 'string', '标题索引格式不受支持', 'SOURCE_FORMAT');
    result.set(row.id, row.thread_name);
  }
  return result;
}
