import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptCommand } from '../dist/records/transcript.js';

// 只写新建临时目录，默认不调用模型或启动服务。
const root = await mkdtemp(join(tmpdir(), 'kb-v005-demo-'));
const sourceRoot = join(root, 'sessions'); const data = join(root, 'data'); await mkdir(sourceRoot);
const at = '2026-01-01T01:00:00Z';
const event = (type, payload) => JSON.stringify({ timestamp: at, type, payload });
const turn = (user, assistant) => [event('event_msg', { type: 'task_started' }), event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }), event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] }), event('event_msg', { type: 'task_complete' })].join('\n') + '\n';
const session = join(sourceRoot, 'synthetic.jsonl');
await writeFile(session, event('session_meta', { id: 'synthetic-v005', cwd: root, source: 'cli' }) + '\n' + turn('计划把重试上限设为12，未经我确认先别实施。', '这是待确认计划，还没有修改代码，也没有运行测试。'));
await writeFile(join(root, 'continuation.jsonl'), turn('改为8次，已同意实施；不要保留12次。', '已执行修改为8次。运行 npm test 得到错误 E_SYNTHETIC，验证失败；修复尚未完成。'));
await writeFile(join(root, 'note.md'), '\uFEFF# 自由记录\r\n\r\n保留原始换行与空白。  \r\n');
const config = { alias: 'v005-demo', sourceRoot, projectDir: root, startDate: '2026-01-01', maxCalls: 0 };
await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2));
const org = await transcriptCommand(data, 'create', config);
const q = value => `'${value.replaceAll("'", "''")}'`;
console.log(JSON.stringify({ root, data, session, organizationId: org.id, syntheticOnly: true, commands: [
  `.\\cli.bat note add --file ${q(join(root, 'note.md'))} --request-id demo-note --data-dir ${q(data)} --json`,
  `.\\cli.bat note list --data-dir ${q(data)} --json`,
  `.\\cli.bat transcript preview --alias v005-demo --data-dir ${q(data)} --json`,
  `.\\cli.bat transcript run --alias v005-demo --max-calls 1 --data-dir ${q(data)} --json`,
  `Get-Content -Raw -Encoding utf8 ${q(join(root, 'continuation.jsonl'))} | Add-Content -Encoding utf8 -NoNewline ${q(session)}`,
  `.\\cli.bat transcript run --alias v005-demo --max-calls 1 --data-dir ${q(data)} --json`,
  `.\\cli.bat transcript records --alias v005-demo --data-dir ${q(data)} --json`,
  `.\\cli.bat check --data-dir ${q(data)} --json`,
] }, null, 2));
