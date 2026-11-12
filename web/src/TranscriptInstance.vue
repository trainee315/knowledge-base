<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { renderMarkdown } from '../../src/preview/markdown';

const props = defineProps<{ id: string; view: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
// 草稿与服务器修订分别保存，冲突和预览不会丢弃用户输入。
const instance = ref<any>();
const draft = ref<any>();
const profiles = ref<{ id: string; model: string; credentialConfigured: boolean }[]>([]);
const editing = ref(props.id === 'new');
const savedConfig = ref('');
const tab = ref(props.id === 'new' ? 'config' : props.view || 'overview');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const preview = ref<any>();
const previewSignature = ref('');
const mode = ref('incremental');
const from = ref('');
const to = ref('');
const documents = ref<any>({ items: [], total: 0 });
const documentQuery = ref('');
const offset = ref(0);
const detail = ref<any>();
const dirty = computed(() => Boolean(draft.value) && JSON.stringify(draft.value) !== savedConfig.value);
const cronManaged = computed(() => instance.value?.cronSchedule?.kind === 'cron');
const signature = computed(() => JSON.stringify({ config: draft.value, revision: instance.value?.revision ?? null, cronRevision: instance.value?.cronRevision, mode: mode.value, from: from.value, to: to.value }));
const requestConfig = computed(() => {
  const { enabled, intervalMinutes, ...config } = draft.value ?? {};
  return { ...config, projectDir: config.projectDir?.trim() || null, ...(cronManaged.value ? {} : { enabled, intervalMinutes: intervalMinutes === '' || intervalMinutes == null ? null : intervalMinutes }) };
});
const previewStale = computed(() => preview.value && previewSignature.value !== signature.value);
const selectedProfile = computed(() => profiles.value.find(profile => profile.id === draft.value?.profile));
const markdown = computed(() => renderMarkdown(detail.value?.content?.text ?? ''));
const budgets = [
  { key: 'maxSessions', label: '单次 Session 数', min: 1 },
  { key: 'maxInputBytes', label: '总输入字节数', min: 1 },
  { key: 'maxChunkBytes', label: '单段输入字节数', min: 1 },
  { key: 'maxCalls', label: '模型调用次数', min: 0 },
  { key: 'maxDurationMs', label: '执行时限（毫秒）', min: 1 },
];
const filterFields = [
  { key: 'sessionIds', label: 'Session ID' },
  { key: 'titleKeywords', label: '标题关键词' },
  { key: 'bodyKeywords', label: '正文关键词' },
];
let alive = true;
let reading = 0;
let listing = 0;
async function api(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? '请求失败');
  return result.data;
}
function navigate(view = tab.value, resource?: string) {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  params.set('type', 'session-transcript');
  params.set('instance', props.id);
  params.set('view', view);
  params.delete('resource');
  if (resource) params.set('resource', resource);
  const hash = '#browse?' + params.toString();
  if (hash !== location.hash) history.pushState(null, '', hash);
}
function canLeave() {
  return !dirty.value || window.confirm('配置尚未保存，是否放弃修改？');
}
defineExpose({ canLeave });
function close() { if (canLeave()) emit('close'); }
function guard(event: Event) { if (!canLeave()) event.preventDefault(); }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
function time(value: string | number | null) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚无'; }
/** 重载最新修订时合并草稿中实际修改的字段，保留其他调用方的改动。 */
function mergeDraft(base: any, local: any, latest: any): any {
  if (JSON.stringify(base) === JSON.stringify(local)) return latest;
  if (base && local && latest && typeof base === 'object' && !Array.isArray(base)) {
    return Object.fromEntries([...new Set([...Object.keys(latest), ...Object.keys(local)])].map(key => [key, mergeDraft(base[key], local[key], latest[key])]));
  }
  return local;
}
async function reload(keepDraft = false) {
  busy.value = true;
  error.value = '';
  try {
    const data = props.id === 'new' ? await api('/api/transcripts/defaults') : await api('/api/transcripts/' + props.id);
    if (!alive) return;
    instance.value = props.id === 'new' ? undefined : data;
    if (keepDraft && props.id !== 'new') {
      draft.value = mergeDraft(JSON.parse(savedConfig.value), JSON.parse(JSON.stringify(draft.value)), data.config);
      savedConfig.value = JSON.stringify(data.config);
      notice.value = '已合并最新配置并保留你的修改，请核对后保存。';
    }
    if (!keepDraft) {
      draft.value = structuredClone(props.id === 'new' ? data : data.config);
      savedConfig.value = JSON.stringify(draft.value);
      from.value = draft.value.startDate;
      editing.value = props.id === 'new';
      preview.value = undefined;
    }
  } catch (cause) { if (alive) error.value = (cause as Error).message; }
  finally { if (alive) busy.value = false; }
}
function cancel() {
  draft.value = JSON.parse(savedConfig.value);
  editing.value = props.id === 'new';
  error.value = '';
}
async function save() {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const data = await api('/api/transcripts' + (props.id === 'new' ? '' : '/' + props.id), props.id === 'new' ? 'POST' : 'PATCH', { config: requestConfig.value, ...(instance.value ? { expectedRevision: instance.value.revision, expectedCronRevision: instance.value.cronRevision } : {}) });
    if (!alive) return;
    instance.value = data;
    draft.value = structuredClone(data.config);
    savedConfig.value = JSON.stringify(draft.value);
    editing.value = false;
    notice.value = '配置已保存';
    emit('saved');
    if (props.id === 'new') {
      const params = new URLSearchParams({ type: 'session-transcript', instance: data.id, view: 'config' });
      location.hash = '#browse?' + params.toString();
    }
  } catch (cause) { if (alive) error.value = (cause as Error).message; }
  finally { if (alive) busy.value = false; }
}
async function previewDraft() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  const submitted = signature.value;
  try {
    const data = await api('/api/transcripts/preview', 'POST', { ...(props.id !== 'new' ? { id: props.id } : {}), config: requestConfig.value, mode: mode.value, ...(mode.value === 'backfill' ? { from: from.value, ...(to.value ? { to: to.value } : {}) } : {}) });
    if (alive) { preview.value = data; previewSignature.value = submitted; }
  } catch (cause) { if (alive) error.value = (cause as Error).message; }
  finally { if (alive) busy.value = false; }
}
async function loadDocuments() {
  const request = ++listing;
  try {
    const params = new URLSearchParams({ type: 'session-transcript', id: props.id, q: documentQuery.value, offset: String(offset.value), limit: '30' });
    const data = await api('/api/browse/documents?' + params);
    if (alive && request === listing) documents.value = data;
  } catch (cause) { if (alive && request === listing) error.value = (cause as Error).message; }
}
async function openDocument(id: string, record = true) {
  const request = ++reading;
  try {
    const data = await api('/api/resources/' + id);
    if (!alive || request !== reading) return;
    detail.value = data;
    if (record) navigate('records', id);
  } catch (cause) { if (alive && request === reading) error.value = (cause as Error).message; }
}
async function changeTab(value: string) {
  tab.value = value; navigate(value);
  if (value === 'records') await loadDocuments();
}
async function restoreView() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (params.get('instance') !== props.id) return;
  reading++;
  const value = params.get('view') ?? 'overview';
  tab.value = ['overview', 'records', 'config'].includes(value) ? value : 'overview';
  if (tab.value === 'records') {
    await loadDocuments();
    const id = params.get('resource');
    if (id) await openDocument(id, false);
    else { reading++; detail.value = undefined; }
  }
}
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('kb-before-navigation', guard);
  window.addEventListener('popstate', restoreView);
  window.addEventListener('hashchange', restoreView);
  try { profiles.value = await api('/api/transcripts/profiles'); } catch (cause) { error.value = (cause as Error).message; }
  await reload();
  if (tab.value === 'records' && props.id !== 'new') {
    await loadDocuments();
    const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('resource');
    if (id) await openDocument(id, false);
  }
});
onUnmounted(() => {
  alive = false; reading++; listing++;
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('kb-before-navigation', guard);
  window.removeEventListener('popstate', restoreView);
  window.removeEventListener('hashchange', restoreView);
});
</script>

