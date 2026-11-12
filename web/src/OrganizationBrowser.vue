<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import TranscriptInstance from './TranscriptInstance.vue';
import { renderMarkdown } from '../../src/preview/markdown';

// 组织页由Session转录承接项目记录，旧方式仅保留后端历史回查。
const RETIRED_PROJECT_TYPE = 'project-development-tracking';
// 组织文档沿用通用分页规模。
const PAGE_SIZE = 30;
const instanceId = ref('');
const instanceView = ref('overview');
const instancePanel = ref<InstanceType<typeof TranscriptInstance>>();
let currentHash = location.hash;
const emit = defineEmits(['changed']);
const props = defineProps<{ types: any[]; organizations: any[] }>();
const visibleTypes = computed(() => {
  const kinds = props.types.filter(kind => kind.id !== RETIRED_PROJECT_TYPE);
  // 老库首次进入Session页时提供可选空列表，正式方式在用户保存首个实例时登记。
  if (type.value === 'session-transcript' && !kinds.some(kind => kind.id === type.value)) {
    kinds.push({ id: 'session-transcript', name: 'Session 转录', enabled: true });
  }
  return kinds;
});
const type = ref('tag'), ids = ref<string[]>([]), collectionQuery = ref(''), query = ref(''), tagMatch = ref('any'), nodeId = ref('');
const offset = ref(0), collectionOffset = ref(0), collections = ref<any>({items:[],total:0}), documents = ref<any>({items:[],total:0});
const detail = ref<any>(), error = ref(''), loading = ref(false), mobileStep = ref('collections');
// 请求代次隔离快速导航，旧响应不能覆盖新的组织或阅读目标。
let generation = 0;
let collectionGeneration = 0;
let detailGeneration = 0;
let restoreGeneration = 0;
const typeName = computed(() => visibleTypes.value.find(t=>t.id===type.value)?.name ?? type.value);
const parseName = (status: string) => ({parsed:'已解析',pending:'待解析',unsupported:'暂不支持',failed:'解析失败'} as Record<string,string>)[status] ?? status;
const tagNames = (values: string[]) => values.map(id=>props.organizations.find(o=>o.id===id)?.name ?? id).join('、');
const markdown = computed(() => renderMarkdown(detail.value?.text ?? ''));
const isSelected = (item: any) => detail.value?.resource?.id === item.resource.id;
async function api(url: string) { const response = await fetch(url); const result=await response.json(); if(!response.ok || !result.ok) throw new Error(result.error?.message ?? '读取失败'); return result.data; }
function params() { const p=new URLSearchParams({type:type.value,q:query.value,tagMatch:tagMatch.value,offset:String(offset.value),limit:String(PAGE_SIZE)});ids.value.forEach(id=>p.append('id',id));if(nodeId.value)p.set('nodeId',nodeId.value);return p; }
function save(target?: { resource?: string }) {
  ++restoreGeneration;
  const p=params();p.set('cq',collectionQuery.value);p.set('co',String(collectionOffset.value));
  if(target?.resource)p.set('resource',target.resource);
  const hash='#browse?'+p.toString();if(location.hash!==hash)history.pushState(null,'',hash);
}
async function loadCollections() {
  const request=++collectionGeneration;
  if (type.value === 'session-transcript' && !props.types.some(kind => kind.id === type.value)) {
    collections.value = { items: [], total: 0 };
    return;
  }
  try { const p=new URLSearchParams({type:type.value,q:collectionQuery.value,offset:String(collectionOffset.value),limit:'30'});const data=await api('/api/browse/collections?'+p);if(request===collectionGeneration)collections.value=data; }
  catch(e){if(request===collectionGeneration)error.value=String((e as Error).message);}
}
async function loadDocuments() {
  const request=++generation; ++detailGeneration; detail.value=undefined;documents.value={items:[],total:0};error.value='';loading.value=true;
  try { const data=ids.value.length ? await api('/api/browse/documents?'+params()) : {items:[],total:0};if(request===generation)documents.value=data; }
  catch(e){if(request===generation){documents.value={items:[],total:0};error.value=String((e as Error).message);}}
  finally{if(request===generation)loading.value=false;}
}
async function changeType() { if (instancePanel.value && !instancePanel.value.canLeave()) { type.value = 'session-transcript'; return; } instanceId.value = '';  ++generation;++detailGeneration;ids.value=[];nodeId.value='';offset.value=0;collectionOffset.value=0;collectionQuery.value='';query.value='';detail.value=undefined;documents.value={items:[],total:0};collections.value={items:[],total:0};error.value='';mobileStep.value='collections';save();await loadCollections(); }
async function choose(id: string) { ids.value=type.value==='tag' ? ids.value.includes(id)?ids.value.filter(x=>x!==id):[...ids.value,id] : [id];nodeId.value='';offset.value=0;mobileStep.value='documents';save();await loadDocuments(); }
async function filterDocuments(reset=true){if(reset)offset.value=0;save();await loadDocuments();}
async function open(item: any, record=true) {
  if(record)++restoreGeneration;
  const request=++detailGeneration;detail.value=undefined;error.value='';mobileStep.value='detail';
  try {
    const value = await api(`/api/resources/${encodeURIComponent(item.resource.id)}`);
    if (request !== detailGeneration) return;
    detail.value = { title: value.resource.originalName, text: value.content.text, extension: value.resource.extension, resource: value.resource, status: value.content.status };
    if (record) save({ resource: value.resource.id });
  }catch(e){if(request===detailGeneration)error.value=String((e as Error).message);}
}
function depth(node: any) {let level=0, current=node;const seen=new Set();while(current?.parentId && !seen.has(current.id)){seen.add(current.id);level++;current=documents.value.nodes?.find((n:any)=>n.id===current.parentId);}return level;}
function showInstance(id: string) {
  if (instancePanel.value && !instancePanel.value.canLeave()) return;
  instanceId.value = id;
  instanceView.value = id === 'new' ? 'config' : 'overview';
  const p = new URLSearchParams({ type: 'session-transcript', instance: id, view: instanceView.value });
  location.hash = '#browse?' + p.toString();
}
async function closeInstance() {
  instanceId.value = '';
  const p = new URLSearchParams({ type: 'session-transcript' });
  location.hash = '#browse?' + p.toString();
  await loadCollections();
}
async function instanceSaved() { emit('changed'); await loadCollections(); }
async function restore(){
  if(!location.hash.startsWith('#browse'))return;
  const p = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const retired = p.get('type') === RETIRED_PROJECT_TYPE;
  const next = retired ? '' : p.get('instance') ?? '';
  if (instanceId.value !== next && instancePanel.value && !instancePanel.value.canLeave()) { history.replaceState(null, '', currentHash); return; }
  // 旧实例与Session实例UUID独立，旧链接只跳转列表并清除所有旧定位条件。
  if (retired) {
    instanceId.value = '';
    location.replace('#browse?type=session-transcript');
    return;
  }
  currentHash = location.hash;
  instanceId.value = next;
  if (next) { type.value = 'session-transcript'; instanceView.value = p.get('view') ?? 'overview'; return; }
  const request=++restoreGeneration;
  type.value=p.get('type')??'tag';ids.value=p.getAll('id');query.value=p.get('q')??'';collectionQuery.value=p.get('cq')??'';tagMatch.value=p.get('tagMatch')??'any';nodeId.value=p.get('nodeId')??'';
  offset.value=Math.max(0,Number(p.get('offset'))||0);collectionOffset.value=Math.max(0,Number(p.get('co'))||0);
  await Promise.all([loadCollections(),loadDocuments()]);
  if(request!==restoreGeneration)return;
  if(p.has('resource'))await open({resource:{id:p.get('resource')}},false);
  if(request!==restoreGeneration)return;
  mobileStep.value=detail.value?'detail':ids.value.length?'documents':'collections';
}
watch(() => props.types.some(kind => kind.id === 'session-transcript'), available => {
  if (available && type.value === 'session-transcript' && !instanceId.value) void loadCollections();
});
onMounted(async()=>{window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);if(location.hash.startsWith('#browse'))await restore();else await loadCollections();});
onUnmounted(()=>{generation++;collectionGeneration++;detailGeneration++;restoreGeneration++;window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);});
</script>

