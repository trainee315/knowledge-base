<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { renderMarkdown } from '../../src/preview/markdown';
import { previewPanels } from './panels';
import OrganizationBrowser from './OrganizationBrowser.vue';
import PluginDetail from './PluginDetail.vue';
import { pluginHash } from './plugin-detail';

type Resource = { id: string; originalName: string; extension: string; mediaType: string; size: number; contentVersion: number; updatedAt: string; deletedAt?: string; plugins: Record<string, unknown> };
type Item = { resource: Resource; reasons?: string[]; matchReasons?: string[]; parseStatus: string };
type Plugin = { id: string; enabled?: boolean; status?: string; version?: string; dependencies?: Record<string, string> };
const tab = ref('resources');
const instanceRoute = ref(false);
const activeHash = ref(location.hash);
let previousHash = location.hash;
function switchTab(value: string) {
  if (value === tab.value) {
    if (value === 'plugins' && selectedPlugin.value && window.dispatchEvent(new Event('kb-before-navigation', { cancelable: true }))) location.hash = '#plugins';
    return;
  }
  if (value === 'plugins' || tab.value === 'plugins') {
    if (tab.value === 'plugins' && !window.dispatchEvent(new Event('kb-before-navigation', { cancelable: true }))) return;
    location.hash = value === 'plugins' ? '#plugins' : value === 'organizations' ? '#browse' : '';
    return;
  }
  if (!window.dispatchEvent(new Event('kb-before-navigation', { cancelable: true }))) return;
  tab.value = value;
}
function createFirstTranscript() {
  location.hash = '#browse?type=session-transcript&instance=new&view=config';
}
async function refreshOrganizations() {
  [organizations.value, organizationTypes.value] = await Promise.all([api('/api/organizations'), api('/api/organization-types')]);
}
const items = ref<Item[]>([]);
const total = ref(0);
const offset = ref(0);
// 业务数据以同源接口为准，实例表单只在编辑期间持有草稿。
const plugins = ref<Plugin[]>([]);
const selectedPlugin = computed(() => new URLSearchParams(activeHash.value.split('?')[1] ?? '').get('id') ?? '');
const organizations = ref<any[]>([]);
const organizationTypes = ref<any[]>([]);
const selected = ref<{ resource: Resource; content: { text?: string; status?: string; format?: string; referenceStatus?: string; diagnostics?: string[] }; systems?: unknown[] }>();
const filters = ref({ filename: '', body: '', keywords: '', tags: '', systems: '', parseStatus: '' });
const error = ref('');
const busy = ref(false);
const detailBusy = ref(false);
const PAGE_SIZE = 30;
const enabled = computed(() => new Set(plugins.value.filter((p) => p.enabled !== false && !['disabled', 'failed'].includes(p.status ?? '')).map((p) => p.id)));
const panels = computed(() => previewPanels.filter((p) => enabled.value.has(p.pluginId) && selected.value?.resource.plugins?.[p.pluginId]));
const markdown = computed(() => renderMarkdown(selected.value?.content.text ?? ''));

