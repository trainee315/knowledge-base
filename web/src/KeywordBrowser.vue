<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const PAGE=30; // 词表、文档、片元分别分页，展开才读取下一层。
type Page={items:any[];total:number;generation:string;status?:{state:string;failed?:number};keyword?:{id:string;name:string};missing?:boolean};
const empty=():Page=>({items:[],total:0,generation:''});
const words=ref<Page>(empty()),documents=ref<Page>(empty()),fragments=ref<Page>(empty());
const wordQuery=ref(''),documentQuery=ref(''),selected=ref(''),resource=ref('');
const wordOffset=ref(0),documentOffset=ref(0),fragmentOffset=ref(0);
const loading=ref([false,false,false]),errors=ref(['','','']),fullText=ref(''),fullLoading=ref(false);
// 三层独立请求及代次；取消与代次检查共同阻止旧结果覆盖新的选择。
const controllers:(AbortController|undefined)[]=[];
const versions=[0,0,0,0];let disposed=false;let navigation=0;let retryTimer:ReturnType<typeof setTimeout>|undefined;
const statusText=(page:Page)=>page.status?.state==='rebuilding'&&page.status.failed?'重建中有文档处理失败，正在等待重试。':({pending:'关键词索引待更新，请稍后刷新。',rebuilding:'正在重新生成关键词，完成后可浏览。',partial:'部分文档仍在处理，当前显示已完成结果。',failed:'部分文档处理失败，当前显示已完成结果。'}[page.status?.state??'']??'');
function cancel(level:number){versions[level]++;controllers[level]?.abort();controllers[level]=undefined;if(level<3)loading.value[level]=false;else fullLoading.value=false;}
function resetChildren(level:number){for(let i=level;i<4;i++)cancel(i);if(level<=1){documents.value=empty();resource.value='';documentOffset.value=0;}if(level<=2){fragments.value=empty();fragmentOffset.value=0;}fullText.value='';}
async function read(url:string,signal:AbortSignal){const response=await fetch(url,{signal});const body=await response.json();if(!response.ok||!body.ok)throw Object.assign(new Error(body.error?.message??'读取失败'),{code:body.error?.code});return body.data;}
function save(){const p=new URLSearchParams({type:'keyword',cq:wordQuery.value,q:documentQuery.value,co:String(wordOffset.value),offset:String(documentOffset.value),fo:String(fragmentOffset.value)});if(selected.value)p.set('id',selected.value);if(resource.value)p.set('resource',resource.value);const hash='#browse?'+p;if(location.hash!==hash)history.pushState(null,'',hash);}
function params(offset:number){const p=new URLSearchParams({type:'keyword',offset:String(offset),limit:String(PAGE)});if(words.value.generation)p.set('generation',words.value.generation);return p;}
async function request(level:number,url:string,apply:(data:Page)=>void){
  cancel(level);const version=versions[level],controller=new AbortController();controllers[level]=controller;loading.value[level]=true;errors.value[level]='';
  try{const data=await read(url,controller.signal);if(!disposed&&version===versions[level])apply(data);}
  catch(e:any){if(!disposed&&version===versions[level]&&e.name!=='AbortError'){
    if(e.code==='KEYWORD_GENERATION_CHANGED'){resetChildren(1);selected.value='';wordOffset.value=0;words.value=empty();save();errors.value[0]='索引已更新，已重置分页，请刷新关键词。';}
    else errors.value[level]=e.message;
  }}finally{if(version===versions[level])loading.value[level]=false;}
}
async function loadWords(){
  if(retryTimer)clearTimeout(retryTimer);
  const p=new URLSearchParams({type:'keyword',q:wordQuery.value,offset:String(wordOffset.value),limit:String(PAGE)});
  if(wordOffset.value&&words.value.generation)p.set('generation',words.value.generation);
  await request(0,'/api/browse/collections?'+p,data=>{
    const unavailable=['pending','rebuilding'].includes(data.status?.state??'');
    if(unavailable||(words.value.generation&&data.generation!==words.value.generation)){resetChildren(1);selected.value='';if(unavailable)wordOffset.value=0;save();}
    words.value=data;
    if(['pending','rebuilding','partial'].includes(data.status?.state??''))retryTimer=setTimeout(()=>{if(!disposed)void loadWords();},3000);
  });
}
async function loadDocuments(){if(!selected.value)return;const p=params(documentOffset.value);p.set('id',selected.value);p.set('q',documentQuery.value);await request(1,'/api/browse/documents?'+p,data=>{documents.value=data;});}
async function loadFragments(){if(!resource.value)return;const p=params(fragmentOffset.value);p.set('id',selected.value);p.set('resourceId',resource.value);const doc=documents.value.items.find(x=>x.resource.id===resource.value);if(doc)p.set('version',String(doc.resource.contentVersion));await request(2,'/api/browse/fragments?'+p,data=>{fragments.value=data;});}
async function choose(id:string){navigation++;resetChildren(1);selected.value=id;documentQuery.value='';documents.value=empty();errors.value=['','',''];save();await loadDocuments();}
async function chooseDocument(id:string){navigation++;resetChildren(2);resource.value=id;errors.value[2]='';save();await loadFragments();}
async function searchWords(){navigation++;resetChildren(1);selected.value='';wordOffset.value=0;save();await loadWords();}
async function searchDocuments(){navigation++;resetChildren(2);resource.value='';documentOffset.value=0;save();await loadDocuments();}
async function turn(level:number,delta:number){navigation++;if(level===0){resetChildren(1);selected.value='';wordOffset.value+=delta;save();await loadWords();}else if(level===1){resetChildren(2);resource.value='';documentOffset.value+=delta;save();await loadDocuments();}else{fragmentOffset.value+=delta;save();await loadFragments();}}
async function readFull(){cancel(3);const version=versions[3],controller=new AbortController();controllers[3]=controller;fullLoading.value=true;try{const data=await read('/api/resources/'+encodeURIComponent(resource.value),controller.signal);if(!disposed&&version===versions[3])fullText.value=data.content?.text??'';}catch(e:any){if(version===versions[3]&&e.name!=='AbortError')errors.value[2]=e.message;}finally{if(version===versions[3])fullLoading.value=false;}}
async function restore(){
  const p=new URLSearchParams(location.hash.split('?')[1]);if(p.get('type')!=='keyword')return;
  const turn=++navigation;resetChildren(0);words.value=empty();errors.value=['','',''];
  wordQuery.value=p.get('cq')??'';documentQuery.value=p.get('q')??'';selected.value=p.get('id')??'';resource.value=p.get('resource')??'';
  const number=(key:string)=>Math.max(0,Math.floor(Number(p.get(key))||0));wordOffset.value=number('co');documentOffset.value=number('offset');fragmentOffset.value=number('fo');
  await loadWords();if(turn!==navigation||disposed)return;if(selected.value)await loadDocuments();if(turn!==navigation||disposed)return;if(resource.value)await loadFragments();
}
onMounted(()=>{void restore();window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);});
onUnmounted(()=>{disposed=true;navigation++;for(let i=0;i<4;i++)cancel(i);if(retryTimer)clearTimeout(retryTimer);window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);});
</script>