<template>
  <TranscriptInstance v-if="instanceId" :key="instanceId" ref="instancePanel" :id="instanceId" :view="instanceView" @close="closeInstance" @saved="instanceSaved" />
  <section v-else class="organization-browser" :data-step="mobileStep">
    <div class="browse-toolbar"><label>组织方式 <select aria-label="组织方式" v-model="type" @change="changeType"><option v-for="kind in visibleTypes" :key="kind.id" :value="kind.id">{{ kind.name }}{{ kind.enabled?'':'（已停用新增）' }}</option></select></label><span class="muted">按{{ typeName }}浏览</span><button v-if="type === 'session-transcript'" @click="showInstance('new')">新建实例</button><button class="mobile-back" @click="mobileStep=mobileStep==='detail'?'documents':'collections'">返回上一级</button></div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="browse-columns">
      <aside class="browse-collections"><h2>{{ typeName }}</h2><form @submit.prevent="collectionOffset=0;save();loadCollections()"><input v-model="collectionQuery" aria-label="搜索组织条目" placeholder="搜索名称"><button>搜索</button></form>
        <div v-for="item in collections.items" :key="item.id" class="instance-list-row"><button :key="item.id" class="collection-row" :aria-pressed="ids.includes(item.id)" :class="{active:ids.includes(item.id)}" @click="choose(item.id)"><strong>{{ item.name }}</strong><span>{{ item.count }} 篇</span><small v-if="type === 'session-transcript'">{{ item.projectDir || '未限定项目目录' }} · {{ item.enabled ? '每 ' + item.intervalMinutes + ' 分钟检查' : '周期已停用' }}</small><small>{{ item.description }}</small></button><button v-if="type === 'session-transcript'" :aria-label="`查看 ${item.name} 详情`" @click="showInstance(item.id)">查看详情</button></div>
        <p v-if="!collections.items.length" class="muted">暂无匹配条目</p><div class="pagination"><button :disabled="collectionOffset===0" @click="collectionOffset-=30;save();loadCollections()">上一页</button><span>{{ collections.total }}项</span><button :disabled="collectionOffset+30>=collections.total" @click="collectionOffset+=30;save();loadCollections()">下一页</button></div>
        <div v-if="documents.nodes?.length" class="browse-tree"><h3>体系目录</h3><button @click="nodeId='';filterDocuments()">全部文档</button><button v-for="node in documents.nodes" :key="node.id" :style="{paddingLeft:`${depth(node)*16+8}px`}" :class="{active:nodeId===node.id}" @click="nodeId=node.id;filterDocuments()">{{ node.title }}</button></div>
      </aside>
      <section class="browse-documents" :aria-busy="loading"><h2>关联文档 <span class="muted">{{ documents.total }}项</span></h2><form @submit.prevent="filterDocuments()"><input v-model="query" aria-label="搜索关联文档" placeholder="搜索标题或摘要"><select v-if="type==='tag'" v-model="tagMatch" aria-label="标签匹配方式" @change="filterDocuments()"><option value="any">任意标签</option><option value="all">全部标签</option></select><button>查询</button></form>
        <p v-if="documents.generic" class="muted">通用资源引用预览</p><p v-if="documents.missingReferences?.length" class="reference-warning">部分引用资源已回收或不可用：{{ documents.missingReferences.length }}项</p>
        <button v-for="item in documents.items" :key="item.resource.id" class="browse-document" :class="{ selected: isSelected(item) }" :aria-current="isSelected(item) ? 'true' : undefined" @click="open(item)"><strong>{{ item.title }}</strong>
          <small>{{ item.resource.extension }} · {{ parseName(item.parseStatus) }} · {{ tagNames(item.tags) }}</small><p>{{ item.summary || '暂无可解析摘要' }}</p><small>{{ item.matchReasons.join(' · ') }}</small><small v-for="value in item.paths" :key="value">{{ value }}</small>
        </button><p v-if="!documents.items.length && !loading" class="muted">{{ ids.length?'暂无关联文档':'请选择左侧条目' }}</p>
        <div class="pagination"><button :disabled="offset===0 || loading" @click="offset-=PAGE_SIZE;filterDocuments(false)">上一页</button><span>{{ documents.total ? offset+1 : 0 }}–{{ Math.min(offset+PAGE_SIZE,documents.total) }} / {{ documents.total }}</span><button :disabled="offset+PAGE_SIZE>=documents.total || loading" @click="offset+=PAGE_SIZE;filterDocuments(false)">下一页</button></div>
      </section>
      <section class="browse-detail"><template v-if="detail"><h2>{{ detail.title }}</h2>
        <template v-if="detail.resource"><a :href="`/api/resources/${detail.resource.id}/file`" download>下载原件</a><img v-if="/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(detail.resource.mediaType)" class="image-preview" :src="`/api/resources/${detail.resource.id}/file?inline=1`" :alt="detail.title"></template>
        <article v-if="detail.text && ['md','markdown'].includes(detail.extension.replace(/^\./,''))" class="markdown" v-html="markdown"></article><pre v-else-if="detail.text" class="text-content">{{ detail.text }}</pre><p v-else class="muted">正文不可解析，可下载原件。</p><details><summary>元数据与历史记录</summary><pre>{{ JSON.stringify(detail.resource,null,2) }}</pre></details>
      </template><p v-else class="muted">选择文档阅读正文</p></section>
    </div>
  </section>
