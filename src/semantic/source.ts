import { access } from 'node:fs/promises';
import { safeDirectory } from '../recall/models.js';
import { assert } from '../core/errors.js';
import { CoreManager } from '../core/manager.js';
import { hash } from '../recall/scope.js';
import { extractContent } from '../plugins/content/extract.js';
import type { Organization, ResourceMeta } from '../contracts/index.js';
import type { SourceRecord } from '../recall/types.js';
import { KEYWORD_VERSION, MATCH_VERSION } from './types.js';
import { SPLITTER_VERSION } from '../recall/fragments.js';

export const tagText = (tag: Organization) => [tag.name, ...(Array.isArray(tag.data.aliases) ? tag.data.aliases : []), tag.data.description ?? ''].join('\n');
export const resourceSignature = (r: ResourceMeta, model: string) => hash(JSON.stringify([r.contentVersion,r.hash,r.originalName,SPLITTER_VERSION,KEYWORD_VERSION,model]));
export const tagSignature = (tag: Organization, model: string) => hash(JSON.stringify([tagText(tag),tag.data.semanticRematch ?? '',MATCH_VERSION,model]));
export const activeTag = (tag: Organization) => tag.type === 'tag' && !tag.data.semanticDeletedAt;
export async function source(dataDir: string) {
  const manager = await CoreManager.open(dataDir,{readOnly:true});
  try { return await manager.storage.snapshot(async () => ({ resources:(await manager.listResources()).map(x=>x.resource), tags:(await manager.listOrganizations('tag')).filter(activeTag) })); }
  finally { await manager.close(); }
}
export async function sourceRecord(dataDir: string, resource: ResourceMeta): Promise<SourceRecord | undefined> {
  const manager = await CoreManager.open(dataDir,{readOnly:true});
  try {
    const bytes = await manager.readContent(resource.id,resource.contentVersion);
    if (hash(bytes)!==resource.hash) throw new Error('CONTENT_HASH_MISMATCH');
    const parsed=extractContent(resource.originalName,bytes);
    if(parsed.status!=='parsed') return undefined;
    return {resourceId:resource.id,contentVersion:resource.contentVersion,contentHash:resource.hash,title:resource.originalName,modules:[],organizationIds:[],tagIds:[],sourcePaths:[],recordType:'resource',recordedAt:resource.createdAt,text:parsed.text};
  } finally { await manager.close(); }
}

/** 未准备向量模型、也未使用新入口的旧库保持原来的只读行为。 */
export async function semanticEnabled(dataDir:string):Promise<boolean> {
  const manager=await CoreManager.open(dataDir,{readOnly:true});
  try{await requireSemanticPlugins(manager);}catch(error){if((error as any).code==='PLUGIN_UNAVAILABLE')return false;throw error;}finally{await manager.close();}
  const current=await source(dataDir);
  if(current.tags.some(t=>t.data.semanticOrigin||t.data.semanticRematch)||current.resources.some(r=>String(r.plugins.keywords?.data.processorVersion??'').startsWith('semantic-keywords-')))return true;
  try{await access(await safeDirectory(dataDir,'cache/recall-models/lock.json'));return true;}catch(error){if((error as any).code==='ENOENT')return false;throw error;}
}

export async function requireSemanticPlugins(manager:CoreManager) {
  const state=await manager.pluginStore('core-host').read<{disabled?:string[];blockedPlugins?:string[];dataVersions?:Record<string,number>}>('state',{});
  assert(['content','keywords','tags'].every(id=>state.dataVersions?.[id]===undefined||state.dataVersions[id]===1),'UNSUPPORTED_PLUGIN_SCHEMA','语义整理不支持未来插件数据版本');
  const unavailable=[...(state.disabled??[]),...(state.blockedPlugins??[])];
  assert(!['content','keywords','tags'].some(id=>unavailable.includes(id)),'PLUGIN_UNAVAILABLE','语义整理需要启用正文、关键词和标签插件');
}
