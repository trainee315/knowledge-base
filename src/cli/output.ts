import { KnowledgeError } from '../core/errors.js';
import { optionName, quoteArgument } from './contract.js';

/** 保留错误码及业务 details，补充可执行的修复路径，不把推测当作原因。 */
export function errorOutput(error: unknown, words: string[], dataDir: string) {
  const known = error instanceof KnowledgeError;
  const systemCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code = known ? error.code : systemCode || 'EXECUTION_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  const helpCommand = `cli.bat ${words.join(' ')} --help --format text`.replace('  ', ' ');
  const directory = quoteArgument(dataDir);
  const suggestions: string[] = [];
  const details = known ? error.details : undefined;
  if (details && typeof details === 'object' && 'suggestions' in details && Array.isArray(details.suggestions)) suggestions.push(...details.suggestions.filter((item): item is string => typeof item === 'string'));
  if (code === 'SERVICE_OFFLINE') suggestions.push(`检查目标数据目录后执行：cli.bat up --data-dir ${directory} --no-open`, `如服务已启动，运行 cli.bat doctor --data-dir ${directory} --format text 检查连通性`);
  else if (code === 'ENOENT' || /FILE_NOT_FOUND/.test(code)) suggestions.push('检查文件或目录是否存在；相对路径以当前工作目录为准，包含空格时使用双引号');
  else if (['EACCES', 'EPERM'].includes(code)) suggestions.push('检查目录读写权限以及文件是否被其他程序占用');
  else if (code === 'EADDRINUSE') suggestions.push(`选择其他端口：cli.bat service start --port 0 --data-dir ${directory}`);
  else if (/CONFLICT|REVISION|VERSION_MISMATCH/.test(code)) suggestions.push('先通过对应 get 命令读取最新内容和版本；合并修改后使用最新 expectedRevision/expectedContentVersion 重试');
  else if (/NOT_FOUND|INVALID_ID/.test(code)) suggestions.push('先通过对应 list 命令查找目标，核对 ID 类型和 --data-dir 是否正确');
  else if (/SERVICE_START|SERVICE_ERROR|EXECUTION_FAILED/.test(code)) suggestions.push(`运行 cli.bat doctor --data-dir ${directory} --format text`, `查看 cli.bat service logs --data-dir ${directory} --format text`);
  else if (/LOCKED|BUSY|STOPPING/.test(code)) suggestions.push('等待当前操作结束后重试；不要删除运行中进程持有的锁文件');
  if (!suggestions.length) suggestions.push('检查命令参数和输入内容，参考命令帮助中的示例');
  return { ok: false as const, error: { code, message, ...(details !== undefined ? { details } : {}), suggestions, helpCommand } };
}

/** 文本输出只负责呈现，JSON 数据与业务完成状态保持原样。 */
export function renderText(output: { ok: boolean; data?: any; error?: ReturnType<typeof errorOutput>['error'] }): string {
  if (!output.ok) {
    const error = output.error!;
    return `执行失败 [${error.code}]\n原因：${error.message}\n建议：\n${error.suggestions.map(value => '  ' + value).join('\n')}\n帮助：${error.helpCommand}\n`;
  }
  const data = output.data;
  if (data?.quickOnly) return [`Knowledge Base ${data.version}`, '启动：cli.bat up --format text', '交互：cli.bat interactive', '帮助：cli.bat help --format text', '详情：cli.bat <command> --help --format text'].join('\n') + '\n';
  if (data?.command && data?.fields) {
    const lines = [`${data.command} — ${data.description}`, `用法：${data.usage}`, `执行影响：${data.behavior}`, `必填：${data.required.join('、') || '无'}`, '参数：'];
    for (const [key, value] of Object.entries(data.fields) as [string, any][]) lines.push(`  ${optionName(key)} <${value.type}>  ${value.description}${value.default !== undefined ? '；默认 ' + JSON.stringify(value.default) : ''}`);
    lines.push('全局参数：', ...Object.entries(data.globalOptions).map(([key, value]) => `  ${optionName(key)}  ${value}`), '示例：', `  ${data.exampleCommand}`);
    if (data.exampleFile) lines.push(`  ${data.exampleFile} 内容：`, JSON.stringify(data.example, null, 2));
    lines.push('常见错误：', ...data.commonErrors.map((value: string) => '  ' + value), data.output);
    return lines.join('\n') + '\n';
  }
  if (data?.commands && data?.groups) return [`Knowledge Base ${data.version}`, ...Object.entries(data.groups).flatMap(([title, values]) => [title + '：', ...(values as string[]).map(name => `  ${name}  ${data.descriptions[name]}`)]), '快速开始：', ...data.quickStart.map((value: string) => '  ' + value), '命令详情：cli.bat <command> --help --format text', '兼容别名：org = organization', '默认输出 JSON；人工阅读可加 --format text'].join('\n') + '\n';
  if (data && 'running' in data) return [`服务：${data.running ? '运行中' : '未运行'}`, `数据目录：${data.dataDir}`, ...(data.url ? [`访问地址：${data.url}`] : []), ...(data.stopCommand ? [`停止命令：${data.stopCommand}`] : []), ...(data.warnings ?? [])].join('\n') + '\n';
  if (data?.checks) return ['环境诊断：', ...data.checks.map((check: any) => `  [${check.ok ? '正常' : '需处理'}] ${check.name}：${check.message}`), ...(data.suggestions ?? [])].join('\n') + '\n';
  if (data?.logPath) return `日志：${data.logPath}\n${data.text || '暂无日志；服务可能尚未通过此版本启动。'}\n`;
  const state = data?.complete === false ? '部分完成，请查看结果中的跳过项或错误' : ['queued', 'pending', 'accepted', 'running'].includes(data?.status) ? `任务状态：${data.status}` : '结果';
  return state + '：\n' + JSON.stringify(data, null, 2) + '\n';
}
