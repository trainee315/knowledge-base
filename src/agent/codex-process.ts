import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AgentError } from './errors.js';

const OUTPUT_LIMIT = 4 * 1024 * 1024; // stdout 与 stderr 共用有界缓冲；原始诊断不返回调用方。
const KILL_GRACE_MS = 1000; // Unix 先终止进程组，宽限后强制回收。
export interface CliCommand { file: string; args: string[] }
export interface CliResult { code: number | null; stdout: string; stderr: string }

/** 仅从服务端可信环境或 PATH 定位 CLI；Windows npm 安装直接运行原生程序，避开 cmd 拼接。 */
export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): CliCommand {
  const explicit = env.KB_CODEX_CLI_PATH;
  const directories = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean).map(dir => dir.replace(/^"|"$/g, ''));
  const candidates = explicit ? [explicit] : directories.flatMap(dir => process.platform === 'win32'
    ? [path.join(dir, 'codex.exe'), path.join(dir, 'node_modules/@openai/codex/bin/codex.js')]
    : [path.join(dir, 'codex')]);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (/\.(?:cmd|bat|ps1)$/i.test(resolved)) throw new AgentError('AGENT_CLI_UNSUPPORTED');
    if (/\.m?js$/i.test(resolved)) {
      const platformPackage = '@openai/codex-' + process.platform + '-' + process.arch;
      const triples: Record<string, string> = { win32: 'pc-windows-msvc', linux: 'unknown-linux-musl', darwin: 'apple-darwin' };
      const target = (process.arch === 'arm64' ? 'aarch64' : 'x86_64') + '-' + triples[process.platform];
      const roots = [path.resolve(path.dirname(resolved), '../vendor')];
      try { roots.unshift(path.join(path.dirname(createRequire(resolved).resolve(platformPackage + '/package.json')), 'vendor')); } catch { /* 兼容旧版 vendor 布局。 */ }
      for (const root of roots) for (const folder of ['bin', 'codex']) {
        const binary = path.join(root, target, folder, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (existsSync(binary)) return { file: binary, args: [] };
      }
      throw new AgentError('AGENT_CLI_UNSUPPORTED');
    }
    return { file: resolved, args: [] };
  }
  throw new AgentError('AGENT_CLI_MISSING');
}

/** 清除 API 认证/路由覆盖，仅让 CLI 自己复用当前服务账号的订阅登录。 */
export function subscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/(?:API[_]?KEY|SECRET|TOKEN|PASSWORD)/i.test(key) && !/^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|CHATGPT_BASE_URL|CODEX_THREAD_ID|CODEX_INTERNAL_.*|CODEX_SANDBOX.*|NODE_OPTIONS)$/i.test(key)));
}

/** 取消后等到子进程真正关闭才释放调用槽；不把上游文本附加到错误对象。 */
export function runCodexProcess(command: CliCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, input = ''): Promise<CliResult> {
  if (signal.aborted) return Promise.reject(new AgentError('AGENT_ABORTED'));
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure: AgentError | undefined, killer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe');
        const kill = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        kill.on('error', () => child.kill());
        kill.on('close', code => { if (code) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
        killer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退出。 */ } }, KILL_GRACE_MS);
      }
    };
    const abort = () => { if (!failure) { failure = new AgentError('AGENT_ABORTED'); terminate(); } };
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { if (!failure) { failure = new AgentError('AGENT_INVALID_RESPONSE'); terminate(); } return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    // setEncoding 保留跨 chunk 的 UTF-8 字符；按字节检查总量。
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(Buffer.from(chunk), 'stdout'));
    child.stderr.on('data', (chunk: string) => collect(Buffer.from(chunk), 'stderr'));
    child.stdin.on('error', () => { /* EPIPE 由退出码和事件决定，不泄露输入。 */ });
    child.on('error', error => { failure = new AgentError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'AGENT_CLI_MISSING' : 'AGENT_PROVIDER_UNAVAILABLE'); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort); if (killer) { clearTimeout(killer); try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 进程组已退出。 */ } }
      if (failure) reject(failure); else resolve({ code, stdout, stderr });
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.end(input);
  });
}
