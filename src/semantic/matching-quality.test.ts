import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFragment, matchingBody, tagQueries, termPosition } from './matching.js';
import { automaticConcepts } from './automatic-tags.js';
import type { SemanticFragment } from './types.js';

const tag=(name:string,aliases:string[]=[],description='')=>({name,data:{aliases,description}});
function fragment(text:string,overrides:Partial<SemanticFragment>={}):SemanticFragment {
  return {resourceId:'document',title:'专题.md',text,headings:[],ordinal:0,start:100,end:100+text.length,keywords:[],vectorKey:'vector',truncated:false,...overrides} as SemanticFragment;
}

test('低向量分数的明确事件正文可命中，来源追溯不冒充正文',()=>{
  const document=fragment('## 最小契约\n\non 注册事件处理者，emit 同步派发事件。',{title:'类型化事件中心的订阅.md',headings:['类型化事件中心','最小契约'],ordinal:2});
  const hit=matchFragment(tag('事件'),document,0.31)!;
  assert.equal(hit.status,'accepted');assert.equal(hit.evidence.scope,'body');
  assert.equal(document.text.slice(hit.evidence.start!-document.start,hit.evidence.end!-document.start),'事件');
  assert.equal(matchFragment(tag('事件'),fragment('## 来源与追溯\n\n本文是会话事务的整理，状态以所列证据时点为准。',{title:document.title,headings:['类型化事件中心','来源与追溯'],ordinal:4}),0.95),undefined);
});

test('别名独立编码并支持英文边界、全半角和原文位置',()=>{
  const definition=tag('预制体',['Prefab'],'Cocos Creator 资产');
  assert.deepEqual(tagQueries(definition),['预制体\nCocos Creator 资产','Prefab\nCocos Creator 资产']);
  assert.equal(termPosition('Prefabish 工具','Prefab'),undefined);
  const position=termPosition('示例：Ｐｒｅｆａｂ 组件','Prefab')!;
  assert.equal('示例：Ｐｒｅｆａｂ 组件'.slice(position.start,position.end),'Ｐｒｅｆａｂ');
  const hit=matchFragment(tag('预制体',['Prefab']),fragment('使用 Prefab 绑定脚本引用。'),0.25)!;
  assert.equal(hit.status,'accepted');assert.equal(hit.evidence.kind,'alias');assert.equal(hit.evidence.term,'Prefab');
});

test('标题与显式关键词仅形成文档依据，不能扩散到后续无关片元',()=>{
  const first=fragment('# Prefab 资产\n\n状态：已实现。',{title:'Prefab 资产.md'});
  assert.equal(matchFragment(tag('预制体',['Prefab']),first,0.2)!.evidence.scope,'document');
  assert.equal(matchFragment(tag('预制体',['Prefab']),fragment('这是关于天气与饮食的其他说明。',{title:first.title,ordinal:2}),0.2),undefined);
  const explicit=matchFragment(tag('依赖注入'),fragment('关键词：依赖注入、生命周期。\n\n状态：已讨论。'),0.2)!;
  assert.equal(explicit.evidence.kind,'explicit');assert.equal(explicit.evidence.scope,'document');
});

test('语义候选不计入正式命中，强语义保留无词面同义表达',()=>{
  const doc=fragment('将画面资源转换成更小体积的格式以减轻加载负担。');
  assert.equal(matchFragment(tag('纹理压缩'),doc,0.5)!.status,'candidate');
  assert.equal(matchFragment(tag('纹理压缩'),doc,0.8)!.status,'accepted');
  assert.equal(matchFragment(tag('事件'),fragment('早期 PNG 有损压缩全部被拒，继续调查透明像素。'),0.4108),undefined);
});

test('宽泛短词的单次偶然提及与明确不讨论的主题仅列候选',()=>{
  assert.equal(matchFragment(tag('事件'),fragment('该日志记录事件一次，本文主要解释图片压缩参数。'),0.3)!.status,'candidate');
  assert.equal(matchFragment(tag('事件中心'),fragment('这里只是提及事件中心作为背景，讨论的是图像导出。'),0.7)!.status,'candidate');
});

test('新增回归：范围排除不构成主题，后续真实实施仍能成为依据',()=>{
  for(const text of ['验证通过，未执行 DeployHub。','本次只提交修改，不做发布、远端推送或 DeployHub 操作。']) {
    const result=matchFragment(tag('DeployHub'),fragment(text),0.8)!;
    assert.equal(result.status,'candidate');assert.equal(result.evidence.reason,'excluded-scope');
  }
  const text='本次不执行 DeployHub。随后单独调查 DeployHub 的接口认证，发现令牌续期机制。';
  const result=matchFragment(tag('DeployHub'),fragment(text),0.4)!;
  assert.equal(result.status,'accepted');assert.equal(result.evidence.start,100+text.lastIndexOf('DeployHub'));
});

test('新增回归：标签清单、检索计数及模型测试材料属于词条元讨论',()=>{
  const samples=[
    ['资产绑定','用户指定标签（资源管理、资产绑定、性能分析），按标签整理文档。'],
    ['资产绑定','新增“资产绑定”标签只编码一条文本，比较两个片元。'],
    ['字段投影','资料库只读核验：图像压缩 4 篇、游戏架构 5 篇、字段投影可定位。'],
    ['场景配方','最终校订词表，符号引用、字段投影、场景配方等词组查询均命中。'],
    ['纹理压缩','真实模型样例使用两篇合成资料。“性能优化”匹配到纹理压缩文章，分数约为0.59，烹饪文章未达阈值。'],
  ];
  for(const [name,text] of samples){const result=matchFragment(tag(name),fragment(text),0.8)!;assert.equal(result.status,'candidate',text);assert.equal(result.evidence.reason,'meta-mention',text);}
  const real=matchFragment(tag('纹理压缩'),fragment('纹理压缩采用 ASTC 格式，减小显存占用。用实际纹理样本评估质量。',{title:'纹理压缩方法.md'}),0.3)!;
  assert.equal(real.status,'accepted');
});

