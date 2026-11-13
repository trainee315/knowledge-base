import { KnowledgeError } from '../core/errors.js';
import { readFileSync } from 'node:fs';
import { extraCommands, extraFields, type Field, type Command } from './catalog.js';

// 从包清单读取版本，避免帮助与构建版本漂移。
export const CLI_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
// CLI 与服务业务入口共用字段白名单，帮助内容与参数校验保持同源。
const fields: Record<string, Field> = { ...extraFields };
function define(names: string, type: Field['type'], description: string) { for (const name of names.split(' ')) fields[name] = { type, description }; }
define('name description view keyword', 'string', '语义标签名称/说明、浏览类型或关键词筛选');
define('id alias sessionId', 'string', 'id/alias定位转录组织（二选一）；sessionId仅缩小本次源会话范围');
define('source sourceRoot startDate timezone projectDir focus profile preprocessing from to', 'string', '转录配置；from/to须日期或带时区ISO，profile为Agent模型配置（DeepSeek或服务器Codex CLI）');
define('maxCalls maxSessions maxInputBytes maxChunkBytes maxDurationMs intervalMinutes expectedRevision expectedCronRevision revision', 'integer', '非负整数；预算字段覆盖本次值，不修改实例配置');
define('enabled includeSubdirectories vectors rebuild rerank debug crossProject', 'boolean', 'true或false；JSON布尔或命令行显式值');
define('include exclude scope resources organizations chunking ranking', 'object', '通过UTF8 JSON对象传入，作用范围不会自动扩大');
define('additionalDirectories projects needs cases modes args', 'array', '通过UTF8 JSON数组传入');
define('mode query task contextProjectId cwd retrievalMode section sort direction command projectId snapshotFingerprint contentHash splitter', 'string', '召回请求字段；固定项目通过scope.projectId指定');
define('version budgetTokens maxBytes maxFragments candidates neighbors offset endOffset limit', 'integer', '非负整数；offset为read片元序号或list位置，endOffset为read排他上界');
for (const key of ['projectDir', 'intervalMinutes', 'expectedCronRevision']) fields[key].nullable = true;
Object.assign(fields.maxCalls, { default: 0, description: '模型调用上限；默认沿用实例，新实例为0' });
Object.assign(fields.preprocessing, { default: 'conservative', description: 'off/conservative/aggressive；retry沿用冻结策略，拒绝此字段' });
Object.assign(fields.retrievalMode, { default: 'hybrid', description: 'lexical/semantic/hybrid；检查stages，hybrid可能明确降级' });
Object.assign(fields.maxFragments, { default: 6 }); Object.assign(fields.maxBytes, { default: 12000 }); Object.assign(fields.budgetTokens, { default: 3000 });
const fieldDescriptions: Record<string, string> = {
  name: '显示名称', description: '说明文本；可设为空字符串', view: 'documents/fragments/keywords/candidates', keyword: '按关键词筛选',
  alias: '转录实例别名', sessionId: '源会话 ID；只缩小本次范围', source: '转录来源标识', sourceRoot: '会话来源根目录',
  startDate: '起始日期 YYYY-MM-DD', timezone: 'IANA 时区，例如 Asia/Shanghai', projectDir: '项目目录；null 表示取消关联',
  focus: '压缩关注点；空字符串清除', profile: '已保存的模型配置 ID', from: '范围起点日期或带时区 ISO 时间', to: '范围终点日期或带时区 ISO 时间',
  maxSessions: '本次最多处理会话数', maxInputBytes: '本次输入字节预算', maxChunkBytes: '单个压缩块字节上限', maxDurationMs: '执行时长预算，毫秒',
  intervalMinutes: '执行间隔分钟数；null 清除', expectedRevision: '当前配置 revision；用于并发校验', expectedCronRevision: '当前调度计划 revision', revision: '兼容配置版本字段',
  enabled: '启用状态 true/false', includeSubdirectories: '是否扫描子目录', vectors: '构建时同时编码本地向量', rebuild: '显式重建派生索引',
  rerank: '是否启用本地重排', debug: '是否返回诊断信息', crossProject: '是否跨项目；仍受显式 scope 限制',
  include: '包含规则 JSON 对象', exclude: '排除规则 JSON 对象', scope: '检索范围对象，例如 {projectId:"example"}',
  resources: '资源范围配置对象', organizations: '组织范围配置对象', chunking: '片元划分配置', ranking: '排序配置',
  additionalDirectories: '额外来源目录数组', projects: '项目映射数组，每项含 id/directories', needs: '召回需求数组', cases: '评价用例数组', modes: '评价模式数组', args: '子命令参数数组；不经过 shell',
  mode: '操作模式；有效值由具体命令核验', query: '检索文本', task: '任务描述', contextProjectId: '调用方项目标识', cwd: '解析项目范围的工作目录',
  section: '原文小节标识', sort: '排序字段', direction: '排序方向', command: '要运行的开发程序名称或路径', projectId: '项目标识；具体 ID 类型见命令用途',
  snapshotFingerprint: '续读快照指纹；使用上次返回值', contentHash: '固定原文内容哈希；使用上次返回值', splitter: '片元划分版本标识',
  version: '固定读取的正文版本', budgetTokens: '召回 token 预算', maxBytes: '召回内容字节上限', maxFragments: '最多返回片元数',
  candidates: '候选数量上限', neighbors: '邻接片元数量', offset: '分页起点；recall read 中为片元序号', endOffset: 'recall read 片元范围的排他上界', limit: '本页最多返回条数',
};
for (const [name, description] of Object.entries(fieldDescriptions)) fields[name].description = description;