<template>
  <section class="transcript-instance" :aria-busy="busy">
    <header class="instance-header">
      <div><button @click="close">返回实例列表</button><p class="muted">组织 / Session 转录 / 实例详情</p><h2>{{ instance?.name ?? '新建 Session 转录实例' }}</h2><small v-if="instance">{{ instance.id }}</small></div>
      <button v-if="instance" :disabled="busy" @click="reload(editing)">刷新状态与修订</button>
    </header>
    <nav class="instance-tabs" aria-label="实例详情页签">
      <button v-if="id !== 'new'" :aria-current="tab === 'overview' ? 'page' : undefined" @click="changeTab('overview')">概览</button>
      <button v-if="id !== 'new'" :aria-current="tab === 'records' ? 'page' : undefined" @click="changeTab('records')">关联记录</button>
      <button :aria-current="tab === 'config' ? 'page' : undefined" @click="changeTab('config')">实例配置</button>
    </nav>
    <p v-if="error" class="error" role="alert">{{ error }}<span v-if="editing"> 当前草稿已保留，可刷新最新修订后检查并保存。</span></p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <section v-if="tab === 'overview' && instance" class="instance-card">
      <h3>处理状态</h3>
      <dl class="instance-facts">
        <div><dt>项目目录</dt><dd>{{ instance.config.projectDir || '未限定' }}</dd></div>
        <div><dt>周期</dt><dd>{{ instance.config.enabled ? cronManaged ? `${instance.cronSchedule.expression} · ${instance.cronSchedule.timezone}` : `每 ${instance.config.intervalMinutes} 分钟检查` : '已停用' }}</dd></div>
        <div><dt>执行状态</dt><dd>{{ instance.status.running ? '正在执行' : '空闲' }}</dd></div>
        <div><dt>最近执行</dt><dd>{{ time(instance.status.lastAttempt) }}</dd></div>
        <div><dt>下次到期</dt><dd>{{ instance.config.enabled && !instance.status.nextDue ? '等待首次检查' : time(instance.status.nextDue) }}</dd></div>
        <div><dt>已生成记录</dt><dd>{{ instance.status.records }}</dd></div>
        <div><dt>待处理 / 失败</dt><dd>{{ instance.status.pending }} / {{ instance.status.failed.length }}</dd></div>
        <div><dt>发现边界</dt><dd>{{ time(instance.effectiveFrom) }}</dd></div>
      </dl>
      <p>时间按 Asia/Shanghai 展示。周期配置由外部定时工具调用 transcript tick 检查。</p>
      <h3 v-if="instance.status.failed.length">失败任务</h3>
      <p v-for="task in instance.status.failed" :key="task.id" class="error">{{ task.sessionId }} · {{ task.error }}</p>
      <details v-if="instance.status.skips.length"><summary>最近跳过原因（{{ instance.status.skips.length }}）</summary><p v-for="(skip, index) in instance.status.skips" :key="index">{{ skip.sessionId }} · {{ skip.reason }}</p></details>
    </section>
    <section v-if="tab === 'config' && draft" class="instance-card">
      <div class="instance-actions"><h3>实例配置</h3><button v-if="!editing" @click="editing = true">编辑配置</button></div>
      <p v-if="instance?.status.running" role="status">实例正在执行，完成后可保存配置。</p>
      <form @submit.prevent="save">
        <fieldset :disabled="!editing || busy">
          <legend>基础配置</legend>
          <div class="instance-grid">
            <label>展示别名<input v-model="draft.alias" required></label>
            <label>项目目录<input v-model="draft.projectDir" :required="draft.enabled" placeholder="D:/project/example"></label>
            <label>首次起始日期<input v-model="draft.startDate" required placeholder="YYYY-MM-DD 或带时区 ISO"></label>
            <label>时区<input v-model="draft.timezone" required></label>
          </div>
        </fieldset>
        <fieldset :disabled="!editing || busy">
          <legend>目录与筛选</legend>
          <label class="check-label"><input v-model="draft.includeSubdirectories" type="checkbox">包含子目录</label>
          <div class="array-field"><span>额外工作目录</span><div v-for="(_, index) in draft.additionalDirectories" :key="index" class="array-row"><input v-model="draft.additionalDirectories[index]" required aria-label="额外工作目录"><button type="button" @click="draft.additionalDirectories.splice(index, 1)">移除</button></div><button type="button" @click="draft.additionalDirectories.push('')">添加工作目录</button></div>
          <p>排除优先。同字段任一命中，不同包含字段同时满足。</p>
          <div class="instance-grid">
            <section v-for="group in [{ key: 'include', label: '包含' }, { key: 'exclude', label: '排除' }]" :key="group.key">
              <h4>{{ group.label }}规则</h4>
              <div v-for="field in filterFields" :key="field.key" class="array-field"><span>{{ field.label }}</span><div v-for="(_, index) in draft[group.key][field.key]" :key="index" class="array-row"><input v-model="draft[group.key][field.key][index]" required :aria-label="`${group.label}${field.label}`"><button type="button" @click="draft[group.key][field.key].splice(index, 1)">移除</button></div><button type="button" @click="draft[group.key][field.key].push('')">添加{{ group.label }}{{ field.label }}</button></div>
            </section>
          </div>
        </fieldset>
        <fieldset :disabled="!editing || busy">
          <legend>转录设置</legend>
          <label>关注点<textarea v-model="draft.focus" rows="3"></textarea></label>
          <label>模型 Profile<select v-model="draft.profile" aria-label="模型 Profile" required><option v-if="!selectedProfile" :value="draft.profile">{{ draft.profile }}（当前不可用）</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.id }} · {{ profile.model }}</option></select></label>
          <p>{{ selectedProfile?.credentialConfigured ? '凭证已配置' : '凭证未配置或 Profile 不可用' }}</p>
        </fieldset>
        <fieldset :disabled="!editing || busy">
          <legend>周期设置</legend>
          <p v-if="cronManaged">周期由 cron 计划管理。</p>
          <template v-else>
            <label class="check-label"><input v-model="draft.enabled" type="checkbox">启用周期检查</label>
            <label>检查间隔（分钟）<input v-model.number="draft.intervalMinutes" type="number" min="1" :required="draft.enabled"></label>
          </template>
          <p>启用周期须填写项目目录和检查间隔。</p>
        </fieldset>
        <details><summary>高级设置</summary><fieldset :disabled="!editing || busy"><legend>来源与预算</legend><label>来源目录<input v-model="draft.sourceRoot" required></label><div class="instance-grid"><label v-for="budget in budgets" :key="budget.key">{{ budget.label }}<input v-model.number="draft[budget.key]" type="number" :min="budget.min" :max="budget.key === 'maxDurationMs' ? 300000 : undefined" required></label></div></fieldset></details>
        <p>目录、日期和筛选范围修改自保存时生效，较早材料通过历史补录处理。</p>
        <div v-if="editing" class="instance-actions"><button type="submit" :disabled="busy || instance?.status.running">{{ busy ? '处理中…' : '保存配置' }}</button><button type="button" :disabled="busy" @click="cancel">取消修改</button><span v-if="dirty" role="status">有未保存修改</span></div>
      </form>
      <section class="draft-preview">
        <h3>筛选预览</h3><p>使用当前表单草稿，显示候选范围和跳过原因。模型调用次数为零。</p>
        <label>预览范围<select v-model="mode" aria-label="预览范围"><option value="incremental">增量范围</option><option value="backfill">历史补录范围</option></select></label>
        <div v-if="mode === 'backfill'" class="instance-grid"><label>开始时间<input v-model="from" required></label><label>截止时间<input v-model="to" placeholder="留空使用当前时间"></label></div>
        <button :disabled="busy" @click="previewDraft">预览筛选</button>
        <template v-if="preview">
          <p v-if="previewStale" class="reference-warning" role="status">表单或范围已修改，以下预览已过期，请重新预览。</p>
          <p v-if="preview.scopeChanged">范围修改将从保存时生效。可切换历史补录范围查看较早候选。</p>
          <p>{{ preview.candidates.length }} 个分段 · {{ preview.inputBytes }} 字节 · 截止 {{ time(preview.cutoff) }} · {{ preview.draft ? '表单草稿' : '已保存配置' }}</p>
          <ul><li v-for="(candidate, index) in preview.candidates" :key="index">{{ candidate.sessionId }} · {{ candidate.messageCount }} 条消息 · 位置 {{ candidate.positions.join('、') }} · {{ candidate.bytes }} 字节</li></ul>
          <details v-if="preview.skips.length" open><summary>跳过原因（{{ preview.skips.length }}）</summary><p v-for="(skip, index) in preview.skips" :key="index">{{ skip.sessionId }} · {{ skip.reason }}</p></details>
        </template>
      </section>
    </section>
    <section v-if="tab === 'records'" class="instance-card">
      <h3>关联记录</h3>
      <form class="instance-actions" @submit.prevent="offset = 0; loadDocuments()"><input v-model="documentQuery" aria-label="搜索转录记录" placeholder="搜索标题或摘要"><button>搜索</button></form>
      <div class="record-columns"><section><button v-for="item in documents.items" :key="item.resource.id" class="record-row" :aria-current="detail?.resource.id === item.resource.id ? 'true' : undefined" @click="openDocument(item.resource.id)"><strong>{{ item.title }}</strong><p>{{ item.summary }}</p></button><p v-if="!documents.items.length">暂无关联记录</p><div class="instance-actions"><button :disabled="offset === 0" @click="offset -= 30; loadDocuments()">上一页</button><span>{{ documents.total }}篇</span><button :disabled="offset + 30 >= documents.total" @click="offset += 30; loadDocuments()">下一页</button></div></section><article v-if="detail"><h3>{{ detail.resource.originalName }}</h3><div class="markdown" v-html="markdown"></div></article></div>
    </section>
  </section>
