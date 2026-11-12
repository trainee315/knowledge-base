import { sourcePaths } from './payloads.js';

const RESULT_CHARACTERS = 1800; // 工具正文的节选预算，失败证据保持完整。
const CALL_CHARACTERS = 3000; // 调度脚本只保留业务命令、路径与必要片段。
const LINE_CHARACTERS = 320; // 过长工具行的节选上限，用户与助手文字不受此限制。
// 优先保留可影响验收与行为的约束和诊断，再安排首尾及普通实现行。
const HARD_CONDITION = /(?:requireValue|assert\.|expectedRevision|(?:\d+\s*\*\s*)?1024|\d+\s*(?:KiB|MiB|%|ms)|\bnull\b|上限|必须|禁止|不允许|约束|撤回|纠正|失败|错误|EACCES|RECOVERY_REQUIRED)/iu;
const IMPORTANT = /(?:exit_code|session_id|error|failed|failure|warning|assert|requireValue|expected|actual|通过|失败|错误|验证|禁止|必须|约束|撤回|纠正|不允许|默认|预算|限制|上限|effectiveFrom|discoveryChanged|revision|requestId|export\s+(?:async\s+)?(?:function|class|interface|type)|^\s*(?:ℹ|# tests|# pass|# fail|@@|\*\*\*|[+-](?![+-])))/iu;

/** 展开已识别文本容器，结构化副本与文本等价时保留一份。 */
export function toolText(value: string, depth = 0): string {
  if (depth > 8) return value;
  let parsed: any;
  try { parsed = JSON.parse(value); } catch { return value; }
  if (Array.isArray(parsed) && parsed.every(part => part && ['input_text', 'text', 'output_text'].includes(part.type) && typeof part.text === 'string')) return parsed.map(part => toolText(part.text, depth + 1)).join('\n');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
  if (parsed.error || parsed.isError === true) return '[工具报错]\n' + value;
  if (typeof parsed.output === 'string') return `[exit_code=${parsed.exit_code ?? '未知'}]\n${parsed.output}`;
  if (parsed.status === 'fulfilled' && parsed.value !== undefined) return toolText(JSON.stringify(parsed.value), depth + 1);
  if (Array.isArray(parsed.content)) {
    const content = toolText(JSON.stringify(parsed.content), depth + 1);
    let same = false;
    try { same = JSON.stringify(JSON.parse(content)) === JSON.stringify(parsed.structuredContent); } catch { /* 非JSON正文保留独立结构数据。 */ }
    return `${parsed.isError ? '[工具报错]\n' : ''}${content}${parsed.structuredContent && !same ? '\n结构数据\n' + JSON.stringify(parsed.structuredContent) : ''}`;
  }
  if (typeof parsed.source === 'string') return `${parsed.file_path ?? parsed.qualified_name ?? ''}\n${parsed.source}`;
  return value;
}

function lineExcerpt(line: string): string {
  if ([...line].length <= LINE_CHARACTERS) return line;
  const characters = [...line];
  const anchor = line.search(IMPORTANT);
  if (anchor > LINE_CHARACTERS) return characters.slice(0, 80).join('') + ' … ' + [...line.slice(Math.max(0, anchor - 80))].slice(0, LINE_CHARACTERS - 100).join('') + ' …';
  return characters.slice(0, LINE_CHARACTERS - 2).join('') + ' …';
}

/** 按定位、状态和关键诊断选行，节选标记保留原消息回查入口。 */
function excerpt(value: string, limit: number, position: number): string {
  if ([...value].length <= limit) return value;
  const lines = value.split('\n');
  const selected = new Set<number>();
  const indices = [...lines.keys()];
  const priorities = [...indices.filter(index => HARD_CONDITION.test(lines[index])), ...indices.slice(0, 4), ...indices.slice(-4), ...indices.filter(index => IMPORTANT.test(lines[index]))];
  let used = 0;
  for (const index of priorities) {
    if (selected.has(index) || !lines[index].trim()) continue;
    const size = [...lineExcerpt(lines[index])].length + 1;
    if (used + size > limit) continue;
    selected.add(index); used += size;
  }
  const paths = sourcePaths(value).slice(0, 8);
  return `[工具材料节选，全文见原消息 ${position}]\n${paths.length ? paths.join('\n') + '\n' : ''}${[...selected].sort((a, b) => a - b).map(index => lineExcerpt(lines[index])).join('\n')}`;
}

/** 仅从字面参数提取命令，不执行会话中的JS或shell。 */
function literalCommands(value: string): string[] {
  const commands: string[] = [];
  for (const match of value.matchAll(/\bcmd\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu)) {
    try { commands.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1).replace(/\\'/gu, "'").replace(/\\n/gu, '\n')); } catch { /* 动态参数由脚本节选保留。 */ }
  }
  return commands;
}

function executionContext(value: string): string[] {
  const context: string[] = [];
  for (const match of value.matchAll(/\b(sandbox_permissions|justification|workdir)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu)) {
    try { context.push(match[1] + '=' + (match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1).replace(/\\'/gu, "'"))); } catch { /* 动态值保持原节选。 */ }
  }
  return [...new Set(context)];
}

/** 补丁字面量单独展开，避免同一调度脚本中的命令掩盖实现条件。 */
function literalPatches(value: string): string[] {
  const patches: string[] = [];
  for (const match of value.matchAll(/\bapply_patch\(\s*("(?:\\.|[^"\\])*")\s*\)/gu)) {
    try { patches.push(JSON.parse(match[1])); } catch { /* 动态补丁保留脚本节选。 */ }
  }
  return patches;
}

export function aggressiveCall(value: string, position: number): string {
  const boundary = value.indexOf('\n');
  const name = boundary < 0 ? 'tool' : value.slice(0, boundary);
  let body = boundary < 0 ? value : value.slice(boundary + 1);
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.cmd === 'string') return name + '\n' + excerpt(parsed.cmd, CALL_CHARACTERS, position);
    if (typeof parsed.code === 'string') body = parsed.code;
  } catch { /* 直接调用与补丁保留原语法。 */ }
  const commands = literalCommands(body);
  const patches = literalPatches(body);
  const paths = sourcePaths(body);
  if (!commands.length && !patches.length) return excerpt(name + '\n' + body, CALL_CHARACTERS, position);
  return [name, ...paths, ...executionContext(body),
    ...(commands.length ? ['业务命令', ...commands.map(command => excerpt(command, CALL_CHARACTERS, position))] : []),
    ...(patches.length ? ['补丁', excerpt(patches.join('\n'), CALL_CHARACTERS, position)] : []),
  ].join('\n');
}

export function aggressiveResult(value: string, position: number): string {
  const text = toolText(value);
  const failed = /^\[exit_code=-?[1-9]\d*\]|\[工具报错\]|^\s*(?:✖|not ok|Error:|error TS|npm error|Traceback|ℹ fail [1-9])/mu.test(text);
  return failed ? text : excerpt(text, RESULT_CHARACTERS, position);
}