</template>

<style scoped>
.instance-list-row{margin-bottom:14px}.instance-list-row>.collection-row{margin-bottom:6px}.browse-document.selected{background:#edf3e9;border-color:#64856c}.browse-document.selected strong{color:#244b36}
.browse-toolbar{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:20px 0}.browse-columns{display:grid;grid-template-columns:minmax(190px,.65fr) minmax(240px,1fr) minmax(300px,1.4fr);gap:16px;align-items:start}.browse-columns>aside,.browse-columns>section{background:white;border:1px solid #dfe7df;border-radius:8px;padding:18px;min-width:0;overflow-wrap:anywhere}.browse-columns h2{margin-bottom:16px}.browse-columns form{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}.browse-columns input{min-width:0;max-width:100%;flex:1;border:1px solid #dfe7df;padding:8px}.collection-row,.browse-document{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;margin:8px 0}.collection-row.active,.browse-tree .active{background:#edf3e9}.collection-row span,.collection-row small,.browse-document small{font-size:11px;color:#61776a}.browse-document p{margin:0;font-size:12px;color:#61776a}.browse-tree button{display:block;width:100%;text-align:left;margin:4px 0}.browse-detail{max-height:calc(100vh - 130px);overflow:auto}.mobile-back{display:none}.pagination{gap:6px;padding:12px 0}.browse-detail .markdown,.browse-detail .text-content{margin:20px 0}.browse-detail .status{display:inline-block}@media(max-width:1200px){.browse-columns{grid-template-columns:minmax(160px,.7fr) 1fr}.browse-detail{grid-column:1/-1}}@media(max-width:700px){.browse-columns{display:block}.mobile-back{display:block}.organization-browser[data-step=collections] .browse-documents,.organization-browser[data-step=collections] .browse-detail,.organization-browser[data-step=documents] .browse-collections,.organization-browser[data-step=documents] .browse-detail,.organization-browser[data-step=detail] .browse-collections,.organization-browser[data-step=detail] .browse-documents{display:none}.browse-detail{max-height:none}.browse-columns>section{width:100%}}
</style>