async function api(path: string): Promise<any> {
  const response = await fetch(path);
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? '读取失败');
  return result.data;
}
async function search(reset = true): Promise<void> {
  if (reset) offset.value = 0;
  busy.value = true; error.value = '';
  try {
    const params = new URLSearchParams({ offset: String(offset.value), limit: String(PAGE_SIZE) });
    for (const key of ['filename', 'body', 'keywords', 'tags', 'systems', 'parseStatus'] as const) {
      filters.value[key].split(',').map((v) => v.trim()).filter(Boolean).forEach((v) => params.append(key, v));
    }
    const result = await api(`/api/resources?${params}`);
    items.value = result.items; total.value = result.total;
  } catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause); }
  finally { busy.value = false; }
}
async function openResource(id: string): Promise<void> {
  detailBusy.value = true; error.value = ''; tab.value = 'resources';
  try { selected.value = await api(`/api/resources/${encodeURIComponent(id)}`); history.replaceState(null, '', `#resource/${id}`); }
  catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause); }
  finally { detailBusy.value = false; }
}
function readHash(): void {
  const hash = location.hash;
  const pluginRoute = /^#plugins(?:\?|$)/.test(hash);
  if (hash !== previousHash && (tab.value === 'plugins' || !hash.startsWith('#browse') && tab.value === 'organizations') && !window.dispatchEvent(new Event('kb-before-navigation', { cancelable: true }))) {
    history.replaceState(null, '', previousHash);
    return;
  }
  const wasPlugin = tab.value === 'plugins';
  previousHash = hash;
  activeHash.value = hash;
  instanceRoute.value = new URLSearchParams(hash.split('?')[1] ?? '').has('instance');
  if (pluginRoute) {
    tab.value = 'plugins';
    if (!selectedPlugin.value) void refreshPlugins();
    return;
  }
  if (hash.startsWith('#browse')) { tab.value = 'organizations'; return; }
  const match = /^#resource\/([a-f\d-]{36})$/i.exec(hash);
  if (match) void openResource(match[1]);
  else if (wasPlugin) tab.value = 'resources';
}
async function refreshPlugins() {
  error.value = '';
  try { plugins.value = await api('/api/plugins'); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
function closeDetail(): void { selected.value = undefined; history.replaceState(null, '', location.pathname + location.search); }
function bytes(size: number): string { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
function parseLabel(status: string): string { return ({ parsed: '已解析', unsupported: '暂不支持', pending: '待解析', unparsed: '待解析', failed: '解析失败' } as Record<string, string>)[status] ?? status; }
function reasonLabel(reason: string): string { return reason.startsWith('解析状态: ') ? `解析状态: ${parseLabel(reason.slice(6))}` : reason; }
function formatted(value: unknown): string { return JSON.stringify(value, null, 2); }
onMounted(async () => {
  window.addEventListener('hashchange', readHash);
  readHash();
  const responses = await Promise.allSettled([api('/api/plugins'), api('/api/organizations'), api('/api/organization-types')]);
  const [pluginResponse, organizationResponse, typeResponse] = responses;
  if (pluginResponse.status === 'fulfilled') plugins.value = pluginResponse.value;
  if (organizationResponse.status === 'fulfilled') organizations.value = organizationResponse.value;
  if (typeResponse.status === 'fulfilled') organizationTypes.value = typeResponse.value;
  await search();
  if (tab.value === 'plugins' && pluginResponse.status === 'rejected' && !selectedPlugin.value) {
    error.value = String(pluginResponse.reason?.message ?? pluginResponse.reason);
  }
  if (tab.value === 'organizations') {
    const failed = [organizationResponse, typeResponse].find(item => item.status === 'rejected');
    if (failed) error.value = String(failed.reason?.message ?? failed.reason);
  }
});
onUnmounted(() => window.removeEventListener('hashchange', readHash));
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-icon">知</span><div>知识库<small>本地资源管理</small></div></div>
      <div class="read-only"><span></span> 本地知识库</div>
      <nav aria-label="主导航">
        <button :class="{ active: tab === 'resources' }" @click="switchTab('resources')">▤ <span>资源</span><small>{{ total }}</small></button>
        <button :class="{ active: tab === 'organizations' }" @click="switchTab('organizations')">⌘ <span>组织与体系</span><small>{{ organizations.length }}</small></button>
        <button :class="{ active: tab === 'plugins' }" @click="switchTab('plugins')">◈ <span>插件状态</span><small>{{ plugins.length }}</small></button>
      </nav>
      <div class="sidebar-footer">资源由 UUID 稳定引用<br>Session 配置可在实例详情编辑</div>
    </aside>
    <main>
      <header><div><div class="eyebrow">KNOWLEDGE BASE / {{ tab === 'resources' ? 'RESOURCES' : tab === 'plugins' ? 'PLUGINS' : 'ORGANIZATIONS' }}</div><h1>{{ tab === 'resources' ? '资源浏览' : tab === 'plugins' ? '插件状态' : '组织与体系' }}</h1></div><span class="local-label">127.0.0.1 · 本地</span></header>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <template v-if="tab === 'resources'">
        <form class="filters" @submit.prevent="search()">
          <label class="wide">文件名<input v-model="filters.filename" placeholder="搜索文件名…"></label>
          <label>正文<input v-model="filters.body" placeholder="正文包含" :disabled="!enabled.has('organizer') || !enabled.has('content')"></label>
          <label>关键词<input v-model="filters.keywords" placeholder="多个值用逗号分隔" :disabled="!enabled.has('organizer') || !enabled.has('keywords')"></label>
          <label>标签<input v-model="filters.tags" placeholder="标签名称 / ID" :disabled="!enabled.has('organizer') || !enabled.has('tags')"></label>
          <label>体系<input v-model="filters.systems" placeholder="体系名称 / ID" :disabled="!enabled.has('organizer') || !enabled.has('systems')"></label>
          <label>解析状态<select v-model="filters.parseStatus"><option value="">全部状态</option><option value="parsed">已解析</option><option value="unsupported">暂不支持</option><option value="failed">解析失败</option><option value="pending">待解析</option></select></label>
          <button class="primary" :disabled="busy">{{ busy ? '查询中…' : '查询资源' }}</button>
          <p class="filter-note">不同条件取交集；同一条件内多个值取并集。所有筛选在分页前执行。</p>
        </form>
        <div class="resource-layout" :class="{ 'has-detail': selected }">
          <section class="resource-list"><div class="section-title"><h2>资源列表</h2><span>{{ total }} 个结果</span></div>
            <div v-if="!items.length && !busy" class="empty"><b>还没有匹配的资源</b><p>调整查询条件，或通过 CLI 导入资源。</p></div>
            <button v-for="item in items" :key="item.resource.id" class="resource-row" :class="{ selected: selected?.resource.id === item.resource.id }" @click="openResource(item.resource.id)">
              <span class="file-icon">{{ item.resource.extension?.slice(0, 4) || 'FILE' }}</span>
              <span class="resource-copy"><strong>{{ item.resource.originalName }}</strong><small>{{ bytes(item.resource.size) }} · v{{ item.resource.contentVersion }} <span v-if="item.resource.deletedAt">· 已回收</span></small><span v-if="(item.matchReasons ?? item.reasons)?.length" class="match-reasons">{{ (item.matchReasons ?? item.reasons)?.map(reasonLabel).join(' · ') }}</span></span><span class="status">{{ parseLabel(item.parseStatus) }}</span>
            </button>
            <div class="pagination"><button :disabled="offset === 0 || busy" @click="offset -= PAGE_SIZE; search(false)">上一页</button><span>{{ total ? offset + 1 : 0 }}–{{ Math.min(offset + PAGE_SIZE, total) }} / {{ total }}</span><button :disabled="offset + PAGE_SIZE >= total || busy" @click="offset += PAGE_SIZE; search(false)">下一页</button></div>
          </section>
          <section v-if="selected" class="detail" :aria-busy="detailBusy"><div class="section-title"><h2>资源详情</h2><button aria-label="关闭详情" @click="closeDetail">×</button></div><h2 class="detail-name">{{ selected.resource.originalName }}</h2><div class="uuid">{{ selected.resource.id }}</div>
            <div class="detail-actions"><a :href="`/api/resources/${selected.resource.id}/file`" download>下载原件 ↗</a><code>kb://resource/{{ selected.resource.id }}</code></div>
            <dl class="facts"><div><dt>大小</dt><dd>{{ bytes(selected.resource.size) }}</dd></div><div><dt>内容版本</dt><dd>v{{ selected.resource.contentVersion }}</dd></div><div><dt>正文解析</dt><dd>{{ parseLabel(selected.content.status ?? 'pending') }}</dd></div><div v-if="selected.content.referenceStatus"><dt>内部引用</dt><dd>{{ selected.content.referenceStatus === 'broken' ? '存在失效引用' : selected.content.referenceStatus === 'valid' ? '引用完整' : '无内部引用' }}</dd></div></dl>
            <section v-if="selected.content.referenceStatus === 'broken'" class="reference-warning" role="status"><strong>资源引用存在问题</strong><ul><li v-for="diagnostic in selected.content.diagnostics ?? []" :key="diagnostic">{{ diagnostic }}</li></ul></section>
            <img v-if="/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(selected.resource.mediaType)" class="image-preview" :src="`/api/resources/${selected.resource.id}/file?inline=1`" :alt="selected.resource.originalName">
            <article v-if="selected.content.text && ['md', 'markdown'].includes(selected.resource.extension.replace(/^\./, ''))" class="markdown" v-html="markdown"></article>
            <pre v-else-if="selected.content.text" class="text-content">{{ selected.content.text }}</pre>
            <p v-else class="muted">此资源暂未提供可解析正文，原件和元数据均已保存。</p>
            <section v-for="panel in panels" :key="panel.pluginId" class="plugin-panel"><h3>{{ panel.title }}</h3><component :is="panel.component" v-if="panel.component" :resource="selected.resource" :data="selected.resource.plugins[panel.pluginId]"/><details v-else><summary>查看插件数据</summary><pre>{{ formatted(selected.resource.plugins[panel.pluginId]) }}</pre></details></section>
            <details><summary>完整元数据</summary><pre>{{ formatted(selected.resource) }}</pre></details>
          </section>
          <section v-else class="detail-placeholder"><div>▤</div><h2>从资源开始探索</h2><p>选择一项资源，浏览正文、元数据与关联信息。</p><span>本地存储 · UUID 引用 · 按需预览</span></section>
        </div>
      </template>
      <button v-if="tab === 'organizations' && enabled.has('transcripts') && !instanceRoute && !organizationTypes.some(type => type.id === 'session-transcript')" @click="createFirstTranscript">新建 Session 转录实例</button>
      <OrganizationBrowser v-if="tab === 'organizations'" :types="organizationTypes" :organizations="organizations" @changed="refreshOrganizations" />
      <PluginDetail v-if="tab === 'plugins' && selectedPlugin" :key="selectedPlugin" :id="selectedPlugin" :route="activeHash" />
      <template v-else-if="tab === 'plugins'">
        <div class="plugin-list-tools"><button @click="refreshPlugins">刷新插件状态</button></div>
        <div class="card-grid"><section v-for="plugin in plugins" :key="plugin.id" class="plugin-card"><span class="status">{{ plugin.status ?? (plugin.enabled === false ? 'disabled' : 'ready') }}</span><h2>{{ plugin.id }}</h2><p class="muted">{{ plugin.version }}</p><h3>直接依赖</h3><p>{{ Object.keys(plugin.dependencies ?? {}).join(' → ') || '无' }}</p><a :href="pluginHash(plugin.id)" :aria-label="'查看 ' + plugin.id + ' 详情'">查看详情 →</a></section></div>
      </template>
      <footer>Agent 知识库 <span>本地应用服务</span></footer>
    </main>
  </div>
</template>

<style scoped>
.plugin-list-tools { display: flex; justify-content: flex-end; margin-bottom: 1rem; }
.plugin-card a { display: inline-block; margin-top: .5rem; font-weight: 600; }
.card-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr)); }
</style>
