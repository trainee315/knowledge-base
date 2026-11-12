import type { CoreManager } from '../core/manager.js';
import { assert } from '../core/errors.js';
import { UUID_PATTERN } from '../core/schema.js';
import type { Organization, ResourceMeta } from '../contracts/index.js';
import type { Candidate } from '../plugins/organizer/index.js';
import type { Task } from '../plugins/tasks/index.js';
import type { Job } from '../plugins/cron/store.js';
import { PROJECT_TYPE } from '../plugins/project-tracking/validation.js';
import { savedProfiles } from './plugin-detail-config.js';
import type { PluginRouteContext } from './plugin-routes.js';

interface Item { id: string; label: string; summary?: string; href?: string }
interface Page { items: Item[]; total: number; offset: number; limit: number }
interface Collection {
  id: string;
  label: string;
  load(manager: CoreManager, context: PluginRouteContext, offset: number, limit: number): Promise<Page>;
}
interface PluginDetailDefinition {
  name: string;
  description: string;
  maintains: string;
  collections: Collection[];
}

const resourceHref = (id: string) => UUID_PATTERN.test(id) ? '#resource/' + id : undefined;
const browseHref = (type: string, id: string) => '#browse?' + new URLSearchParams({ type, id });
const scheduleHref = '#plugins?id=cron&view=config';
const taskStates: Record<string, string> = { pending: '待执行', running: '运行中', completed: '已完成', failed: '失败', decided: '已处理', protected: '受保护', succeeded: '成功', partial: '未完成', interrupted: '中断' };
const parseStates: Record<string, string> = { parsed: '已解析', failed: '解析失败', unsupported: '格式不支持' };
const stateLabel = (table: Record<string, string>, value: unknown) => typeof value === 'string' && Object.hasOwn(table, value) ? table[value] : '状态未知';

