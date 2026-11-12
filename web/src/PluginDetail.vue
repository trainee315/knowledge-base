<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import CronPlans from './CronPlans.vue';
import {
  DETAIL_PAGE_SIZE, PluginRequestError, localHref, pluginHash, pluginRequest,
  type DataRow, type Page, type PluginDetail, type Values, type View,
} from './plugin-detail';

const props = defineProps<{ id: string; route: string }>();
const sections: { id: View; label: string }[] = [
  { id: 'overview', label: '简介' }, { id: 'config', label: '配置' }, { id: 'data', label: '维护中的数据' },
];
const routeParams = computed(() => new URLSearchParams(props.route.split('?')[1] ?? ''));
const view = computed<View>(() => {
  const value = routeParams.value.get('view');
  return value === 'config' || value === 'data' ? value : 'overview';
});
const configKey = computed(() => routeParams.value.get('configKey') ?? '');
const detail = ref<PluginDetail>();
const page = ref<Page<DataRow>>();
const draft = ref<Values>({});
const latest = ref<PluginDetail>();
const loadError = ref('');
const pageError = ref('');
const formError = ref('');
const notice = ref('');
const conflict = ref(false);
const saving = ref(false);
const comparing = ref(false);
const checking = ref(false);
const connection = ref('');
const creating = ref(false);
const newProfileId = ref('codex-session');
const newModel = ref('');
const visibleFields = computed(() => (detail.value?.configuration.fields ?? []).filter(field => props.id !== 'agent' || (draft.value.providerId === 'codex-cli' ? !['temperature', 'reasoning'].includes(field.key) : field.key !== 'reasoningEffort')));
watch(() => draft.value.providerId, value => { if (value === 'codex-cli') { draft.value.temperature = 0; draft.value.reasoning = 'off'; } });
async function inspectAgent(action: 'check' | 'test') {
  const config = detail.value?.configuration;
  if (!config || dirty.value || checking.value) return;
  checking.value = true; connection.value = '';
  try {
    const result = await pluginRequest<any>(path.value + '/' + action, { method: 'POST', body: { values: {}, expectedConfigVersion: config.configVersion, configKey: config.key } });
    const labels: Record<string, string> = { ready: '已就绪', missing: '服务器未安装 CLI', 'not-logged-in': '服务器运行账号未使用 ChatGPT 登录', unsupported: 'CLI 版本或安装布局不受支持', error: '检测失败', 'not-configured': '未配置 API 凭证' };
    connection.value = action === 'check' ? (labels[result.state] ?? '检测失败') + (result.version ? ' · ' + result.version : '') : '连接测试通过 · ' + result.model + ' · ' + result.elapsedMs + 'ms · ' + result.usage.totalTokens + ' tokens';
  } catch (error) { connection.value = (error as Error).message; }
  finally { checking.value = false; }
}
async function createCodexProfile() {
  if (!newProfileId.value.trim() || !newModel.value.trim() || saving.value) return;
  saving.value = true; formError.value = '';
  try {
    const profile = await pluginRequest<{id: string}>(path.value + '/profiles', { method: 'POST', body: { values: { id: newProfileId.value.trim(), model: newModel.value.trim() }, expectedConfigVersion: detail.value?.configuration.configVersion ?? '0'.repeat(64) } });
    creating.value = false;
    location.hash = address('config', { configKey: profile.id });
  } catch (error) { formError.value = (error as Error).message; }
  finally { saving.value = false; }
}
const cron = ref<InstanceType<typeof CronPlans>>();