test('新增回归：文件扩展名、进程名和路径不能构成正文术语命中',()=>{
  for(const [name,text] of [['MCP','结束 codebase-memory-mcp.exe 进程，释放目录占用。'],['PNG','配合 preview.png 与 images 文件交付设计资料。'],['knowledge-base','数据目录为 D:\\project\\knowledge-base\\.data。']]) {
    assert.equal(matchFragment(tag(name),fragment(text),0.3),undefined,text);
  }
  assert.equal(matchFragment(tag('cocos-prefab-mcp'),fragment('cocos-prefab-mcp 支持按字段投影读取节点。'),0.3)!.status,'accepted');
  assert.equal(matchFragment(tag('预制体',['Prefab']),fragment('# cocos-prefab-mcp',{title:'cocos-prefab-mcp Schema 说明.md'}),0.3)!.evidence.scope,'document');
});

test('复合产品标题同时支持别名与说明消歧，正文路径仍不提供概念证据',()=>{
  const definition=tag('可复用资产',['AssetTemplate'],'Nova 场景和 UI 的资产、节点、组件与创建修改工具。');
  const document=fragment('# Nova-AssetTemplate-MCP 调用故障\n\n来源：内部资料。',{title:'Nova-AssetTemplate-MCP 调用故障.md'});
  const hit=matchFragment(definition,document,0.4)!;
  assert.equal(hit.status,'accepted');assert.equal(hit.evidence.scope,'document');assert.equal(hit.evidence.term,'AssetTemplate');
  assert.equal(matchFragment(definition,fragment('结束 D:\\tools\\Nova-AssetTemplate-mcp.exe 进程并释放目录。'),0.2),undefined);
});

test('新增回归：回执示例、页面渲染和实验控制变量仅列候选',()=>{
  const samples=[
    ['AssetTool','写入完成返回回执（示例：已补充到“字段查询”，版本3，适用于 AssetTool），用户无需确认。','meta-mention'],
    ['项目基线','用浏览器验证两份文档均显示、项目基线正文正常渲染（bodyLength 2000）。','meta-mention'],
    ['提示词','最终输入的原始指纹、同一提示词与 schema 已核验，继续比较调用成本。','weak-mention'],
    ['CLI','组织实例别名用于展示和 CLI 定位，名称变更不影响历史。','weak-mention'],
    ['GraphTool','GraphTool 工具连接失败，改用源码回退。','weak-mention'],
  ];
  for(const [name,text,reason] of samples){const result=matchFragment(tag(name),fragment(text),0.5)!;assert.equal(result.status,'candidate',text);assert.equal(result.evidence.reason,reason,text);}
  assert.equal(matchFragment(tag('GraphTool'),fragment('GraphTool 工具连接失败，改用备用端口恢复连接。',{title:'GraphTool 连接故障处理.md'}),0.3)!.status,'accepted');
});

test('长说明对低相似度同名词消歧，原文模板屏蔽不改变偏移',()=>{
  const doc=fragment('# 苹果\n\n关键词：苹果。\n\n苹果含有膳食纤维。',{title:'苹果营养.md'});
  assert.equal(matchFragment(tag('苹果',[],'智能手机 操作系统 硬件设备'),doc,0.2)!.status,'candidate');
  assert.equal(matchingBody(doc).length,doc.text.length);
  assert(matchingBody(doc).includes('苹果含有膳食纤维'));
});

test('自动主题来自显式或标题支持，拒绝模板残句并保留单篇完整主题',()=>{
  const fixtures=[
    fragment('# 纹理压缩\n\n标签：纹理压缩。\n\n关键词：ASTC。',{title:'纹理压缩方案.md',resourceId:'a',keywords:[{value:'纹理压缩',start:0,end:4,count:1,score:0.8,source:'heading'}]}),
    fragment('# 纹理压缩\n\n标签：纹理压缩。',{title:'纹理压缩验证.md',resourceId:'b',keywords:[{value:'纹理压缩',start:0,end:4,count:1,score:0.8,source:'heading'},{value:'执行建议不',start:0,end:5,count:1,score:0.9}]}),
    fragment('# 类型化事件中心\n\n关键词：事件中心、监听优先级。',{title:'类型化事件中心.md',resourceId:'c'}),
  ];
  const names=automaticConcepts(fixtures).map(t=>t.name);
  assert(names.includes('纹理压缩'));assert(names.includes('事件中心'));assert(!names.includes('执行建议不'));
  assert.deepEqual(automaticConcepts(fixtures),automaticConcepts(fixtures));
});

test('自动主题不让高频两字动作挤掉单篇的明确概念，显式短术语仍可保留',()=>{
  const fixtures=Array.from({length:45},(_,index)=>fragment('标签：压缩。\n\n固定处理条件。',{resourceId:'a'+index,title:'固定与候选.md',keywords:[{value:'固定',count:1,start:0,end:2,score:0.99,source:'body'},{value:'候选',count:1,start:0,end:2,score:0.99,source:'heading'}]}));
  fixtures.push(fragment('关键词：事件中心。\n\n事件中心负责订阅与派发。',{resourceId:'topic',title:'事件中心生命周期.md'}));
  const names=automaticConcepts(fixtures).map(t=>t.name);
  assert(!names.includes('固定'));assert(!names.includes('候选'));assert(names.includes('事件中心'));assert(names.includes('压缩'));
});