</template>

<style scoped>
.transcript-instance{margin:20px 0;min-width:0}.instance-header,.instance-actions,.instance-tabs,.array-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.instance-header{justify-content:space-between}.instance-header small{overflow-wrap:anywhere}.instance-tabs{margin:20px 0}.instance-tabs button{color:#415d4b;background:white;border:1px solid #dfe7df}.instance-tabs [aria-current=page]{color:#244b36}.instance-tabs [aria-current=page],.record-row[aria-current=true]{background:#edf3e9;border-color:#64856c}.instance-card{background:white;border:1px solid #dfe7df;border-radius:8px;padding:24px;min-width:0}.instance-grid,.instance-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.transcript-instance label{display:flex;flex-direction:column;gap:7px;margin:12px 0}.transcript-instance input,.transcript-instance textarea,.transcript-instance select{border:1px solid #cdd9cf;border-radius:4px;padding:9px;width:100%;min-width:0;font:inherit}.transcript-instance fieldset{border:1px solid #dfe7df;padding:16px;margin:16px 0;border-radius:6px;min-width:0}.transcript-instance legend{padding:0 8px;font-weight:600}.transcript-instance input:disabled,.transcript-instance textarea:disabled,.transcript-instance select:disabled{color:#415d4b;-webkit-text-fill-color:#415d4b;background:#f6f8f4;opacity:1}.transcript-instance .check-label{flex-direction:row;align-items:center}.check-label input{width:auto}.array-field{margin:14px 0}.array-field>span{display:block;margin-bottom:8px}.array-row{flex-wrap:nowrap;margin:8px 0}.array-row input{flex:1}.array-row button{flex:none}.instance-facts dd{margin:6px 0 0;overflow-wrap:anywhere}.instance-facts dt{color:#61776a;font-size:12px}.draft-preview{border-top:1px solid #dfe7df;margin-top:24px;padding-top:20px}.draft-preview li,.draft-preview p{overflow-wrap:anywhere}.record-columns{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:24px}.record-row{display:block;width:100%;text-align:left;margin:12px 0}.record-row p{font-size:12px}.instance-actions input{width:auto;flex:1}.record-columns article{overflow-wrap:anywhere}@media(max-width:700px){.instance-grid,.instance-facts,.record-columns{grid-template-columns:1fr}.instance-card{padding:16px}.instance-header{align-items:flex-start}.instance-tabs{gap:6px}.transcript-instance fieldset{padding:12px}.array-row{gap:6px}}
</style>
