import { createHash } from 'node:crypto';
import { defaultProfiles, DEFAULT_PROFILE_ID, validateProfile } from '../agent/profiles.js';
import type { AgentProfile } from '../agent/types.js';
import { assert, KnowledgeError } from '../core/errors.js';
import type { CoreManager } from '../core/manager.js';
import { DEFAULT_RELATION_CONFIG, type RelationConfig } from '../plugins/relations/index.js';
import { UUID_PATTERN } from '../core/schema.js';
import { configureTranscript, transcriptDetail } from '../records/transcript.js';

type Value = string | number | boolean | null;
export type Values = Record<string, Value>;
interface Choice { value: string; label: string; description?: string }
interface Field {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: Choice[];
  description?: string;
}
interface Form {
  kind: 'form';
  editable: boolean;
  fields: Field[];
  values: Values;
  configVersion: string;
  key?: string;
  choices?: Choice[];
  choicesLabel?: string;
  message?: string;
}
export type Configuration = Form | { kind: 'none' | 'link' | 'cron'; editable: boolean; message?: string; href?: string };

const FORM_IDS = new Set(['agent', 'relations', 'project-tracking']);
// 模式说明与实例字段同源，二进制基础清理在三种模式中始终生效。
const COMPRESSION_MODES: Choice[] = [
  { value: 'off', label: '基础清理（off）', description: '保留其余文字，仅剥离二进制和编码载荷。' },
  { value: 'conservative', label: '保守压缩（conservative）', description: '清理工具包装、成功流水和重复输出，保留其余文字。' },
  { value: 'aggressive', label: '激进压缩（aggressive）', description: '进一步节选工具材料，保留命令、关键条件和失败诊断，输入更小。' },
];
const MODE_OPTIONS = [{ value: 'offline', label: '离线评分' }, { value: 'agent', label: '模型评分' }];
const AGENT_FIELDS: Field[] = [
  { key: 'model', label: '模型', type: 'text' },
  { key: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  { key: 'maxTokens', label: '最大输出 token', type: 'number' },
  { key: 'temperature', label: '温度', type: 'number' },
  { key: 'reasoning', label: '推理模式', type: 'select', options: [{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }] },
];

export const hasForm = (id: string) => FORM_IDS.has(id);

export async function savedProfiles(manager: CoreManager): Promise<AgentProfile[]> {
  const state = await manager.pluginStore('agent').read<{ profiles: AgentProfile[] }>('profiles', { profiles: defaultProfiles() });
  if (!Array.isArray(state?.profiles)) return [];
  return state.profiles.filter(profile => {
    try { validateProfile(profile); return true; }
    catch { return false; }
  });
}

const version = (values: unknown) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

function agentForm(profiles: AgentProfile[], key: string | undefined, editable: boolean): Configuration {
  const selected = key ?? (profiles.some(profile => profile.id === DEFAULT_PROFILE_ID) ? DEFAULT_PROFILE_ID : profiles[0]?.id);
  const profile = profiles.find(profile => profile.id === selected);
  if (!profile) {
    assert(!key, 'NOT_FOUND', '模型配置不存在');
    return { kind: 'none', editable: false, message: '没有可显示的模型配置。' };
  }
  const { id, revision, model, timeoutMs, maxTokens, temperature, reasoning } = profile;
  return {
    kind: 'form', editable, fields: AGENT_FIELDS,
    values: { model, timeoutMs, maxTokens, temperature, reasoning }, key: id,
    choices: profiles.map(profile => ({ value: profile.id, label: profile.id })),
    configVersion: version([id, revision, model, timeoutMs, maxTokens, temperature, reasoning, profile.providerId, profile.credentialEnv]),
    message: '供应商和凭证环境变量引用通过 CLI 管理。',
  };
}

/** 只投影可编辑字段，凭证引用与模型运行资料保留在服务端。 */
export async function pluginConfiguration(manager: CoreManager, id: string, editable: boolean, key?: string): Promise<Configuration> {
  if (id === 'agent') return agentForm(await savedProfiles(manager), key, editable);
  if (id === 'project-tracking') {
    assert(key === undefined || UUID_PATTERN.test(key), 'INVALID_ARGUMENT', 'Session实例标识无效');
    const instances = await manager.listOrganizations('session-transcript');
    const selected = instances.find(instance => instance.id === (key ?? instances[0]?.id));
    if (!selected) {
      assert(!key, 'NOT_FOUND', 'Session实例不存在');
      return { kind: 'link', editable: false, href: '#browse?type=session-transcript', message: '请先创建Session转录实例，再配置压缩模式。' };
    }
    const instance = transcriptDetail(selected);
    return {
      kind: 'form', editable: editable && !instance.status.running, key: selected.id,
      choicesLabel: 'Session实例', choices: instances.map(item => ({ value: item.id, label: item.name })),
      fields: [{ key: 'preprocessing', label: 'Session压缩模式', type: 'select', options: COMPRESSION_MODES, description: '各模式均以原始路径替换二进制和编码载荷。作用于所选实例后续新建任务。' }],
      values: { preprocessing: instance.config.preprocessing ?? 'conservative' },
      configVersion: version([selected.id, selected.revision]),
      message: instance.status.running ? '此Session实例正在转录，执行结束后刷新页面即可编辑。' : editable ? '选择Session实例，设置其转录输入压缩模式。' : '编辑需project-tracking与Session转录插件均启用并就绪。',
    };
  }
  assert(key === undefined, 'INVALID_ARGUMENT', '此插件没有可选择的配置');
  if (id === 'relations') {
    const config = await manager.pluginStore('relations').read<RelationConfig>('config', DEFAULT_RELATION_CONFIG);
    if (!config || config.schemaVersion !== 1 || !['offline', 'agent'].includes(config.mode) || typeof config.scoringLogicVersion !== 'string' || !Number.isSafeInteger(config.maxBatchSize) || config.agentProfile !== undefined && typeof config.agentProfile !== 'string') {
      return { kind: 'none', editable: false, message: '当前评分配置不可读取。' };
    }
    const profiles = await savedProfiles(manager);
    const options = [{ value: '', label: '使用默认模型配置' }, ...profiles.map(profile => ({ value: profile.id, label: profile.id }))];
    if (config.agentProfile && !options.some(option => option.value === config.agentProfile)) options.push({ value: config.agentProfile, label: config.agentProfile });
    const fields: Field[] = [
      { key: 'mode', label: '评分模式', type: 'select', options: MODE_OPTIONS },
      { key: 'agentProfile', label: '模型配置', type: 'select', options },
      { key: 'scoringLogicVersion', label: '评分逻辑版本', type: 'text' },
      { key: 'maxBatchSize', label: '最大批量', type: 'number' },
    ];
    const values = { mode: config.mode, agentProfile: config.agentProfile ?? '', scoringLogicVersion: config.scoringLogicVersion, maxBatchSize: config.maxBatchSize };
    return { kind: 'form', editable, fields, values, configVersion: version(values) };
  }
  if (id === 'cron') return { kind: 'cron', editable, message: '管理任务计划并查看运行历史。' };
  if (id === 'scheduler') return { kind: 'link', editable: false, href: '#plugins?id=cron&view=config', message: '整理任务的周期和预算在定时任务插件中配置。' };
  if (id === 'transcripts') return { kind: 'link', editable: false, href: '#browse?type=session-transcript', message: '从转录组织中选择实例，编辑其配置。' };
  return { kind: 'none', editable: false, message: '此插件没有独立配置项。' };
}

interface ConfigApp {
  manager: CoreManager;
  plugins: { execute(command: string, input: Record<string, unknown>, args?: string[]): Promise<unknown> };
}

export async function savePluginConfig(app: ConfigApp, id: string, configuration: Configuration, expected: string, values: Record<string, unknown>): Promise<void> {
  assert(configuration.kind === 'form' && configuration.editable, 'PLUGIN_UNAVAILABLE', '此插件配置当前不可编辑');
  assert(configuration.configVersion === expected, 'CONFIG_CONFLICT', '配置已被修改，请核对最新配置后重试');
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = configuration.fields.find(item => item.key === key);
    assert(field, 'INVALID_ARGUMENT', '配置包含未知字段');
    const valid = field.type === 'select' ? typeof value === 'string' && field.options?.some(option => option.value === value)
      : field.type === 'text' ? typeof value === 'string' && value.trim() !== '' && value.length <= 128
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === 'boolean';
    assert(valid, 'INVALID_ARGUMENT', '配置字段值无效');
    if (value !== configuration.values[key]) changed[key] = value;
  }
  if (!Object.keys(changed).length) return;
  if (id === 'agent') {
    const selected = (await savedProfiles(app.manager)).find(profile => profile.id === configuration.key);
    assert(selected, 'CONFIG_CONFLICT', '模型配置已删除，请刷新后重试');
    await app.plugins.execute('agent profile set', { ...changed, id: selected.id, expectedRevision: selected.revision });
    return;
  }
  if (id === 'project-tracking') {
    const selected = await app.manager.getOrganization(configuration.key!);
    await configureTranscript(app.manager, selected, { ...changed, expectedRevision: selected.revision });
    return;
  }
  if (id === 'relations') {
    if (changed.agentProfile === '') changed.agentProfile = null;
    await app.plugins.execute('relation configure', changed);
    return;
  }
  throw new KnowledgeError('INVALID_ARGUMENT', '此插件没有独立配置项');
}
