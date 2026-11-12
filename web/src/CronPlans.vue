<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { DETAIL_PAGE_SIZE, PluginRequestError, pluginHash, pluginRequest, type Page } from './plugin-detail';

interface TaskType { id: string; title: string; parameterNames: string[] }
interface Target { id: string; name: string }
type Schedule = { kind: 'interval'; minutes: number } | { kind: 'cron'; expression: string; timezone: string };
interface Job {
  id: string;
  taskType: string;
  target?: string;
  params: Record<string, number>;
  schedule: Schedule;
  enabled: boolean;
  revision: number;
  nextRunAt: number | null;
}
interface Draft {
  taskType: string;
  target: string;
  kind: 'interval' | 'cron';
  minutes: number | '';
  expression: string;
  timezone: string;
  enabled: boolean;
  params: Record<string, number | ''>;
}
const props = defineProps<{ editable: boolean }>();
const parameterLabels: Record<string, string> = {
  maxTasks: '最多任务数', maxSessions: '最多 Session 数', maxDurationMs: '时限（毫秒）',
  maxInputBytes: '最多输入字节', maxCalls: '最多模型调用数', maxCost: '费用上限',
};
const jobs = ref<Page<Job>>();
const types = ref<TaskType[]>([]);
const targets = ref<Target[]>([]);
const targetError = ref('');
const listError = ref('');
const formError = ref('');
const notice = ref('');
const conflict = ref(false);
const latest = ref<Job>();
const selected = ref<Job>();
const draft = ref<Draft>();
const original = ref('');
const saving = ref(false);
const loading = ref(false);
const comparing = ref(false);
const abort = new AbortController();
const currentType = computed(() => types.value.find(item => item.id === draft.value?.taskType));
const isTranscript = computed(() => draft.value?.taskType === 'transcript.run');
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== original.value);
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function planPath(job: Job) { return '/api/cron/jobs/' + encodeURIComponent(job.id); }
function title(job: Job) {
  const type = types.value.find(item => item.id === job.taskType)?.title ?? job.taskType;
  const target = targets.value.find(item => item.id === job.target)?.name ?? job.target;
  return target ? type + ' · ' + target : type;
}
function describe(schedule: Schedule): string {
  return schedule.kind === 'interval' ? '每 ' + schedule.minutes + ' 分钟' : schedule.expression + ' · ' + schedule.timezone;
}
function initial(job?: Job): Draft {
  return {
    taskType: job?.taskType ?? types.value[0]?.id ?? '',
    target: job?.target ?? '',
    kind: job?.schedule.kind ?? 'interval',
    minutes: job?.schedule.kind === 'interval' ? job.schedule.minutes : 5,
    expression: job?.schedule.kind === 'cron' ? job.schedule.expression : '0 3 * * *',
    timezone: job?.schedule.kind === 'cron' ? job.schedule.timezone : 'Asia/Shanghai',
    enabled: job?.enabled ?? false,
    params: { ...job?.params },
  };
}
function discard() {
  draft.value = undefined;
  selected.value = undefined;
  latest.value = undefined;
  original.value = '';
  formError.value = '';
  conflict.value = false;
}
function edit(job?: Job) {
  if (dirty.value && !window.confirm('计划草稿尚未保存。放弃修改？')) return;
  discard();
  selected.value = job;
  draft.value = initial(job);
  original.value = JSON.stringify(draft.value);
  notice.value = '';
}
function changeType() {
  if (!draft.value) return;
  draft.value.target = '';
  draft.value.params = {};
}
async function loadJobs(offset = jobs.value?.offset ?? 0) {
  listError.value = '';
  loading.value = true;
  try {
    const params = new URLSearchParams({ offset: String(offset), limit: String(DETAIL_PAGE_SIZE) });
    const result = await pluginRequest<Page<Job>>('/api/cron/jobs?' + params, { signal: abort.signal });
    jobs.value = result;
    if (offset && !result.items.length) await loadJobs(Math.max(0, offset - DETAIL_PAGE_SIZE));
  } catch (error) { if (!abort.signal.aborted) listError.value = (error as Error).message; }
  finally { loading.value = false; }
}
onMounted(async () => {
  await Promise.all([
    loadJobs(),
    pluginRequest<TaskType[]>('/api/cron/task-types', { signal: abort.signal }).then(value => { types.value = value; })
      .catch(error => { if (!abort.signal.aborted) listError.value = error.message; }),
    pluginRequest<Target[]>('/api/transcripts', { signal: abort.signal }).then(value => { targets.value = value; })
      .catch(error => { if (!abort.signal.aborted) targetError.value = error.message; }),
  ]);
});
onUnmounted(() => abort.abort());

