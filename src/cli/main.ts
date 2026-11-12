#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeError } from '../core/errors.js';
import { handleService, callService } from '../service/client.js';
import { runDevelopmentWorkload } from '../recall/development.js';
import { booleanOptions, commandHelp, validateCommand } from './contract.js';

// 数据位置与工作目录解耦，便于 PPC 从其他目录调用。
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data');
function argumentError(message: string): never { throw new KnowledgeError('INVALID_ARGUMENT', message, undefined, 2); }
function flag(input: Record<string, unknown>, key: string): boolean { return input[key] === true || input[key] === 'true'; }
async function stdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }
/** 解析统一输入：文件/stdin 对象先读，再用显式命令行选项覆盖。 */
async function parse(argv: string[]) {
  const words: string[] = []; const options: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith('--')) { const equal = token.indexOf('='); const key = (equal < 0 ? token.slice(2) : token.slice(2, equal)).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); if (!key) argumentError('空选项'); let value: unknown = true; if (equal >= 0) value = token.slice(equal + 1); else if (argv[index + 1] && !argv[index + 1].startsWith('--') && (!booleanOptions.has(key) || ['true', 'false'].includes(argv[index + 1]))) value = argv[++index]; options[key] = value; } else words.push(token);
  }
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
async function run(): Promise<unknown> {
  const { words, input, dataDir } = await parse(process.argv.slice(2));
  const [group, action] = words;
  if (!group || group === 'help' || flag(input, 'help')) return commandHelp(group === 'help' ? words.slice(1) : words);
  validateCommand(words, input);
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
try { const data = await run(); process.stdout.write(JSON.stringify({ ok: true, data }) + '\n'); }
catch (error) { const known = error instanceof KnowledgeError; process.exitCode = known ? error.exitCode : 1; const output = { ok: false, error: { code: known ? error.code : 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), ...(known && error.details !== undefined ? { details: error.details } : {}) } }; process.stdout.write(JSON.stringify(output) + '\n'); }