<template>
  <div class="keyword-browser">
    <section class="keyword-list" :aria-busy="loading[0]">
      <h2>关键词</h2>
      <form @submit.prevent="searchWords"><input v-model="wordQuery" aria-label="搜索关键词" placeholder="搜索关键词"><button>搜索</button><button type="button" :disabled="loading[0]" @click="loadWords">刷新关键词</button></form>
      <p v-if="errors[0]" role="alert" class="error">{{errors[0]}}</p><p v-if="statusText(words)" role="status">{{statusText(words)}}</p>
      <p v-if="loading[0]" role="status">正在加载关键词…</p>
      <template v-else><button v-for="item in words.items" :key="item.id" class="keyword-row" :aria-pressed="selected===item.id" @click="choose(item.id)">{{item.name}}</button>
        <p v-if="!errors[0]&&!words.items.length&&words.status?.state==='ready'">暂无匹配关键词</p></template>
      <div class="pagination"><button :disabled="loading[0]||wordOffset===0" @click="turn(0,-PAGE)">上一页</button><span>{{words.total}} 个关键词</span><button :disabled="loading[0]||wordOffset+PAGE>=words.total" @click="turn(0,PAGE)">下一页</button></div>
    </section>
    <section class="keyword-documents" :aria-busy="loading[1]">
      <h2>关联文档</h2><p v-if="!selected">选择关键词后查看关联文档。</p>
      <template v-else><h3>{{documents.keyword?.name}}</h3><form @submit.prevent="searchDocuments"><input v-model="documentQuery" aria-label="搜索关键词关联文档" placeholder="搜索标题或摘要"><button>搜索</button></form>
        <p v-if="errors[1]" role="alert" class="error">{{errors[1]}}</p><p v-if="statusText(documents)" role="status">{{statusText(documents)}}</p><p v-if="loading[1]" role="status">正在加载关联文档…</p>
        <template v-else><button v-for="item in documents.items" :key="item.resource.id" class="keyword-document" :aria-pressed="resource===item.resource.id" @click="chooseDocument(item.resource.id)"><strong>{{item.title}}</strong><small>v{{item.resource.contentVersion}}</small><p>{{item.summary}}</p></button>
          <p v-if="documents.missing">该关键词已失效，请重新选择。</p><p v-else-if="!errors[1]&&!documents.items.length&&documents.status?.state==='ready'">暂无关联文档</p></template>
        <div class="pagination"><button :disabled="loading[1]||documentOffset===0" @click="turn(1,-PAGE)">上一页</button><span>{{documents.total}} 篇文档</span><button :disabled="loading[1]||documentOffset+PAGE>=documents.total" @click="turn(1,PAGE)">下一页</button></div>
      </template>
    </section>
    <section class="keyword-fragments" :aria-busy="loading[2]">
      <h2>命中片元</h2><p v-if="!resource">选择文档后查看命中片元和原文位置。</p>
      <template v-else><p v-if="errors[2]" role="alert" class="error">{{errors[2]}}</p><p v-if="statusText(fragments)" role="status">{{statusText(fragments)}}</p><p v-if="loading[2]" role="status">正在加载命中片元…</p>
        <template v-else><article v-for="item in fragments.items" :key="item.id" class="keyword-fragment"><h3>{{item.title}}</h3><small>原文 v{{item.contentVersion}} · 第 {{item.startLine}}–{{item.endLine}} 行</small><p>关键词：{{item.evidence.value}}</p><pre>{{item.text}}</pre></article><p v-if="!errors[2]&&!fragments.items.length&&fragments.status?.state==='ready'">暂无命中片元</p></template>
        <div class="pagination"><button :disabled="loading[2]||fragmentOffset===0" @click="turn(2,-PAGE)">上一页</button><span>{{fragments.total}} 个片元</span><button :disabled="loading[2]||fragmentOffset+PAGE>=fragments.total" @click="turn(2,PAGE)">下一页</button></div>
        <button :disabled="fullLoading" @click="readFull">{{fullLoading?'正在读取全文…':'阅读文档全文'}}</button><pre v-if="fullText" class="keyword-fulltext">{{fullText}}</pre>
      </template>
    </section>
  </div>