async function save() {
  const value = draft.value;
  const job = selected.value;
  if (!props.editable || !value || saving.value) return;
  const schedule = value.kind === 'interval'
    ? { kind: 'interval', minutes: value.minutes }
    : { kind: 'cron', expression: value.expression, timezone: value.timezone };
  const params = Object.fromEntries(Object.entries(value.params).filter(([, parameter]) => parameter !== ''));
  formError.value = '';
  saving.value = true;
  try {
    await pluginRequest<Job>(job ? planPath(job) : '/api/cron/jobs', {
      method: job ? 'PATCH' : 'POST',
      body: { taskType: value.taskType, ...(isTranscript.value ? { target: value.target } : {}), schedule, params, enabled: value.enabled, ...(job ? { expectedRevision: job.revision } : {}) },
    });
    discard();
    notice.value = '计划已保存';
    await loadJobs();
  } catch (error) {
    conflict.value = !!job && error instanceof PluginRequestError && error.status === 409 && error.code === 'CONFIG_CONFLICT';
    formError.value = (error as Error).message;
    latest.value = undefined;
  } finally { saving.value = false; }
}
async function compareLatest() {
  if (!selected.value) return;
  comparing.value = true;
  try { latest.value = await pluginRequest<Job>(planPath(selected.value), { signal: abort.signal }); }
  catch (error) { if (!abort.signal.aborted) formError.value = (error as Error).message; }
  finally { comparing.value = false; }
}
function rebase() {
  if (!latest.value || !draft.value) return;
  const base = JSON.parse(original.value) as Draft;
  const edited = draft.value;
  const next = initial(latest.value);
  const fields = ['kind', 'minutes', 'expression', 'timezone', 'enabled'] as const;
  selected.value = latest.value;
  original.value = JSON.stringify(next);
  const changes = Object.fromEntries(fields.filter(key => edited[key] !== base[key]).map(key => [key, edited[key]]));
  for (const key of Object.keys(edited.params)) {
    if (edited.params[key] !== base.params[key]) next.params[key] = edited.params[key];
  }
  draft.value = { ...next, ...changes };
  latest.value = undefined;
  conflict.value = false;
  formError.value = '';
  notice.value = '已加载最新计划并保留草稿中的修改，请核对后保存。';
}
async function changeJob(job: Job, remove: boolean) {
  if (!props.editable || saving.value || draft.value) return;
  if (remove && !window.confirm('删除此计划？已有运行历史将保留。')) return;
  saving.value = true;
  listError.value = '';
  notice.value = '';
  try {
    await pluginRequest(planPath(job), {
      method: remove ? 'DELETE' : 'PATCH',
      body: { expectedRevision: job.revision, ...(remove ? {} : { enabled: !job.enabled }) },
    });
    notice.value = remove ? '计划已删除' : job.enabled ? '计划已停用' : '计划已启用';
    await loadJobs();
  } catch (error) {
    const message = (error as Error).message;
    await loadJobs();
    listError.value = message;
  } finally { saving.value = false; }
}
defineExpose({ dirty, saving, discard });
</script>