const config = 'alias source sourceRoot startDate timezone projectDir additionalDirectories includeSubdirectories include exclude enabled intervalMinutes focus profile preprocessing maxSessions maxInputBytes maxChunkBytes maxCalls maxDurationMs';
const budgets = 'maxCalls maxSessions maxInputBytes maxDurationMs';
const query = 'mode id version query task needs scope contextProjectId cwd retrievalMode rerank budgetTokens maxBytes maxFragments candidates neighbors section offset endOffset limit sort direction debug projectId snapshotFingerprint contentHash splitter';
export const commands: Record<string, Command> = { ...extraCommands };
function register(name: string, names: string, description: string, behavior: string, example: Record<string, unknown>) { commands[name] = { fields: names.split(' ').filter(Boolean), description, behavior, example }; }
for (const action of ['check', 'test']) register('agent ' + action, 'profile', action === 'check' ? '检查服务器模型认证就绪状态' : '测试已保存模型的结构化生成', action === 'check' ? '本机检测，不调用模型' : '显式调用所选模型，消耗额度，不自动回退', { profile: 'codex-session' });
register('transcript create', config, '创建转录实例', '写配置；零模型调用', { alias: '项目记录', startDate: '2026-11-12', projectDir: 'D:/project/example', maxCalls: 0 });
register('transcript configure', 'id expectedRevision expectedCronRevision ' + config, '更新实例配置', '写配置；发现范围变化建立新边界', { id: '<组织UUID>', expectedRevision: 1, preprocessing: 'conservative' });
for (const action of ['get', 'status', 'records']) register('transcript ' + action, 'id alias', action === 'status' ? '精简运行状态，不含冻结原文' : '读取转录实例或记录', '只读；零模型调用', { id: '<组织UUID>' });
for (const action of ['list', 'tick']) register('transcript ' + action, '', action === 'list' ? '列出转录实例' : '执行到期计划', action === 'list' ? '只读' : '按计划预算写入并可能调用模型', {});
for (const action of ['preview', 'run', 'backfill', 'retry']) register('transcript ' + action,
  'id alias sessionId ' + budgets + (action === 'retry' ? '' : ' maxChunkBytes preprocessing to') + (['preview', 'backfill'].includes(action) ? ' from' : ''),
  action === 'retry' ? '恢复已冻结任务；不发现新材料' : '指定范围的会话压缩' ,
  action === 'preview' ? '只读、零模型调用；返回生效预算和cutoff' : '按预算调用模型并原子写入；检查complete/skips/error.details',
  { id: '<组织UUID>', sessionId: '<源sessionId>', maxCalls: 1, ...(action === 'backfill' ? { from: '2026-11-01' } : {}) });
