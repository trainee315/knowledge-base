#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeError } from '../core/errors.js';
import { handleService, callService } from '../service/client.js';
import { runDevelopmentWorkload } from '../recall/development.js';
import { booleanOptions, commandHelp, validateCommand, canonicalWords } from './contract.js';
import { errorOutput, renderText } from './output.js';
import { doctor, startAndOpen, serviceLogs, prepareAndStart } from './local.js';
import { interactive } from './interactive.js';

// 数据位置与工作目录解耦，便于 PPC 从其他目录调用。
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data');
function argumentError(message: string): never { throw new KnowledgeError('INVALID_ARGUMENT', message, undefined, 2); }
function flag(input: Record<string, unknown>, key: string): boolean { return input[key] === true || input[key] === 'true'; }
async function stdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }
/** 解析统一输入：文件/stdin 对象先读，再用显式命令行选项覆盖。 */
async function parse(argv: string[]) {
  const words: string[] = []; const options: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] === '-h' ? '--help' : argv[index];
    if (token.startsWith('--')) { const equal = token.indexOf('='); const key = (equal < 0 ? token.slice(2) : token.slice(2, equal)).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); if (!key) argumentError('空选项'); let value: unknown = true; if (equal >= 0) value = token.slice(equal + 1); else if (argv[index + 1] && !argv[index + 1].startsWith('--') && (!booleanOptions.has(key) || ['true', 'false'].includes(argv[index + 1]))) value = argv[++index]; options[key] = value; } else words.push(token);
  }
  context = { words, dataDir: typeof options.dataDir === 'string' && options.dataDir.trim() ? path.resolve(options.dataDir) : DEFAULT_DATA_DIR };
  let input: Record<string, unknown> = {};
  if (options.help !== undefined && ![true, false, 'true', 'false'].includes(options.help as any)) argumentError('--help 必须为布尔值');
  // 帮助先于input文件读取、stdin等待和任何实际动作。
  if (words[0] === 'help' || flag(options, 'help')) return { words, input: options, dataDir: DEFAULT_DATA_DIR };
  if (options.input !== undefined) { if (typeof options.input !== 'string') argumentError('--input 需要文件路径或 -'); const source = options.input === '-' ? await stdin() : await fs.readFile(path.resolve(options.input), 'utf8'); try { const data: unknown = JSON.parse(source.replace(/^\uFEFF/, '')); if (data === null || typeof data !== 'object' || Array.isArray(data)) argumentError('--input 顶层必须为JSON对象'); input = data as Record<string, unknown>; } catch (error) { if (error instanceof KnowledgeError) throw error; argumentError('--input 不是有效UTF8 JSON'); } }
  const merged = { ...input, ...options };
  if (merged.dataDir !== undefined && (typeof merged.dataDir !== 'string' || !merged.dataDir.trim())) argumentError('--data-dir 需要非空目录路径');
  for (const key of ['json', 'help']) if (merged[key] !== undefined && ![true, false, 'true', 'false'].includes(merged[key] as any)) argumentError(`--${key} 必须为布尔值`);
  return { words, input: merged, dataDir: path.resolve(typeof merged.dataDir === 'string' ? merged.dataDir : DEFAULT_DATA_DIR) };
}
/** 先验证命令契约，再分发本地控制或服务业务；菜单复用相同路径。 */
async function execute(words: string[], input: Record<string, unknown>, dataDir: string): Promise<unknown> {
  words = canonicalWords(words);
  input = { ...input };
  const [group, action] = words;
  if (!group) return { ...commandHelp([]), quickOnly: true };
  if (group === 'help' || flag(input, 'help')) return commandHelp(group === 'help' ? words.slice(1) : words);
  validateCommand(words, input);
  if (group === 'up') return startAndOpen(dataDir, input);
  if (group === 'doctor') { const result = await doctor(dataDir); if (!result.healthy) process.exitCode = 1; return result; }
  if (group === 'interactive') return interactive((nextWords, nextInput) => nextWords[0] === 'up' ? prepareAndStart(dataDir) : execute(nextWords, nextInput, dataDir), dataDir);
  if (group === 'service' && action === 'logs') return serviceLogs(dataDir, input.lines === undefined ? 50 : Number(input.lines));
  delete input.format;
  delete input.help;
  if (group === 'recall' && action === 'workload') { const result = await runDevelopmentWorkload(input); if (result.exitCode !== 0) process.exitCode = 1; return result; }
  if (group === 'service' || group === 'preview') {
    const state = await handleService([...words.slice(1), ...(input.port !== undefined ? ['--port', String(input.port)] : [])], dataDir);
    return group === 'preview' ? { ...state, notice: 'preview 和 service 共享生命周期，停止会一同停止定时任务' } : state;
  }
  for (const key of ['file', 'projectDir', 'sourceRoot']) if (typeof input[key] === 'string' && input[key].trim()) input[key] = path.resolve(input[key]);
  if (Array.isArray(input.additionalDirectories)) input.additionalDirectories = input.additionalDirectories.map(value => typeof value === 'string' && value.trim() ? path.resolve(value) : value);
  delete input.dataDir;
  if (group === 'recall' && input.cwd === undefined) input.cwd = process.cwd();
  let stdinBase64: string | undefined;
  if (group === 'note' && action === 'add' && flag(input, 'stdin') && input.input !== '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    stdinBase64 = Buffer.concat(chunks).toString('base64');
  }
  const result = await callService(dataDir, { words, input, stdinBase64 });
  if (group === 'check' && (result as { valid?: boolean }).valid === false) process.exitCode = 1;
  return result;
}
// 输出模式先从 argv 读取，确保参数解析失败也能返回可读错误。
let textMode = process.argv.includes('--format=text') || process.argv.some((value, index, args) => value === '--format' && args[index + 1] === 'text');
if (process.argv.includes('--json') || process.argv.includes('--json=true')) textMode = false;
let context = { words: [] as string[], dataDir: DEFAULT_DATA_DIR };
try {
  const parsed = await parse(process.argv.slice(2));
  context = parsed;
  if (parsed.input.format !== undefined && !['json', 'text'].includes(String(parsed.input.format))) argumentError('--format 必须为 json/text');
  textMode = !flag(parsed.input, 'json') && (parsed.input.format === 'text' || parsed.words[0] === 'interactive');
  if (parsed.words[0] === 'interactive' && flag(parsed.input, 'json') && !flag(parsed.input, 'help')) argumentError('interactive 不支持 --json；脚本请调用具体命令');
  const data = await execute(parsed.words, parsed.input, parsed.dataDir);
  const output = { ok: true, data };
  const rendered = textMode ? renderText(output) : JSON.stringify(output) + '\n';
  // 菜单已等待所有提交操作；输出刷完后退出，释放 Windows 控制台未完成的读取。
  if (parsed.words[0] === 'interactive' && !flag(parsed.input, 'help')) process.stdout.write(rendered, () => process.exit(process.exitCode ?? 0));
  else process.stdout.write(rendered);
} catch (error) {
  process.exitCode = error instanceof KnowledgeError ? error.exitCode : 1;
  const output = errorOutput(error, context.words, context.dataDir);
  process.stdout.write(textMode ? renderText(output) : JSON.stringify(output) + '\n');
}