function page(items: Item[], offset: number, limit: number): Page {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

function collection(id: string, label: string, rows: (manager: CoreManager, context: PluginRouteContext) => Promise<Item[]>): Collection {
  return { id, label, async load(manager, context, offset, limit) { return page(await rows(manager, context), offset, limit); } };
}

function resourceCollection(plugin: string, label: string, summarize: (resource: ResourceMeta) => string): Collection {
  return collection('resources', label, async manager => (await manager.listResources()).flatMap(({ resource }) => {
    if (!Object.hasOwn(resource.plugins, plugin)) return [];
    return [{ id: resource.id, label: resource.originalName, summary: summarize(resource), href: resourceHref(resource.id) }];
  }));
}

function organizations(type: string, id: string, label: string, summarize?: (organization: Organization) => string): Collection {
  return collection(id, label, async manager => (await manager.listOrganizations(type)).map(org => ({
    id: org.id, label: org.name, summary: summarize?.(org) ?? '版本 ' + org.revision,
    href: type === 'session-transcript' ? '#browse?' + new URLSearchParams({ type, instance: org.id, view: 'config' }) : browseHref(type, org.id),
  })));
}

async function cronQuery<T>(context: PluginRouteContext, words: string[], input: Record<string, unknown> = {}): Promise<T> {
  const result = await context.cron.command(words, input);
  assert(result.handled, 'PLUGIN_UNAVAILABLE', '调度数据不可用');
  return result.data as T;
}

function cronCollection<T>(id: string, label: string, action: string, project: (row: T) => Item): Collection {
  return {
    id, label,
    async load(_manager, context, offset, limit) {
      const data = await cronQuery<{ items: T[]; total: number }>(context, ['cron', action], { offset, limit });
      return { items: data.items.map(project), total: data.total, offset, limit };
    },
  };
}

function count(value: unknown): number { return Array.isArray(value) ? value.length : 0; }

/** 每种数据集合由插件专用投影生成，不透传文件、正文、任务输入或模型结果。 */
export const detailDefinitions: ReadonlyMap<string, PluginDetailDefinition> = new Map([
  ['agent', {
    name: 'Agent 基础设施', description: '为转录与关系评分等插件提供受控的模型文本和结构化输出。',
    maintains: '模型配置及生成参数。',
    collections: [collection('profiles', '模型配置', async manager => (await savedProfiles(manager)).map(profile => ({
      id: profile.id, label: profile.id, summary: profile.model,
      href: '#plugins?' + new URLSearchParams({ id: 'agent', view: 'config', configKey: profile.id }),
    })))],
  }],
  ['content', {
    name: '内容解析', description: '提取支持格式中的正文与 Markdown 引用，并保留原始文件。',
    maintains: '资源的内容解析状态及版本。',
    collections: [resourceCollection('content', '解析过的资源', resource => stateLabel(parseStates, resource.plugins.content.data.status) + ' · 内容版本 ' + resource.contentVersion)],
  }],
  ['keywords', {
    name: '关键词', description: '从可解析的资源提取关键词，供搜索与整理使用。',
    maintains: '各资源的关键词结果与索引。',
    collections: [resourceCollection('keywords', '提取过关键词的资源', resource => count(resource.plugins.keywords.data.items) + ' 个关键词')],
  }],
  ['tags', {
    name: '标签', description: '管理标签、别名和资源归属决策。',
    maintains: '标签定义与资源标注。',
    collections: [organizations('tag', 'tags', '标签定义', org => count(org.data.aliases) + ' 个别名'), resourceCollection('tags', '已标注资源', resource => count(resource.plugins.tags.data.decisions) + ' 项标注决策')],
  }],
  ['relations', {
    name: '关系评分', description: '按可配置的评分逻辑评估标签和关键词的相关性。',
    maintains: '按标签保存的评分记录与覆盖情况。',
    collections: [collection('scores', '已保存评分的标签', async manager => {
      const labels = new Map((await manager.listOrganizations('tag')).map(org => [org.id, org.name]));
      return (await manager.pluginStore('relations').list()).filter(id => UUID_PATTERN.test(id)).sort().map(id => ({
        id, label: labels.get(id) ?? '已移除的标签', summary: '已保存关系评分',
        ...(labels.has(id) ? { href: browseHref('tag', id) } : {}),
      }));
    })],
  }],
  ['tasks', {
    name: '任务队列', description: '记录业务处理任务的进度，并在预算内执行和重试。',
    maintains: '业务任务的类型、状态和重试次数。',
    collections: [collection('queue', '业务任务', async manager => (await manager.pluginStore('tasks').read<Task[]>('queue', [])).map(task => ({
      id: task.id, label: task.type, summary: stateLabel(taskStates, task.status) + ' · ' + task.attempts + ' 次尝试',
    })))],
  }],
  ['organizer', {
    name: '知识库整理', description: '将内容、关键词、评分和标签决策组合为可审核的整理候选。',
    maintains: '标签归属候选及审核状态。',
    collections: [collection('candidates', '整理候选', async manager => {
      const candidates = await manager.pluginStore('organizer').read<Candidate[]>('candidates', []);
      const resources = new Map((await manager.listResources()).map(({ resource }) => [resource.id, resource.originalName]));
      return candidates.map(candidate => ({
        id: candidate.id, label: resources.get(candidate.resourceId) ?? '整理候选', summary: stateLabel(taskStates, candidate.status),
        ...(resources.has(candidate.resourceId) ? { href: resourceHref(candidate.resourceId) } : {}),
      }));
    })],
  }],
  ['scheduler', {
    name: '夜间整理', description: '提供旧整理调度命令的兼容入口，周期由定时任务插件管理。',
    maintains: '整理计划及最近一次执行状态。',
    collections: [collection('schedule', '整理计划', async (_manager, context) => {
      for (let offset = 0; ; offset += 100) {
        const jobs = await cronQuery<{ items: Job[]; total: number }>(context, ['cron', 'list'], { offset, limit: 100 });
        const plan = jobs.items.find(job => job.taskType === 'organizer.run');
        if (plan) {
          const history = await cronQuery<{ items: { startedAt: number }[] }>(context, ['cron', 'runs'], { jobId: plan.id, limit: 1 });
          const last = history.items[0];
          return [{ id: plan.id, label: '知识库整理', summary: (plan.enabled ? '已启用' : '已停用') + (last ? ' · 最近执行 ' + new Date(last.startedAt).toISOString() : ''), href: scheduleHref }];
        }
        if (offset + 100 >= jobs.total) return [];
      }
    })],
  }],
  ['systems', {
    name: '知识体系', description: '以有序节点和资源引用组织知识。',
    maintains: '知识体系及其节点。',
    collections: [organizations('system', 'systems', '知识体系', org => count(org.data.nodes) + ' 个节点')],
  }],
  ['project-tracking', {
    name: '项目开发跟踪', description: '以固定版本的原件建立项目基线、变更记录与替代声明。',
    maintains: '项目实例、基线和阶段记录。',
    collections: [organizations(PROJECT_TYPE, 'projects', '项目跟踪实例', org => count(org.data.entries) + ' 项记录')],
  }],
  ['transcripts', {
    name: 'Session 转录', description: '筛选本机对话会话并将已完成的工作转为结构化知识记录。',
    maintains: '转录实例、进度与已归档资源。',
    collections: [organizations('session-transcript', 'instances', '转录实例', org => count(org.data.entries) + ' 项已归档记录')],
  }],
  ['cron', {
    name: '定时任务', description: '在知识库服务中按配置触发整理与指定转录实例，并记录执行结果。',
    maintains: '任务计划、运行状态与运行历史。',
    collections: [
      cronCollection<Job>('jobs', '任务计划', 'list', job => ({
        id: job.id, label: job.taskType === 'organizer.run' ? '知识库整理' : 'Session 转录',
        summary: (job.enabled ? '已启用' : '已停用') + ' · ' + (job.schedule.kind === 'interval' ? job.schedule.minutes + ' 分钟间隔' : job.schedule.expression + ' · ' + job.schedule.timezone), href: scheduleHref,
      })),
      cronCollection<{ id: string; status: string; startedAt: number }>('runs', '运行历史', 'runs', run => ({
        id: run.id, label: stateLabel(taskStates, run.status), summary: new Date(run.startedAt).toISOString(),
      })),
    ],
  }],
]);