</template>

<style scoped>
.keyword-list form input{flex-basis:100%;width:100%}
.keyword-browser{display:grid;grid-template-columns:minmax(190px,.65fr) minmax(240px,1fr) minmax(300px,1.4fr);gap:16px;align-items:start}.keyword-browser section{background:white;border:1px solid #dfe7df;border-radius:8px;padding:18px;min-width:0;overflow-wrap:anywhere}.keyword-browser h2{margin-bottom:16px}.keyword-browser form,.pagination{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.keyword-browser input{min-width:0;max-width:100%;flex:1;padding:8px;border:1px solid #dfe7df}.keyword-row,.keyword-document{display:block;width:100%;text-align:left;margin:8px 0;overflow-wrap:anywhere}.keyword-row[aria-pressed=true],.keyword-document[aria-pressed=true]{background:#edf3e9;border-color:#64856c}.keyword-document small{display:block;margin-top:8px}.keyword-document p{font-size:13px;line-height:1.5}.keyword-fragment{border-bottom:1px solid #dfe7df;padding:14px 0}.keyword-browser pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.7;font-size:13px}.keyword-browser small{color:#61776a}.pagination{align-items:center;font-size:12px}@media(max-width:1100px){.keyword-browser{grid-template-columns:1fr 1.5fr}.keyword-fragments{grid-column:1/-1}}@media(max-width:700px){.keyword-browser{display:block}.keyword-browser section{margin-bottom:12px;padding:12px}}
</style>