for (const action of ['scope', 'prepare', 'read', 'list', 'search']) register('recall ' + action, query, '范围内的' + action,
  ['scope', 'read', 'list'].includes(action) ? '只读、零模型调用' : '只读；按检索模式运行本机模型，不隐式建索引',
  { scope: { projectId: 'example' }, ...(action === 'read' ? { id: '<resourceId>' } : ['prepare', 'search'].includes(action) ? { query: '项目约束', retrievalMode: 'hybrid' } : {}) });
register('recall config get', 'cwd', '读取完整范围配置与revision', '只读、无正文、零模型调用', {});
register('recall configure', 'cwd expectedRevision revision projects resources organizations chunking ranking', '显式合并更新范围配置', '写配置；先config get，保留其他项目映射', { expectedRevision: 0, projects: [{ id: 'example', directories: ['D:/project/example'] }], organizations: {} });
for (const action of ['status', 'build']) register('recall index ' + action, 'cwd' + (action === 'build' ? ' vectors rebuild' : ''), '索引' + action, action === 'status' ? '只读' : '写派生索引；vectors才编码文档；全文构建会发布不带向量的代次', { ...(action === 'build' ? { vectors: true } : {}) });
for (const action of ['status', 'prepare']) register('recall model ' + action, 'cwd', '本机模型' + action, action === 'status' ? '只读' : '下载固定模型并核验；不使用云端profile', {});
register('recall workload', 'command args cwd', '显式开发负载保护', '运行本机开发命令；日志stderr，不经过shell', { command: 'npm', args: ['run', 'build'] });
register('recall eval', 'cwd cases modes', '固定用例评价', '按模式运行本机模型', { cases: [], modes: ['bm25'] });

// 语义命令接入主线帮助契约，帮助路径不连接服务或启动匹配。
for (const action of ['list', 'get']) register('semantic ' + action, 'id view query keyword offset limit', '浏览语义标签及匹配结果', '只读；view为documents/fragments/keywords/candidates，候选不计入正式匹配', action === 'get' ? { id: '<标签UUID>', view: 'fragments' } : {});
register('semantic create', 'name aliases description', '新增共享标签', '保存后后台匹配；不调用生成模型', { name: '预制体', aliases: ['Prefab'], description: '游戏节点预制资产' });
register('semantic update', 'id name aliases description', '修改标签含义', '仅重新匹配该标签', { id: '<标签UUID>', description: '游戏性能' });
for (const action of ['delete', 'retry']) register('semantic ' + action, 'id', action === 'delete' ? '删除标签入口并保留原文' : '重新匹配标签', '写标签状态；历史定义和原文保留', { id: '<标签UUID>' });
register('semantic retry-all', '', '重试失败的语义任务', '排队；复用成功的编码缓存', {});
register('semantic run', '', '执行一批语义任务', '写派生结果，可能调用本地编码模型', {});
register('semantic rebuild', '', '重新生成完整关键词及双向索引', '排队并保留本地向量、标签定义和正文；运行中重复调用只续接现有重建，semantic run推进任务', {});

