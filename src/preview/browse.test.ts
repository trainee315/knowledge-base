import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { handleService } from '../service/client.js';
import { openApplication } from '../index.js';
import { createPreviewServer } from './server.js';
import { browse } from './browse.js';

async function fingerprint(root: string): Promise<string> { const list: string[]=[];async function visit(p:string){for(const d of (await readdir(p,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(p,d.name);if(d.isDirectory())await visit(file);else list.push(file+':'+createHash('sha256').update(await readFile(file)).digest('hex'));}}await visit(root);return list.join('\n'); }

test('organization browser reads accepted tags, exact current keywords, recursive systems and pinned history without writes', async () => {
  const root=await mkdtemp(join(tmpdir(),'kb-browse-'));const data=join(root,'data');let preview:Awaited<ReturnType<typeof createPreviewServer>>|undefined;
  try {
    const app=await openApplication(data);const exec=(name:string,input:Record<string,unknown>={})=>app.plugins.execute(name,input,[]) as Promise<any>;
    const source=join(root,'source.md');await writeFile(source,'# old-history\n\nPMA compression');const first=(await app.manager.importResource(source)).resource;
    const other=join(root,'second.md');await writeFile(other,'# second document');const second=(await app.manager.importResource(other)).resource;
    const tags=await Promise.all(['A','B'].map(name=>exec('tag create',{name})));
    for(const [resource,tag,accepted] of [[first,tags[0],true],[first,tags[1],true],[second,tags[0],true],[second,tags[1],false]] as const)await exec('tag decide',{resourceId:resource.id,tagId:tag.id,accepted,source:'manual',reason:'fixture',contentVersion:1,tagRevision:tag.revision});
    await app.plugins.refresh();
    const system=await exec('system create',{name:'Tree'});
    await exec('system update',{id:system.id,nodes:[{id:'r',title:'root',order:0},{id:'child',parentId:'r',title:'nested',order:0},{id:'doc',parentId:'child',title:'first placement',resourceId:first.id,order:0},{id:'again',parentId:'r',title:'duplicate',resourceId:first.id,order:1},{id:'other',title:'outside',resourceId:second.id,order:2}]});
    const project=await exec('project-track create',{name:'Timeline'});
    const entry=(await exec('project-track add',{projectId:project.id,resourceId:first.id,title:'Baseline',role:'baseline',projectVersion:'0.0.3',stage:'verified'})).entry;
    await writeFile(source,'# current-history');await app.manager.updateResource(first.id,source);await app.plugins.refresh();
    await exec('project-track add',{projectId:project.id,resourceId:first.id,title:'Future plan',role:'change',projectVersion:'0.0.10',stage:'planned'});
    await app.manager.registerOrganizationType({id:'reading',name:'Reading',config:{}});
    const custom=await app.manager.createOrganization({type:'reading',name:'Reading',references:[{kind:'resource',id:first.id}]});
    await app.close();
    await handleService(['start'],data);
    const before=await fingerprint(data);const reader=await openApplication(data,{readOnly:true});
    const get=(p:string)=>browse(reader,new URL('http://localhost'+p)) as Promise<any>;
    const both='id='+tags[0].id+'&id='+tags[1].id;
    assert.equal((await get('/api/browse/documents?type=tag&'+both)).total,2);
    assert.equal((await get('/api/browse/documents?type=tag&tagMatch=all&'+both)).total,1);
    const command=spawnSync(process.execPath,[new URL('../cli/main.js',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'organize','query','--input','-','--tag-match','all','--data-dir',data,'--json'],{input:JSON.stringify({tags:tags.map(t=>t.id)}),encoding:'utf8',windowsHide:true});
    assert.equal(command.status,0,command.stdout+command.stderr);assert.equal(JSON.parse(command.stdout).data.total,1);
    assert.equal((await get('/api/browse/documents?type=tag&tagMatch=all&'+both)).items[0].resource.plugins,undefined);
    assert.equal((await reader.plugins.execute('organize query',{tags:tags.map(t=>t.id),tagMatch:'all'},[]) as any).total,1);
    const vocabulary=await get('/api/browse/collections?type=keyword');assert.equal(vocabulary.status.state,'pending'); // 旧词频元数据不冒充完整片元索引。
    assert.equal((await get('/api/browse/documents?type=keyword&id=definitely-not-a-term')).total,0);
    const tree=await get('/api/browse/documents?type=system&id='+system.id+'&nodeId=r');assert.equal(tree.total,1);assert.equal(tree.items[0].paths.length,2);assert.deepEqual(tree.nodes.map((n:any)=>n.id),['r','child','doc','again','other']);
    const timeline=await get('/api/browse/documents?type=project-development-tracking&id='+project.id+'&limit=1');assert.equal(timeline.total,2);assert.equal(timeline.items[0].text,undefined);assert.equal(timeline.items[0].entry.stage,'planned');assert.equal(timeline.baseline.entry.id,entry.id);assert.equal(timeline.baseline.text,undefined);
    const prior=await get('/api/browse/documents?type=project-development-tracking&id='+project.id+'&asOfVersion=0.0.3');assert.equal(prior.total,1);
    const historical=await get('/api/project-tracking/'+project.id+'/entries/'+entry.id);assert.match(historical.text,/old-history/);assert.doesNotMatch(historical.text,/current-history/);
    const generic=await get('/api/browse/documents?type=reading&id='+custom.id);assert.equal(generic.generic,true);assert.equal(generic.total,1);
    await assert.rejects(get('/api/browse/documents?type=tag&'+both+'&limit=201'),/分页/);
    await assert.rejects(get('/api/browse/documents?type=system&id='+system.id+'&nodeId=bad'),/节点不存在/);
    preview=await createPreviewServer({app:reader,dataDir:data,webDir:join(root,'unused')});
    assert.equal((await fetch(preview.url+'/api/browse/collections?type=tag',{method:'POST'})).status,405);
    assert.equal((await fetch(preview.url+'/api/browse/collections?type=tag',{headers:{Origin:'http://evil.example'}})).status,403);
    assert.equal((await fetch(preview.url+'/api/browse/documents?type=tag&id=invalid')).status,400);
    assert.equal((await fetch(preview.url+'/api/browse/collections?type=tag')).status,200);
    await preview.close();preview=undefined;assert.equal(await fingerprint(data),before);
  } finally {await preview?.close();await handleService(['stop'],data);await rm(root,{recursive:true,force:true});}
});

test('unavailable business views report plugin errors and stale keyword metadata is excluded', async()=>{
  const root=await mkdtemp(join(tmpdir(),'kb-browse-stale-'));const data=join(root,'data');
  try {
    const writer=await openApplication(data);const file=join(root,'doc.md');await writeFile(file,'PMA source');const resource=(await writer.manager.importResource(file)).resource;
    await writer.plugins.refresh();
    await writer.manager.updatePluginMeta(resource.id,'keywords',{inputVersion:999,processorVersion:'future',items:[{value:'stale-term',count:1,weight:1}]});
    await writer.close();
    let reader=await openApplication(data,{readOnly:true});
    assert.equal((await browse(reader,new URL('http://local/api/browse/collections?type=keyword')) as any).total,0);
    await reader.close();
    const app=await openApplication(data);await app.plugins.setEnabled('keywords',false,true);await app.close();
    reader=await openApplication(data,{readOnly:true});
    await assert.rejects(browse(reader,new URL('http://local/api/browse/collections?type=keyword')),error=>(error as any).code==='PLUGIN_UNAVAILABLE');
    await reader.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
