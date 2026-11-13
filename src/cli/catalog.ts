/** 命令元数据用于离线帮助、参数校验及交互提示；业务值域仍由所属模块核验。 */
export type Field = { type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'strings'; description: string; default?: unknown; nullable?: boolean };
export type Command = { fields: string[]; description: string; behavior: string; example: Record<string, unknown>; required?: string[]; oneOf?: string[][] };
export const extraFields: Record<string, Field> = {};
export const extraCommands: Record<string, Command> = {};
function field(names: string, type: Field['type'], description: string) {
  for (const name of names.split(' ')) extraFields[name] = { type, description };
}
function command(name: string, fields: string, description: string, behavior: string, example: Record<string, unknown> = {}, required = '', oneOf?: string[][]) {
  extraCommands[name] = { fields: fields.split(' ').filter(Boolean), description, behavior, example, required: required.split(' ').filter(Boolean), oneOf };
}
const READ = '只读；不调用生成模型';
const WRITE = '写入当前知识库；不调用生成模型';
const RUN = '按配置执行任务；可能写入数据及消耗模型额度，请检查 complete/status';
field('file', 'string', '本机文件路径；包含空格时使用双引号');
field('text title originalName jobId type pluginId handlerPluginId resourceId tagId candidateId parentId entryId requestId recordedAt role projectVersion stage asOfVersion reason tagMatch time now target taskType agentProfile scoringLogicVersion providerId model credentialEnv reasoning reasoningEffort prompt', 'string', '命令字段；含义及有效值见命令示例和业务说明');
field('expectedContentVersion schemaVersion contentVersion tagRevision maxTasks maxBatchSize timeoutMs maxTokens port lines', 'integer', '非负整数；版本字段用于并发校验');
field('temperature maxCost order', 'number', '有限数值；业务值域由命令核验');
field('copy cascade includeDeleted content stdin includeResolved accepted includeBaseline noOpen', 'boolean', 'true/false；不带值时为 true');
field('data config node replaces params schedule schema', 'object', 'JSON 对象；通过 --input 文件或 stdin 传入');
field('references nodes messages', 'array', 'JSON 数组；通过 --input 文件或 stdin 传入');
field('ids aliases filename body keywords tags systems parseStatus', 'strings', '字符串数组；兼容逗号分隔文本');
extraFields.agentProfile.nullable = true;
extraFields.port.description = '监听端口 0–65535；0 自动分配';
extraFields.lines.description = '日志末尾行数 1–1000，默认 50';
extraFields.lines.default = 50;
extraFields.role.description = 'baseline/state/change/decision/verification';
extraFields.stage.description = 'planned/confirmed/implemented/verified';
extraFields.tagMatch.description = 'any/all，默认 any';
extraFields.schedule.description = '周期对象：{kind:"interval",minutes:30} 或 {kind:"cron",expression:"0 3 * * *",timezone:"Asia/Shanghai"}';
extraFields.credentialEnv.description = '凭证环境变量名称；不要传入密钥值';
const descriptions: Record<string, string> = {
  text: '正文或检索文本', title: '显示标题', originalName: '导入时记录的原始文件名', type: '组织方式 ID',
  pluginId: '插件 ID，例如 tags', handlerPluginId: '已有处理插件 ID；登记方式不会安装插件', resourceId: '资源 UUID', tagId: '标签 UUID',
  candidateId: 'organize candidates 返回的候选 ID', parentId: '父节点 ID', entryId: '项目记录条目 ID', jobId: 'cron list 返回的计划 ID；省略查询全部运行记录',
  requestId: '幂等请求标识；相同标识须使用相同内容', recordedAt: '带时区的 ISO 记录时间', projectVersion: '业务项目版本，例如 0.0.14',
  asOfVersion: '查询截止的项目版本', reason: '人工或 Agent 决策依据', time: '每日执行时间 HH:mm', now: '显式执行时间；带时区 ISO',
  target: '任务目标 ID；由 cron types 定义', taskType: 'cron types 返回的任务类型，例如 organizer.run',
  agentProfile: '模型配置 ID；null 清除', scoringLogicVersion: '评分逻辑版本标识', providerId: '模型提供方 ID，例如 codex-cli',
  model: '所选提供方支持的模型名称', reasoning: '推理模式 off/on', reasoningEffort: '推理强度 low/medium/high', prompt: '便捷用户提示词；与 messages 二选一',
  expectedContentVersion: '读取时的正文版本；冲突时重新读取后合并', schemaVersion: '插件元数据 schema 版本', contentVersion: '固定引用的正文版本',
  tagRevision: '标签定义版本', maxTasks: '本次最多执行任务数', maxBatchSize: '评分批大小', timeoutMs: '调用超时，毫秒', maxTokens: '生成 token 上限',
  temperature: '采样温度，值域由提供方校验', maxCost: '本次费用预算', order: '节点排序权重，允许负数',
  copy: '重复导入也创建独立副本；默认 false', cascade: '停用时连带停用依赖方；默认 false', includeDeleted: '包含回收站资源；默认 false',
  content: '同时返回正文；默认 false', stdin: '从标准输入读取记录正文；与 text/file 三选一', includeResolved: '包含已决定候选；默认 false',
  accepted: '是否接受标签归属，true/false', includeBaseline: '是否包含项目基线', noOpen: '只启动服务，不自动打开浏览器；默认 false',
  data: '业务或插件分区 JSON 对象', config: '组织方式 JSON 配置', node: '体系节点对象：title/order，可含 id/parentId/resourceId',
  replaces: '替代关系对象：entryIds、scope、effect', params: '任务参数；结构见 cron types', schema: '生成结果的 JSON Schema',
  references: '引用数组；每项含 kind、id，可含 owner', nodes: '体系完整节点数组', messages: '消息数组；每项含 role、content',
  ids: '资源 UUID 列表', aliases: '标签别名列表', filename: '文件名条件，同类条件取并集', body: '正文条件', keywords: '关键词条件',
  tags: '标签名称或 ID 列表', systems: '体系 ID 条件', parseStatus: '解析状态条件',
};
for (const [name, description] of Object.entries(descriptions)) extraFields[name].description = description;