export const booleanOptions = new Set(['stdin', 'json', 'help', 'copy', 'cascade', 'includeDeleted', 'content', ...Object.keys(fields).filter(key => fields[key].type === 'boolean')]);
const transport = new Set(['input', 'json', 'help', 'dataDir', 'format']);
export function canonicalWords(words: string[]): string[] { return words[0] === 'org' ? ['organization', ...words.slice(1)] : words; }
export function optionName(key: string): string { return '--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()); }
// 面向 PowerShell 的可复制示例使用字面量引号，避免路径中的 $ 被展开。
export function quoteArgument(value: unknown): string { return typeof value === 'string' ? "'" + value.replace(/'/g, "''") + "'" : String(value); }

/** 编辑距离仅用于提示；绝不自动改写或执行用户命令。 */
export function suggest(value: string, candidates: string[]): string[] {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
      row = next;
    }
    return row[b.length];
  };
  return candidates.map(name => ({ name, score: distance(value, name) })).filter(item => item.score <= Math.max(2, Math.floor(value.length / 3))).sort((a, b) => a.score - b.score).slice(0, 3).map(item => item.name);
}

// 必填关系与帮助共用，oneOf 关系用于需要选择一种输入来源的命令。
for (const [name, spec] of Object.entries(commands)) {
  if (spec.required) continue;
  spec.required = name === 'semantic create' ? ['name'] : ['semantic get', 'semantic update', 'semantic delete', 'semantic retry'].includes(name) ? ['id'] : name === 'transcript create' ? ['alias', 'startDate'] : name === 'transcript configure' ? ['id'] : name === 'recall configure' ? ['expectedRevision', 'projects'] : name === 'transcript backfill' ? ['from'] : name === 'recall read' ? ['id'] : [];
  if (name.startsWith('transcript ') && !['create', 'configure', 'list', 'tick'].includes(name.split(' ')[1])) spec.oneOf = [['id', 'alias']];
}
/** 在任何业务动作前拒绝未知参数；嵌套字段及值域由所属业务继续核验。 */
export function validateCommand(words: string[], input: Record<string, unknown>): void {
  const name = canonicalWords(words).join(' ');
  const spec = commands[name];
  const invalid = (message: string, suggestions?: string[]): never => { throw new KnowledgeError('INVALID_ARGUMENT', message, suggestions?.length ? { suggestions } : undefined, 2); };
  if (!spec) invalid('未知命令或多余位置参数：' + name, suggest(name, Object.keys(commands)).map(value => `请使用 cli.bat ${value} --help`));
  for (const [key, value] of Object.entries(input)) {
    if (transport.has(key)) continue;
    if (!spec.fields.includes(key)) invalid(`未知或不适用参数 ${optionName(key)}（${key}）；请查看 ${name} --help`, suggest(key, spec.fields).map(value => `是否要使用 ${optionName(value)}？`));
    const field = fields[key];
    if (value === null && field.nullable) continue;
    const valid = field.type === 'string' ? typeof value === 'string' && (['focus', 'description', 'credentialEnv'].includes(key) || value.trim().length > 0)
      : field.type === 'integer' ? (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0
      : field.type === 'number' ? (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value))
      : field.type === 'boolean' ? [true, false, 'true', 'false'].includes(value as any)
      : field.type === 'strings' ? typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string')
      : field.type === 'array' ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!valid) invalid(`${key} 必须为 ${field.type}，不能缺值`);
  }
  for (const key of spec.required ?? []) if (input[key] === undefined) invalid(`缺少必填参数 ${optionName(key)}；请查看 ${name} --help`);
  for (const choices of spec.oneOf ?? []) if (choices.filter(key => input[key] !== undefined && input[key] !== false && input[key] !== 'false').length !== 1) invalid(`参数 ${choices.map(optionName).join(' / ')} 必须且只能提供一个`);
  if (input.port !== undefined && Number(input.port) > 65535) invalid('--port 必须为 0–65535');
  if (name === 'service logs' && input.lines !== undefined && (Number(input.lines) < 1 || Number(input.lines) > 1000)) invalid('--lines 必须为 1–1000');
}