const path = computed(() => '/api/plugins/' + encodeURIComponent(props.id));
const detailPath = computed(() => path.value + (configKey.value ? '?' + new URLSearchParams({ configKey: configKey.value }) : ''));
const collection = computed(() => {
  const collections = detail.value?.collections ?? [];
  return collections.find(item => item.id === routeParams.value.get('collection')) ?? collections[0];
});
const offset = computed(() => {
  const value = Number(routeParams.value.get('offset') ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
});
const original = computed(() => detail.value?.configuration.values ?? {});
const dirty = computed(() => Object.keys(draft.value).some(key => draft.value[key] !== original.value[key]));
const statusLabel = computed(() => {
  const plugin = detail.value;
  if (!plugin?.enabled) return '已停用';
  if (plugin.status === 'failed') return '加载失败';
  return plugin.ready ? '已就绪' : '未就绪';
});

function address(section: View, params: Record<string, string> = {}): string {
  return pluginHash(props.id, section, { ...(configKey.value ? { configKey: configKey.value } : {}), ...params });
}
function dataAddress(id: string, start = 0): string {
  return address('data', { collection: id, ...(start > 0 ? { offset: String(start) } : {}) });
}
function accept(value: PluginDetail) {
  connection.value = '';
  detail.value = value;
  draft.value = { ...value.configuration.values };
  latest.value = undefined;
  conflict.value = false;
  formError.value = '';
}
function discard() {
  draft.value = { ...original.value };
  latest.value = undefined;
  conflict.value = false;
  formError.value = '';
  notice.value = '';
  cron.value?.discard();
}
function guard(event: Event) {
  if (saving.value || checking.value || cron.value?.saving) { event.preventDefault(); return; }
  if (!dirty.value && !cron.value?.dirty) return;
  if (!window.confirm('配置草稿尚未保存。放弃修改并离开？')) event.preventDefault();
  else discard();
}
function guardLink(event: MouseEvent) {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const href = (event.target as Element | null)?.closest('a')?.getAttribute('href');
  if (href && href !== location.hash && localHref(href)) guard(event);
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || cron.value?.dirty || saving.value || cron.value?.saving) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => {
  window.addEventListener('kb-before-navigation', guard);
  window.addEventListener('beforeunload', beforeUnload);
});
onUnmounted(() => {
  window.removeEventListener('kb-before-navigation', guard);
  window.removeEventListener('beforeunload', beforeUnload);
});

watch(detailPath, async (url, _previous, cleanup) => {
  const request = new AbortController();
  cleanup(() => request.abort());
  detail.value = undefined;
  loadError.value = '';
  notice.value = '';
  connection.value = '';
  try { accept(await pluginRequest<PluginDetail>(url, { signal: request.signal })); }
  catch (error) { if (!request.signal.aborted) loadError.value = (error as Error).message; }
}, { immediate: true });

const dataPath = computed(() => view.value === 'data' && collection.value
  ? path.value + '/data/' + encodeURIComponent(collection.value.id) + '?' + new URLSearchParams({ offset: String(offset.value), limit: String(DETAIL_PAGE_SIZE) })
  : '');
watch(dataPath, async (url, _previous, cleanup) => {
  const request = new AbortController();
  cleanup(() => request.abort());
  page.value = undefined;
  pageError.value = '';
  if (!url) return;
  try { page.value = await pluginRequest<Page<DataRow>>(url, { signal: request.signal }); }
  catch (error) { if (!request.signal.aborted) pageError.value = (error as Error).message; }
}, { immediate: true });

function selectConfig(event: Event) {
  const select = event.target as HTMLSelectElement;
  const key = select.value;
  // Restore the shown option if navigation is cancelled by the draft guard.
  select.value = detail.value?.configuration.key ?? configKey.value;
  const navigation = new Event('kb-before-navigation', { cancelable: true });
  guard(navigation);
  if (!navigation.defaultPrevented) location.hash = address('config', { configKey: key });
}
function selectCollection(event: Event) {
  location.hash = dataAddress((event.target as HTMLSelectElement).value);
}
async function save() {
  const config = detail.value?.configuration;
  if (!config?.editable || !config.configVersion || !dirty.value || saving.value) return;
  saving.value = true;
  notice.value = '';
  formError.value = '';
  try {
    accept(await pluginRequest<PluginDetail>(path.value + '/config', {
      method: 'PATCH',
      body: { values: draft.value, expectedConfigVersion: config.configVersion, ...(config.key ? { configKey: config.key } : {}) },
    }));
    notice.value = '配置已保存';
  } catch (error) {
    conflict.value = error instanceof PluginRequestError && error.status === 409 && error.code === 'CONFIG_CONFLICT';
    latest.value = undefined;
    formError.value = (error as Error).message;
  } finally { saving.value = false; }
}
async function compareLatest() {
  comparing.value = true;
  try { latest.value = await pluginRequest<PluginDetail>(detailPath.value); }
  catch (error) { formError.value = (error as Error).message; }
  finally { comparing.value = false; }
}
function rebase() {
  if (!latest.value) return;
  const changes = Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== original.value[key]));
  accept(latest.value);
  for (const field of detail.value?.configuration.fields ?? []) {
    if (Object.hasOwn(changes, field.key)) draft.value[field.key] = changes[field.key];
  }
  notice.value = '已加载最新版本并保留草稿中的修改，请核对后保存。';
}
function display(value: unknown): string {
  return value === true ? '是' : value === false ? '否' : value === undefined || value === null || value === '' ? '未设置' : String(value);
}
</script>