command('up', 'port noOpen', '准备环境并启动、打开知识库', '必要时安装依赖及构建；复用已运行服务', { noOpen: true });
command('doctor', '', '检查运行环境和服务连通性', '只检查；不创建数据目录或启动服务');
command('interactive', '', '进入常用操作菜单', '仅终端可用；具体操作执行前展示说明');
for (const group of ['service', 'preview']) {
  for (const action of ['start', 'restart']) command(`${group} ${action}`, 'port', action === 'start' ? '启动或复用本地服务' : '停止后重新启动服务', '启动服务及已启用的后台计划', { port: 0 });
  command(`${group} status`, '', '查看服务运行状态', READ);
  command(`${group} stop`, '', '停止服务及后台调度', '等待正在执行的任务结束后停止');
}
command('service logs', 'lines', '读取最近的服务日志', '只读；返回有界日志尾部，不持续等待', { lines: 50 });
command('resource import', 'file copy source originalName', '导入文件', '写资源；重复导入默认复用，--copy 创建独立副本', { file: 'D:/notes/说明.md' }, 'file');
command('resource list', 'text ids includeDeleted offset limit', '查询资源列表', READ, { text: '设计', limit: 20 });
command('resource get', 'id content version', '查看资源及指定版本正文', READ, { id: '<资源UUID>', content: true }, 'id');
command('resource update', 'id file expectedContentVersion', '更新正文并保留历史', WRITE, { id: '<资源UUID>', file: 'D:/notes/说明.md', expectedContentVersion: 1 }, 'id file');
for (const action of ['delete', 'restore', 'purge', 'history']) command(`resource ${action}`, 'id', ({ delete: '移入回收站', restore: '恢复资源', purge: '永久清理已回收且无引用的资源', history: '查看资源历史版本' })[action]!, action === 'history' ? READ : WRITE, { id: '<资源UUID>' }, 'id');
command('meta get', 'id', '读取资源及插件元数据', READ, { id: '<资源UUID>' }, 'id');
command('meta set', 'id pluginId data schemaVersion expectedRevision expectedContentVersion references', '更新资源插件分区', WRITE, { id: '<资源UUID>', pluginId: '<插件ID>', data: {} }, 'id pluginId');
command('organization create', 'type name data references pluginId', '创建组织实例', WRITE, { type: 'reading-list', name: '阅读清单' }, 'type name');
command('organization list', 'type', '列出组织实例', READ);
command('organization get', 'id', '读取组织实例', READ, { id: '<组织UUID>' }, 'id');
command('organization update', 'id name data references expectedRevision', '修改组织实例', WRITE, { id: '<组织UUID>', name: '新名称', expectedRevision: 1 }, 'id');
command('organization delete', 'id', '删除组织实例', WRITE, { id: '<组织UUID>' }, 'id');
command('organization-type register', 'id name description handlerPluginId config enabled', '登记组织方式定义', WRITE, { id: 'reading-list', name: '阅读清单' }, 'id name');
command('organization-type list', '', '列出组织方式定义', READ);
command('organization-type update', 'id name description config enabled expectedRevision', '修改组织方式定义', WRITE, { id: 'reading-list', name: '书单' }, 'id');
for (const action of ['get', 'enable', 'disable', 'delete']) command(`organization-type ${action}`, 'id' + (['enable', 'disable'].includes(action) ? ' expectedRevision' : ''), `${action} 组织方式定义`, action === 'get' ? READ : WRITE, { id: 'reading-list' }, 'id');
command('plugin list', '', '列出插件状态和依赖', READ);
command('plugin refresh', '', '刷新插件派生任务', WRITE);
for (const action of ['enable', 'disable']) command(`plugin ${action}`, 'id cascade', `${action === 'enable' ? '启用' : '停用'}插件`, '改变插件状态；cascade 可连带停用依赖方', { id: '<插件ID>' }, 'id');
for (const name of ['backup', 'restore']) command(name, 'file', name === 'backup' ? '备份知识库到外部文件' : '将备份恢复到空知识库', name === 'backup' ? '写备份文件；路径须在数据目录外' : '写入空库；恢复后计划默认停用', { file: 'D:/backups/knowledge.backup.json' }, 'file');
command('check', '', '检查数据一致性', READ);
command('reindex', '', '重新生成核心派生索引', WRITE);
command('note add', 'text file stdin title tags requestId source projectDir recordedAt', '新增自由记录', WRITE, { text: '今天的记录', title: '工作笔记' }, '', [['text', 'file', 'stdin']]);
command('note list', 'includeDeleted', '列出自由记录', READ);
command('note get', 'id', '读取自由记录正文', READ, { id: '<资源UUID>' }, 'id');
for (const group of ['content', 'keyword']) {
  command(`${group} get`, 'id', group === 'content' ? '查看解析正文' : '查看资源关键词', READ, { id: '<资源UUID>' }, 'id');
  command(`${group} extract`, 'id', group === 'content' ? '重新解析正文' : '重新提取关键词', WRITE, { id: '<资源UUID>' }, 'id');
}
command('keyword list', '', '列出关键词词表', READ);
command('tag list', '', '列出标签', READ);
command('tag get', 'id', '通过名称或 ID 查找标签', READ, { id: '设计' }, 'id');
command('tag create', 'name aliases description', '创建标签', WRITE, { name: '设计' }, 'name');
command('tag update', 'id name aliases description', '修改标签', WRITE, { id: '<标签UUID>', name: '新名称' }, 'id');
command('tag delete', 'id', '删除标签', WRITE, { id: '<标签UUID>' }, 'id');
command('tag clear', 'resourceId tagId', '清除资源标签决定', WRITE, { resourceId: '<资源UUID>', tagId: '<标签UUID>' }, 'resourceId tagId');
command('tag decide', 'resourceId tagId accepted source reason contentVersion tagRevision', '提交资源标签归属决定', WRITE, { resourceId: '<资源UUID>', tagId: '<标签UUID>', accepted: true, source: 'manual', reason: '阅读原文后确认', contentVersion: 1, tagRevision: 1 }, 'resourceId tagId accepted source reason contentVersion tagRevision');
command('system list', '', '列出体系', READ);
command('system get', 'id', '查看体系节点', READ, { id: '<体系UUID>' }, 'id');
command('system create', 'name description', '创建体系', WRITE, { name: '技术体系' }, 'name');
command('system update', 'id name description nodes', '更新体系及节点', WRITE, { id: '<体系UUID>', name: '新名称' }, 'id');
command('system add-node', 'id node title parentId resourceId order', '添加体系节点', WRITE, { id: '<体系UUID>', node: { title: '第一章', order: 0 } }, 'id');
command('system delete', 'id', '删除体系', WRITE, { id: '<体系UUID>' }, 'id');
command('relation get', 'id', '查看资源相关性评分', READ, { id: '<资源UUID>' }, 'id');
for (const action of ['providers', 'get-config']) command(`relation ${action}`, '', '查看评分器或评分配置', READ);
command('relation configure', 'mode agentProfile scoringLogicVersion maxBatchSize', '配置相关性评分', WRITE, { mode: 'offline' });
command('relation score', 'id keywords maxCalls', '计算资源相关性', RUN, { id: '<资源UUID>', maxCalls: 0 }, 'id');
const budget = 'maxTasks maxDurationMs maxCalls maxCost';
command('task list', '', '查看任务队列', READ);
command('task run', budget, '执行队列中的任务', RUN, { maxCalls: 0 });
command('task retry', 'id', '重新排队失败任务', WRITE, { id: '<任务UUID>' }, 'id');
command('organize query', 'tagMatch filename body keywords tags systems parseStatus offset limit', '按组合条件检索资源', READ, { filename: ['设计'], limit: 20 });
command('organize candidates', 'includeResolved resourceId', '列出待决定的标签候选', READ);
command('organize material', 'id', '读取候选依据材料', READ, { id: '<候选ID>' }, 'id');
command('organize submit', 'candidateId accepted reason source contentVersion tagRevision', '提交候选归属决定', WRITE, { candidateId: '<候选ID>', accepted: true, reason: '阅读原文确认', source: 'manual' }, 'candidateId accepted reason');
command('organize run', budget, '执行整理任务', RUN, { maxCalls: 0 });
command('organize reconcile', '', '核对并生成整理任务', WRITE);
command('schedule get', '', '读取兼容周期配置', READ);
command('schedule configure', 'enabled time timezone ' + budget, '配置整理周期', WRITE, { enabled: false, time: '03:00', timezone: 'Asia/Shanghai' });
for (const action of ['tick', 'run']) command(`schedule ${action}`, 'now', action === 'tick' ? '执行到期整理计划' : '主动执行整理计划', RUN);
command('project-track create', 'name description', '创建项目记录组织', WRITE, { name: '示例项目' }, 'name');
command('project-track list', '', '列出项目记录组织', READ);
command('project-track get', 'projectId', '读取项目记录组织', READ, { projectId: '<项目UUID>' }, 'projectId');
command('project-track add', 'projectId resourceId title role projectVersion stage contentVersion recordedAt tags replaces requestId', '追加固定版本的项目记录', WRITE, { projectId: '<项目UUID>', resourceId: '<资源UUID>', title: '设计基线', role: 'baseline', projectVersion: '0.0.14', stage: 'confirmed' }, 'projectId resourceId title role projectVersion stage');
for (const action of ['documents', 'query']) command(`project-track ${action}`, 'projectId asOfVersion tags keywords includeBaseline offset limit', '检索项目记录', READ, { projectId: '<项目UUID>' }, 'projectId');
command('project-track read', 'projectId entryId asOfVersion', '读取项目记录的固定原文', READ, { projectId: '<项目UUID>', entryId: '<条目UUID>' }, 'projectId entryId');
// 旧接入统一传递 projectId/entryId；保留已验证的只读调用形态。
for (const action of ['list', 'get', 'documents', 'query']) {
  const spec = extraCommands['project-track ' + action];
  for (const name of ['projectId', 'entryId']) if (!spec.fields.includes(name)) spec.fields.push(name);
}
for (const name of ['agent status', 'agent profile list', 'agent config get']) command(name, '', '查看模型配置及状态', READ);
command('agent profile get', 'id', '查看指定或默认模型配置', READ);
const profileFields = 'id providerId model credentialEnv timeoutMs maxTokens temperature reasoning reasoningEffort expectedRevision';
for (const name of ['agent profile set', 'agent config set']) command(name, profileFields, '保存非秘密模型配置', WRITE, { id: 'codex-session', expectedRevision: 1, timeoutMs: 60000 }, 'id');
command('agent profile delete', 'id', '删除模型配置', WRITE, { id: '<配置ID>' }, 'id');
for (const action of ['text', 'object']) command(`agent generate ${action}`, 'profile messages prompt timeoutMs maxTokens temperature reasoning' + (action === 'object' ? ' schema' : ''), '显式调用模型生成' + (action === 'text' ? '文本' : '结构化对象'), '会消耗模型额度；不自动回退', { prompt: '返回简短问候', ...(action === 'object' ? { schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'], additionalProperties: false } } : {}) }, action === 'object' ? 'schema' : '', [['messages', 'prompt']]);
command('cron types', '', '查看支持的计划任务类型', READ);
command('cron list', 'offset limit', '列出计划任务', READ);
command('cron get', 'id', '查看计划任务', READ, { id: '<计划UUID>' }, 'id');
command('cron runs', 'jobId offset limit', '查看计划执行记录', READ, { jobId: '<计划UUID>' });
command('cron create', 'taskType target params schedule enabled', '创建周期计划', WRITE, { taskType: 'organizer.run', schedule: { kind: 'interval', minutes: 30 }, enabled: false }, 'taskType schedule');
command('cron update', 'id expectedRevision taskType target params schedule enabled', '修改周期计划', WRITE, { id: '<计划UUID>', expectedRevision: 1, enabled: false }, 'id expectedRevision');
for (const action of ['enable', 'disable', 'delete']) command(`cron ${action}`, 'id expectedRevision', `${action} 周期计划`, WRITE, { id: '<计划UUID>', expectedRevision: 1 }, 'id expectedRevision');
for (const action of ['run', 'retry']) command(`cron ${action}`, 'id', action === 'run' ? '立即执行计划' : '重试失败的运行记录', RUN, { id: action === 'run' ? '<计划UUID>' : '<运行UUID>' }, 'id');
