import { realpath } from 'node:fs/promises';
import { CoreManager } from '../core/manager.js';
import { assert } from '../core/errors.js';
import { exclusive } from '../recall/models.js';
import { SemanticStore } from './store.js';
import { requireSemanticPlugins } from './source.js';
import { locateService } from '../service/client.js';

/** 显式丢弃整理数据；正文与历史由核心 API 保留，中断后可重复执行。 */
export async function resetSemantic(dataDir:string,discardExisting:boolean) {
  assert(discardExisting===true,'CONFIRM_REQUIRED','重置必须显式指定 discardExisting=true');
  dataDir=await realpath(dataDir);
  assert(!await locateService(dataDir),'SERVICE_RUNNING','请先停止该库服务，避免后台任务与重置并发');
  return exclusive('semantic:'+(process.platform==='win32'?dataDir.toLowerCase():dataDir),async()=>{
    const manager=await CoreManager.open(dataDir);
    let resources=0,tags=0;
    try {
      await requireSemanticPlugins(manager);
      const organizations=await manager.listOrganizations(),definitions=organizations.filter(t=>t.type==='tag'),ids=new Set(definitions.map(t=>t.id));
      const all=await manager.listResources({includeDeleted:true});
      // 非整理业务的引用不能随重置静默删除；先预检再开始写入。
      assert(!organizations.some(o=>o.type!=='tag'&&o.references.some(r=>r.kind==='organization'&&ids.has(r.id))),'REFERENCED','标签仍被其他组织引用，不能直接重置');
      assert(!all.some(({resource:r})=>r.references.some(ref=>ref.kind==='organization'&&ids.has(ref.id)&&ref.owner!=='tags'&&ref.owner!=='keywords')),'REFERENCED','标签仍被其他插件引用，不能直接重置');
      const store=await SemanticStore.open(dataDir);
      try{store.setSetting('semantic-reset','running');store.setSetting('keyword-rebuild','running');}finally{store.close();}
      for(const {resource} of all) {
        await manager.updatePluginMeta(resource.id,'tags',{decisions:[]},{references:[]});
        await manager.updatePluginMeta(resource.id,'keywords',{inputVersion:resource.contentVersion,processorVersion:'pending-reset',items:[]},{references:[]});
        resources++;
      }
      // 标签之间也可能互相引用；先清除内部引用，再移除全部定义及删除抑制记录。
      for(const tag of definitions)if(tag.references.length)await manager.updateOrganization(tag.id,{references:[]});
      for(const tag of definitions){await manager.deleteOrganization(tag.id);tags++;}
      await manager.pluginStore('organizer').write('candidates',[]);
      const queue=await manager.pluginStore('tasks').read<any[]>('queue',[]);
      await manager.pluginStore('tasks').write('queue',queue.filter(t=>t.type!=='organizer.resource'));
      const relations=await manager.storage.files('plugins/relations/data');
      const obsolete=relations.filter(file=>definitions.some(t=>file.endsWith('/'+t.id+'.json')));
      if(obsolete.length)await manager.storage.transaction(obsolete.map(file=>({file,value:null})));
    }finally{await manager.close();}
    const store=await SemanticStore.open(dataDir);
    try{store.transaction(()=>{
      for(const table of ['match_evidence','matches','labels','keyword_links','keyword_terms','keyword_documents','fragments','derivations','jobs'])store.run('DELETE FROM '+table);
      store.run("DELETE FROM settings WHERE key IN ('keyword-source-generation','keyword-rebuild')");
      store.setSetting('semantic-reset','complete');store.bumpKeywordRevision();
    });}finally{store.close();}
    return {resources,tags,reset:true};
  });
}