<template>
  <div class="cron-plans">
    <div class="plugin-list-heading">
      <h3>调度计划</h3>
      <div class="plugin-actions">
        <a :href="pluginHash('cron', 'data', { collection: 'runs' })">查看运行历史</a>
        <button v-if="editable" type="button" :disabled="saving || !types.length" @click="edit()">新建计划</button>
      </div>
    </div>
    <p v-if="listError" class="error" role="alert">{{ listError }}</p>
    <p v-if="notice" class="plugin-notice" role="status">{{ notice }}</p>
    <p v-if="loading && !jobs" role="status">正在读取计划…</p>
    <p v-else-if="!jobs?.items.length && !listError" class="plugin-empty">还没有调度计划。</p>
    <ul v-else-if="jobs?.items.length" class="plugin-rows">
      <li v-for="job in jobs.items" :key="job.id" class="plugin-job">
        <div>
          <strong>{{ title(job) }}</strong>
          <p class="muted">{{ describe(job.schedule) }} · {{ job.enabled ? '已启用' : '已停用' }}<template v-if="job.nextRunAt"> · 下次 {{ timeFormat.format(job.nextRunAt) }}</template></p>
        </div>
        <div v-if="editable" class="plugin-actions">
          <button :disabled="saving || !!draft" type="button" @click="edit(job)">编辑计划</button>
          <button :disabled="saving || !!draft" type="button" @click="changeJob(job, false)">{{ job.enabled ? '停用计划' : '启用计划' }}</button>
          <button :disabled="saving || !!draft" type="button" @click="changeJob(job, true)">删除计划</button>
        </div>
      </li>
    </ul>
    <div v-if="jobs && (jobs.total > jobs.limit || jobs.offset)" class="plugin-page">
      <button :disabled="loading || !jobs.offset" type="button" @click="loadJobs(Math.max(0, jobs.offset - jobs.limit))">上一页</button>
      <span>{{ jobs.offset + 1 }}–{{ Math.min(jobs.offset + jobs.limit, jobs.total) }} / {{ jobs.total }}</span>
      <button :disabled="loading || jobs.offset + jobs.limit >= jobs.total" type="button" @click="loadJobs(jobs.offset + jobs.limit)">下一页</button>
    </div>

    <form v-if="draft && editable" class="plugin-form plugin-job-editor" @submit.prevent="save">
      <h3>{{ selected ? '编辑调度计划' : '新建调度计划' }}</h3>
      <fieldset :disabled="saving">
        <div class="plugin-fields">
          <label>任务类型
            <select v-model="draft.taskType" :disabled="!!selected" @change="changeType">
              <option v-for="type in types" :key="type.id" :value="type.id">{{ type.title }}</option>
            </select>
          </label>
          <label v-if="isTranscript">转录实例
            <select v-model="draft.target" required :disabled="!!selected">
              <option value="" disabled>选择实例</option>
              <option v-if="draft.target && !targets.some(item => item.id === draft?.target)" :value="draft.target">{{ draft.target }}</option>
              <option v-for="target in targets" :key="target.id" :value="target.id">{{ target.name }}</option>
            </select>
          </label>
          <label>周期类型
            <select v-model="draft.kind"><option value="interval">固定间隔</option><option value="cron">Cron 表达式</option></select>
          </label>
          <label v-if="draft.kind === 'interval'">间隔（分钟）<input v-model.number="draft.minutes" type="number" min="1" step="1" required></label>
          <template v-else>
            <label>Cron 表达式<input v-model.trim="draft.expression" required placeholder="0 3 * * *"></label>
            <label>调度时区<input v-model.trim="draft.timezone" required placeholder="Asia/Shanghai"></label>
          </template>
          <label v-for="key in currentType?.parameterNames" :key="key">
            {{ parameterLabels[key] ?? key }}
            <input v-model.number="draft.params[key]" type="number" :min="['maxTasks', 'maxCalls', 'maxCost'].includes(key) ? 0 : 1" :step="key === 'maxCost' ? 'any' : '1'" placeholder="沿用默认值">
          </label>
          <label class="plugin-check"><span>启用调度</span><input v-model="draft.enabled" type="checkbox"></label>
        </div>
        <p v-if="isTranscript && targetError" class="error" role="alert">{{ targetError }}</p>
        <p v-if="formError" class="error" role="alert">{{ formError }}<template v-if="conflict">。当前草稿已保留。</template></p>
        <div v-if="conflict" class="plugin-compare">
          <button type="button" :disabled="comparing" @click="compareLatest">查看最新计划</button>
          <template v-if="latest">
            <p>{{ describe(latest.schedule) }} · {{ latest.enabled ? '已启用' : '已停用' }}</p>
            <p v-for="(value, key) in latest.params" :key="key">{{ parameterLabels[key] ?? key }} {{ value }}</p>
            <button type="button" @click="rebase">以最新版本为基准保留草稿</button>
          </template>
        </div>
        <div class="plugin-actions">
          <button type="button" @click="discard">取消编辑</button>
          <button class="primary" type="submit" :disabled="conflict">{{ saving ? '保存中…' : '保存计划' }}</button>
        </div>
      </fieldset>
    </form>
  </div>
</template>
