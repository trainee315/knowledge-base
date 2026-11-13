import { createInterface } from 'node:readline/promises';
import { KnowledgeError } from '../core/errors.js';
import { commandHelp, commands } from './contract.js';
import { errorOutput, renderText } from './output.js';
import { openBrowser } from './local.js';

type Execute = (words: string[], input: Record<string, unknown>) => Promise<any>;
export interface Interaction { ask(prompt: string): Promise<string>; write(text: string): void; cancelled(): boolean }
const SEARCH_PAGE_SIZE = 20; // 避免菜单一次输出整个知识库。

/** 菜单与终端分离，便于验证重填、取消及业务操作顺序。 */
export async function menu(io: Interaction, execute: Execute, dataDir: string) {
  let changes = 0;
  async function operation(words: string[], input: Record<string, unknown> = {}) {
    io.write(`执行：${words.join(' ')}；${commands[words.join(' ')]?.behavior ?? ''}\n`);
    const result = await execute(words, input);
    if (['up', 'resource import', 'service stop'].includes(words.join(' '))) changes++;
    io.write(renderText({ ok: true, data: result }));
    return result;
  }
  async function search() {
    const text = (await io.ask('输入文件名或检索词（空值列出资源，/cancel 返回）：')).trim();
    if (text === '/cancel' || io.cancelled()) return;
    let offset = 0;
    while (!io.cancelled()) {
      const rows = await execute(['resource', 'list'], { ...(text ? { text } : {}), limit: SEARCH_PAGE_SIZE, offset }) as any[];
      if (!rows.length) { io.write('没有匹配资源。\n'); return; }
      rows.forEach((row, index) => io.write(`${index + 1}. ${row.resource?.originalName ?? row.resource?.filename ?? row.resource?.id ?? row.id}\n`));
      const choice = (await io.ask('输入序号读取正文，n 下一页，0 返回：')).trim();
      if (choice === '0' || choice === '/cancel' || io.cancelled()) return;
      if (choice === 'n') { offset += SEARCH_PAGE_SIZE; continue; }
      const index = Number(choice) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= rows.length) { io.write('请选择列表中的有效序号。\n'); continue; }
      await operation(['resource', 'get'], { id: rows[index].resource?.id ?? rows[index].id, content: true });
      return;
    }
  }
  while (!io.cancelled()) {
    io.write('\n知识库常用操作\n1. 启动服务并打开页面\n2. 打开运行中的页面\n3. 导入文档\n4. 检索并查看资源\n5. 查看服务状态\n6. 命令帮助\n7. 停止服务\n0. 退出\n');
    try {
      const choice = (await io.ask('请选择：')).trim();
      if (io.cancelled() || choice === '0' || choice === '/cancel') break;
      if (choice === '1') await operation(['up']);
      else if (choice === '2') {
        const state = await execute(['service', 'status'], {});
        if (!state.running) throw new KnowledgeError('SERVICE_OFFLINE', '服务未运行');
        await openBrowser(state.url); io.write('已请求打开页面：' + state.url + '\n');
      } else if (choice === '3') {
        while (!io.cancelled()) {
          let file = (await io.ask('文件路径（支持粘贴带引号路径，/cancel 返回）：')).trim();
          if (file === '/cancel' || io.cancelled()) break;
          if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1);
          try { await operation(['resource', 'import'], { file }); break; }
          catch (error) {
            io.write(renderText(errorOutput(error, ['resource', 'import'], dataDir)));
            const code = error instanceof KnowledgeError ? error.code : (error as NodeJS.ErrnoException).code;
            if (!['ENOENT', 'FILE_NOT_FOUND', 'INVALID_ARGUMENT', 'EISDIR'].includes(code ?? '')) break;
          }
        }
      } else if (choice === '4') await search();
      else if (choice === '5') await operation(['service', 'status']);
      else if (choice === '6') {
        const topic = (await io.ask('输入命令（空值显示全部，/cancel 返回）：')).trim();
        if (topic !== '/cancel' && !io.cancelled()) io.write(renderText({ ok: true, data: commandHelp(topic ? topic.split(/\s+/) : []) }));
      } else if (choice === '7') await operation(['service', 'stop']);
      else io.write('请输入 0–7。\n');
    } catch (error) {
      if (io.cancelled()) break;
      io.write(renderText(errorOutput(error, [], dataDir)));
    }
  }
  return { cancelled: io.cancelled(), completedChanges: changes, message: changes ? `已退出；${changes} 次启动、导入或停止操作已完成，不会撤销。` : '已退出；没有完成写入或服务变更。' };
}

export async function interactive(execute: Execute, dataDir: string) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new KnowledgeError('INTERACTIVE_REQUIRES_TTY', '交互菜单需要终端；脚本请直接调用具体命令', undefined, 2);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  let cancelled = false;
  let cancelQuestion: (() => void) | undefined;
  const cancel = () => { cancelled = true; cancelQuestion?.(); };
  terminal.on('SIGINT', () => {
    cancel();
    process.stderr.write('\n正在退出；若操作已提交，将等待当前结果并报告已完成变更。\n');
  });
  terminal.on('close', cancel);
  try {
    // Windows 终端关闭 readline 后，question 可能仍等候换行；显式结束外层等待。
    const ask = (prompt: string) => new Promise<string>((resolve, reject) => {
      if (cancelled) { reject(new Error('已取消')); return; }
      cancelQuestion = () => reject(new Error('已取消'));
      terminal.question(prompt).then(value => { cancelQuestion = undefined; resolve(value); }, reject);
    });
    return await menu({ ask, write: text => process.stderr.write(text), cancelled: () => cancelled }, execute, dataDir);
  } finally { terminal.close(); process.stdin.unref(); }
}