const globalOptions = {
  input: 'UTF8 JSON 文件或 -（stdin）；命令行覆盖同名字段',
  dataDir: '数据目录；默认仓库 .data，与当前工作目录无关',
  json: '单个 JSON 对象；优先于 --format text',
  format: 'json/text；默认 json',
  help: '离线帮助；支持 -h，不执行命令',
};
const categories: Record<string, string[]> = {
  '启动与维护': ['up', 'doctor', 'interactive', 'service', 'preview', 'backup', 'restore', 'check', 'reindex'],
  '资源与组织': ['resource', 'note', 'meta', 'organization', 'organization-type', 'plugin', 'system', 'project-track'],
  '检索与整理': ['recall', 'semantic', 'content', 'keyword', 'tag', 'relation', 'organize', 'task'],
  '模型与调度': ['agent', 'transcript', 'cron', 'schedule'],
};

export function commandHelp(words: string[]) {
  const name = canonicalWords(words).join(' '), spec = commands[name];
  if (!spec) {
    const matches = Object.keys(commands).filter(key => !name || key.startsWith(name + ' '));
    if (!matches.length) throw new KnowledgeError('INVALID_ARGUMENT', '未知帮助主题：' + name, { suggestions: suggest(name, Object.keys(commands)).map(value => `cli.bat ${value} --help`) }, 2);
    return { version: CLI_VERSION, usage: 'cli.bat <command> [options]', commands: matches, otherCommands: [], required: [],
      groups: Object.fromEntries(Object.entries(categories).map(([title, groups]) => [title, matches.filter(key => groups.includes(key.split(' ')[0]))]).filter(([, values]) => values.length)),
      descriptions: Object.fromEntries(matches.map(key => [key, commands[key].description])), globalOptions,
      quickStart: ['cli.bat up --format text', 'cli.bat interactive', 'cli.bat resource import --help --format text'],
    };
  }
  const helpFields = Object.fromEntries(spec.fields.map(key => [key, { ...fields[key], option: optionName(key) }]));
  if (helpFields.id) helpFields.id.description = '本命令目标 ID；类型见示例';
  if (name.startsWith('semantic ') && helpFields.id) helpFields.id.description = '共享标签 UUID；不是资源或片元 ID';
  if (name.startsWith('recall ') && helpFields.id) helpFields.id.description = '资源resourceId或已返回的片元ID；不是组织ID、sessionId或projectId';
  if (!name.startsWith('transcript ') && helpFields.source) helpFields.source.description = name.startsWith('tag ') || name.startsWith('organize ') ? '决定来源：manual/codex/automatic' : '原始来源说明';
  if (name === 'transcript configure') helpFields.alias.description = '修改实例别名；定位必须使用id';
  if (name.startsWith('project-track ') && name !== 'project-track read' && helpFields.entryId) helpFields.entryId.description = '历史兼容参数；本命令忽略此字段';
  if (name === 'project-track list') helpFields.projectId.description = '历史兼容参数；list 返回全部项目，不使用此字段过滤';
  const required = [...(spec.required ?? []), ...(spec.oneOf ?? []).map(keys => keys.join('或'))];
  // 复杂参数使用 JSON 文件示例，避免不同 shell 的引号规则造成误执行。
  const complex = Object.values(spec.example).some(value => value !== null && typeof value === 'object');
  const exampleCommand = complex ? `cli.bat ${name} --input input.json` : `cli.bat ${name}` + Object.entries(spec.example).map(([key, value]) => ` ${optionName(key)} ${quoteArgument(value)}`).join('');
  return { version: CLI_VERSION, command: name, description: spec.description, behavior: spec.behavior, fields: helpFields, required, oneOf: spec.oneOf ?? [], globalOptions,
    usage: `cli.bat ${name} [options]`, inputPrecedence: '命令行覆盖JSON；执行预算覆盖实例；retry策略来自冻结任务',
    example: spec.example, exampleCommand, ...(complex ? { exampleFile: 'input.json' } : {}),
    commonErrors: ['INVALID_ARGUMENT：检查必填项、类型及拼写', 'SERVICE_OFFLINE：启动相同数据目录的服务', '版本冲突：重新读取当前版本后合并修改'],
    output: '默认单JSON，退出码0/1/2；--format text 显示可读文本。检查业务complete/status及warnings。help不连接服务、不运行模型。' };
}
