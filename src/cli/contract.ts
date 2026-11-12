import { KnowledgeError } from '../core/errors.js';

type Field = { type: 'string' | 'integer' | 'boolean' | 'object' | 'array'; description: string; default?: unknown; nullable?: boolean };
type Command = { fields: string[]; description: string; behavior: string; example: Record<string, unknown> };
// CLI 与服务业务入口共用字段白名单，帮助内容与参数校验保持同源。
const fields: Record<string, Field> = {};
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

const config = 'alias source sourceRoot startDate timezone projectDir additionalDirectories includeSubdirectories include exclude enabled intervalMinutes focus profile preprocessing maxSessions maxInputBytes maxChunkBytes maxCalls maxDurationMs';
const budgets = 'maxCalls maxSessions maxInputBytes maxDurationMs';
const query = 'mode id version query task needs scope contextProjectId cwd retrievalMode rerank budgetTokens maxBytes maxFragments candidates neighbors section offset endOffset limit sort direction debug projectId snapshotFingerprint contentHash splitter';
const commands: Record<string, Command> = {};
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
for (const action of ['list', 'get']) register('semantic ' + action, 'id view query keyword offset limit', '浏览语义标签及匹配结果', '只读；view为documents/fragments/keywords', action === 'get' ? { id: '<标签UUID>', view: 'fragments' } : {});
register('semantic create', 'name description', '新增共享标签', '保存后后台匹配；不调用生成模型', { name: '性能优化', description: '游戏渲染与资源加载' });
register('semantic update', 'id name description', '修改标签含义', '仅重新匹配该标签', { id: '<标签UUID>', description: '游戏性能' });
for (const action of ['delete', 'retry']) register('semantic ' + action, 'id', action === 'delete' ? '删除标签入口并保留原文' : '重新匹配标签', '写标签状态；历史定义和原文保留', { id: '<标签UUID>' });
register('semantic retry-all', '', '重试失败的语义任务', '排队；复用成功的编码缓存', {});
register('semantic run', '', '执行一批语义任务', '写派生结果，可能调用本地编码模型', {});

export const booleanOptions = new Set(['stdin', 'json', 'help', 'copy', 'cascade', 'includeDeleted', 'content', ...Object.keys(fields).filter(key => fields[key].type === 'boolean')]);
const transport = new Set(['input', 'json', 'help', 'dataDir']);
/** 在任何业务动作前拒绝未知参数；嵌套字段及值域由所属业务继续核验。 */
export function validateCommand(words: string[], input: Record<string, unknown>): void {
  if (!['transcript', 'recall', 'semantic'].includes(words[0])) return;
  const spec = commands[words.join(' ')];
  const invalid = (message: string): never => { throw new KnowledgeError('INVALID_ARGUMENT', message, undefined, 2); };
  if (!spec) invalid('未知命令或多余位置参数：' + words.join(' '));
  for (const [key, value] of Object.entries(input)) {
    if (transport.has(key)) continue;
    if (!spec.fields.includes(key)) invalid(`未知或不适用参数 ${key}；请查看 ${words.join(' ')} --help`);
    const field = fields[key];
    if (value === null && field.nullable) continue;
    const valid = field.type === 'string' ? typeof value === 'string' && (['focus', 'description'].includes(key) || value.trim().length > 0)
      : field.type === 'integer' ? (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0
      : field.type === 'boolean' ? [true, false, 'true', 'false'].includes(value as any)
      : field.type === 'array' ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!valid) invalid(`${key} 必须为 ${field.type}，不能缺值`);
  }
}

export function commandHelp(words: string[]) {
  const name = words.join(' '), spec = commands[name];
  if (!spec) return { version: '0.0.11', usage: 'cli.bat <command> --input UTF8.json|- --data-dir path --json', commands: Object.keys(commands).filter(key => !name || name === 'help' || key.startsWith(name)), otherCommands: ['resource import/list/get/update/delete/restore/purge/history', 'note add/list/get', 'meta get/set', 'service start/stop/restart/status', 'preview start/stop/status (服务兼容入口)', 'organization create/list/get/update/delete', 'organization-type register/list/get/update/enable/disable/delete', 'plugin list/enable/disable/refresh', 'project-track create/list/get/add/documents/read/query', 'agent status|check|test / profile list|get|set|delete / config get|set / generate text|object', 'backup --file path', 'restore --file path', 'check', 'reindex', 'cron types/create/list/get/update/enable/disable/delete/run/retry/runs', 'content/keyword/tag/relation/system/task/organize/schedule (插件命令)'] };
  const helpFields = Object.fromEntries(spec.fields.map(key => [key, { ...fields[key] }]));
  if (name.startsWith('semantic ') && helpFields.id) helpFields.id.description = '共享标签 UUID；不是资源或片元 ID';
  if (name.startsWith('recall ') && helpFields.id) helpFields.id.description = '资源resourceId或已返回的片元ID；不是组织ID、sessionId或projectId';
  if (name === 'transcript configure') helpFields.alias.description = '修改实例别名；定位必须使用id';
  const required = name === 'semantic create' ? ['name'] : ['semantic get', 'semantic update', 'semantic delete', 'semantic retry'].includes(name) ? ['id'] : name === 'transcript create' ? ['alias', 'startDate'] : name === 'transcript configure' ? ['id'] : name === 'recall configure' ? ['expectedRevision', 'projects'] : name === 'transcript backfill' ? ['id或alias', 'from'] : name.startsWith('transcript ') && !['list', 'tick'].includes(words[1]) ? ['id或alias'] : name === 'recall read' ? ['id', '确定的项目范围'] : [];
  return { command: name, description: spec.description, behavior: spec.behavior, fields: helpFields, required, inputPrecedence: '命令行覆盖JSON；执行预算覆盖实例；retry策略来自冻结任务', example: spec.example, output: '单JSON，退出码0/1/2；检查业务complete/status及warnings。help不连接服务、不运行模型。' };
}