<template>
  <section class="plugin-detail" @click="guardLink">
    <a class="plugin-back" href="#plugins">← 返回插件列表</a>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <p v-else-if="!detail" role="status">正在读取插件…</p>
    <template v-else>
      <div class="plugin-title">
        <div>
          <h2>{{ detail.name }}</h2>
          <p class="muted">{{ detail.id }} · v{{ detail.version }}</p>
        </div>
        <span class="status" :class="{ 'plugin-unavailable': !detail.ready }">{{ statusLabel }}</span>
      </div>
      <div class="plugin-tabs" aria-label="插件详情导航">
        <a v-for="item in sections" :key="item.id" :href="address(item.id)" :aria-current="view === item.id ? 'page' : undefined">{{ item.label }}</a>
      </div>
      <p v-if="detail.failure" class="error" role="alert">{{ detail.failure }}</p>

      <section v-if="view === 'overview'" class="plugin-surface" aria-label="简介">
        <p>{{ detail.description }}</p>
        <dl class="plugin-facts">
          <div><dt>直接依赖</dt><dd>
            <template v-if="Object.keys(detail.dependencies).length">
              <a v-for="(version, dependency) in detail.dependencies" :key="dependency" :href="pluginHash(String(dependency))">{{ dependency }} {{ version }}</a>
            </template>
            <template v-else>无</template>
          </dd></div>
          <div><dt>维护中的数据</dt><dd>{{ detail.maintains }}</dd></div>
        </dl>
      </section>

      <section v-else-if="view === 'config'" class="plugin-surface" aria-label="配置">
        <p v-if="detail.configuration.message" class="muted">{{ detail.configuration.message }}</p>
        <template v-if="detail.configuration.kind === 'none'">
          <p v-if="!detail.configuration.message">此插件没有可编辑的配置。</p>
        </template>
        <template v-else-if="detail.configuration.kind === 'link'">
          <a v-if="localHref(detail.configuration.href)" :href="localHref(detail.configuration.href)">打开配置页面 →</a>
        </template>
        <CronPlans v-else-if="detail.configuration.kind === 'cron'" ref="cron" :editable="detail.configuration.editable" />
        <form v-else class="plugin-form" @submit.prevent="save">
          <label v-if="detail.configuration.choices?.length">
            {{ detail.configuration.choicesLabel ?? '配置项' }}
            <select :value="detail.configuration.key" :disabled="saving || checking" @change="selectConfig">
              <option v-for="choice in detail.configuration.choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
            </select>
          </label>
          <div class="plugin-fields">
            <div v-for="field in visibleFields" :key="field.key" class="plugin-field">
              <label :class="{ 'plugin-check': field.type === 'boolean' }">
                <span>{{ field.label }}</span>
                <select v-if="field.type === 'select'" v-model="draft[field.key]" :aria-label="field.label" :aria-describedby="field.description ? 'plugin-help-' + field.key : undefined" :disabled="!detail.configuration.editable || saving || checking">
                  <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input v-else-if="field.type === 'boolean'" v-model="draft[field.key]" type="checkbox" :disabled="!detail.configuration.editable || saving">
                <input v-else-if="field.type === 'number'" v-model.number="draft[field.key]" type="number" step="any" :disabled="!detail.configuration.editable || saving">
                <input v-else v-model="draft[field.key]" :list="field.options?.length ? 'plugin-options-' + field.key : undefined" type="text" :disabled="!detail.configuration.editable || saving">
              </label>
              <datalist v-if="field.type === 'text' && field.options?.length" :id="'plugin-options-' + field.key"><option v-for="option in field.options.filter(option => !option.providerId || option.providerId === draft.providerId)" :key="option.value" :value="option.value">{{ option.label }}</option></datalist>
              <p v-if="field.description" :id="'plugin-help-' + field.key" class="muted plugin-field-help">{{ field.description }}</p>
              <ul v-if="field.options?.some(option => option.description)" class="plugin-mode-help">
                <li v-for="option in field.options" :key="option.value"><strong>{{ option.label }}</strong><span>{{ option.description }}</span></li>
              </ul>
            </div>
          </div>
          <section v-if="id === 'agent' && detail.configuration.editable" class="plugin-agent-tools">
            <p class="muted">状态检测针对服务器运行账号；编辑配置后请先保存。</p>
            <button type="button" :disabled="dirty || saving || checking" @click="inspectAgent('check')">检查登录状态</button>
            <button type="button" :disabled="dirty || saving || checking" @click="inspectAgent('test')">测试连接（消耗额度）</button>
            <p v-if="checking" role="status">正在检测…</p>
            <p v-if="connection" role="status">{{ connection }}</p>
            <button type="button" :disabled="dirty || saving || checking" @click="creating = !creating">新增 Codex 配置</button>
            <div v-if="creating">
              <label>配置 ID<input v-model="newProfileId" aria-label="新配置 ID" :disabled="saving" /></label>
              <label>模型 ID<input v-model="newModel" aria-label="新模型 ID" :disabled="saving" placeholder="输入账号可用的模型 ID" /></label>
              <button type="button" :disabled="saving || !newProfileId.trim() || !newModel.trim()" @click="createCodexProfile">创建配置</button>
            </div>
          </section>
          <p v-if="formError" class="error" role="alert">{{ formError }}<template v-if="conflict">。当前草稿已保留。</template></p>
          <p v-if="notice" class="plugin-notice" role="status">{{ notice }}</p>
          <div v-if="conflict" class="plugin-compare">
            <button type="button" :disabled="comparing" @click="compareLatest">查看最新配置</button>
            <template v-if="latest">
              <dl class="plugin-facts">
                <div v-for="field in latest.configuration.fields" :key="field.key">
                  <dt>{{ field.label }}</dt><dd>{{ display(latest.configuration.values?.[field.key]) }}</dd>
                </div>
              </dl>
              <button type="button" @click="rebase">以最新版本为基准保留草稿</button>
            </template>
          </div>
          <div v-if="detail.configuration.editable" class="plugin-actions">
            <button type="button" :disabled="!dirty || saving || checking" @click="discard">取消修改</button>
            <button class="primary" type="submit" :disabled="!dirty || saving || checking || conflict">{{ saving ? '保存中…' : '保存配置' }}</button>
          </div>
        </form>
      </section>

      <section v-else class="plugin-surface" aria-label="维护中的数据">
        <p v-if="!collection">此插件没有可浏览的数据集合。</p>
        <template v-else>
          <label class="plugin-select">
            数据集合
            <select :value="collection.id" @change="selectCollection">
              <option v-for="item in detail.collections" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </label>
          <p v-if="pageError" class="error" role="alert">{{ pageError }}</p>
          <p v-else-if="!page" role="status">正在读取数据…</p>
          <template v-else>
            <p v-if="!page.items.length" class="plugin-empty">当前集合没有可显示的记录。</p>
            <ul v-else class="plugin-rows">
              <li v-for="item in page.items" :key="item.id">
                <a v-if="localHref(item.href)" :href="localHref(item.href)">{{ item.label }} →</a>
                <strong v-else>{{ item.label }}</strong>
                <p v-if="item.summary" class="muted">{{ item.summary }}</p>
              </li>
            </ul>
            <div v-if="page.total > page.limit || page.offset" class="plugin-page">
              <a v-if="page.offset > 0" :href="dataAddress(collection.id, Math.max(0, page.offset - page.limit))">上一页</a>
              <span>{{ page.items.length ? page.offset + 1 : 0 }}–{{ Math.min(page.offset + page.limit, page.total) }} / {{ page.total }}</span>
              <a v-if="page.offset + page.limit < page.total" :href="dataAddress(collection.id, page.offset + page.limit)">下一页</a>
            </div>
          </template>
        </template>
      </section>
    </template>
  </section>
</template>

<style src="./plugin-detail.css"></style>
