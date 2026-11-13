import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, selectKeywords, isUsefulTerm, isBoilerplate } from './keywords.js';

test('四段版本保持完整且不把复合术语的中心泛词单独提取',()=>{
  const terms=candidates('工具版本 26.1103.7773.0。事件中心提供生命周期管理。');
  assert(terms.some(t=>t.value==='26.1103.7773.0'));
  assert(!terms.some(t=>t.value==='26.1103.7773'||t.value==='中心'));
});

test('版本候选不把小数和百分比当版本，也不截断更多段的版本', () => {
  const text = '13.36% 和 57.30％，普通小数 13.36。版本 1.2.3、26.1103.7773.0、1.2.3.4.5、v2.3、v2.3.4-rc.1。伪版本 1.2.3% 与 v13.36 %。';
  const terms = candidates(text);
  for (const value of ['1.2.3', '26.1103.7773.0', '1.2.3.4.5', 'v2.3', 'v2.3.4-rc.1']) assert(terms.some(x => x.value === value), value);
  for (const value of ['13.36', '57.30', '26.1103.7773', '1.2.3.4', 'v13.36']) assert(!terms.some(x => x.value === value), value);
  assert.deepEqual(candidates('13.36% 57.30％ 1.2.3% v13.36 %'), []);
  assert.equal(isUsefulTerm('13.36'), false);
  assert.equal(isUsefulTerm('13.36%'), false);
  for (const term of terms) assert.equal(text.slice(term.start, term.end), term.value);
});

test('残句、哈希和文件路径不会成为关键词，版本实体保留', () => {
  const rejected = ['0.0.10 改动仍未', '0.0.10 修改不要', '以所列证据', '执行建议不', 'v0.0.10 主题为', 'create_worktree 从', 'git status 显示', 'bc20', '01a1aa3b', 'Desktop/export/base.git', 'add v0.0.9 transcript', 'state_5.sqlite'];
  for (const word of rejected) assert.equal(isUsefulTerm(word), false, word);
  const text = '版本 v2.3.1。\n关键词：事务隔离、向量索引。';
  const terms = candidates(text);
  assert(terms.some(x => x.value === 'v2.3.1'));
  assert(terms.some(x => x.value === '事务隔离'));
  for (const term of terms) assert.equal(text.slice(term.start, term.end), term.value);
});

test('显式字段保留新领域术语和混合标识符，不依赖内置正文名词表', () => {
  const text = '关键词：线粒体自噬、膜电位、CRISPR-Cas9、compact snapshot、退出码99、未缓存输入、纯规则验证、null。';
  const terms = candidates(text);
  for (const value of ['线粒体自噬', '膜电位', 'CRISPR-Cas9', 'compact snapshot', '退出码99', '未缓存输入', '纯规则验证', 'null']) assert(terms.some(x => x.value === value && x.source === 'explicit'), value);
  const selected = selectKeywords(terms, terms.map(() => [0, 1]), [1, 0]);
  assert.equal(selected.length, terms.length, '显式术语不因长片元低向量相似度丢失');
});

test('正文泛名词、普通英语和测试文件不靠相似度入选', () => {
  const terms = candidates('候选、日期、实例、输入、内部、单一、未知、类型。because doing selected settings denied。browse.test independent.tap foo.test.ts。调用 prefab_inspect 与 SQLite。');
  for (const value of ['候选', '日期', '实例', '输入', '内部', '单一', '未知', '类型', 'because', 'doing', 'selected', 'settings', 'denied', 'browse.test', 'independent.tap', 'foo.test.ts']) assert(!terms.some(x => x.value === value), value);
  for (const value of ['prefab_inspect', 'SQLite']) assert(terms.some(x => x.value === value), value);
});

test('标题、正文术语和完整产品名保留原文偏移', () => {
  const text = '# 事务隔离与向量索引\n\nPersonal Project Center 管理纹理压缩与 ASTC。调用 `prefab_inspect`。';
  const terms = candidates(text);
  for (const value of ['Personal Project Center', '纹理压缩', 'ASTC', 'prefab_inspect', '向量索引']) assert(terms.some(x => x.value === value), value);
  assert(!terms.some(x => /^管理/.test(x.value)));
  for (const term of terms) assert.equal(text.slice(term.start, term.end), term.value);
});

test('追溯模板不提词，后续实质章节正常提取', () => {
  const text = '## 来源与追溯\n\n- Session：01a1aa49-b4b9-7731-a17e-3647ecf83390\n本文是会话事务的整理，状态以所列证据时点为准。\n\n## 向量索引\n\n关键词：向量索引、事务隔离。';
  const terms = candidates(text);
  assert(terms.length > 0);
  assert(terms.every(x => x.start >= text.indexOf('## 向量索引')));
  assert(isBoilerplate('## 来源与追溯'));
  assert.equal(candidates('本文是会话事务的整理，状态以所列证据时点为准。').length, 0);
});

test('低质量片元允许零词，重复候选不产生重复计数', () => {
  assert.deepEqual(candidates('用户要求修改，随后完成提交并确认。'), []);
  const terms = candidates('`prefab_inspect` 与 prefab_inspect。');
  assert.equal(terms.find(x => x.value === 'prefab_inspect')?.count, 2);
  const selected = selectKeywords(candidates('向量索引'), [[0, 1], [0, 1], [0, 1]], [1, 0]);
  assert.deepEqual(selected, []);
});

test('陌生领域标题保留完整概念，不依赖显式关键词或技术词表', () => {
  const text = '# 线粒体自噬与膜电位\n\n## 无监督聚类及流形学习\n\n## 前端架构与后端接口\n';
  const terms = candidates(text);
  for (const value of ['线粒体自噬', '膜电位', '无监督聚类', '流形学习', '前端架构', '后端接口']) assert(terms.some(x => x.value === value && x.source === 'heading'), value);
  assert(!candidates('# 用户要求先确认方案\n\n## 0.0.10 改动仍未提交\n').some(x => /要求|仍未|确认方案/.test(x.value)));
  for (const term of terms) assert.equal(text.slice(term.start, term.end), term.value);
});

test('带数字分界的类型名和 API 标识符保持可检索', () => {
  const text = 'Term0Unique、Term119Unique 与 API2Client 使用同一索引。';
  const terms = candidates(text);
  for (const value of ['Term0Unique', 'Term119Unique', 'API2Client']) assert(terms.some(x => x.value === value), value);
  for (const term of terms) assert.equal(text.slice(term.start, term.end), term.value);
});

test('标题不能绕过叙述筛选，词尾单位和未结束词组不会被截断', () => {
  const text = '# 为什么重划边界\n\n## 交付 008 实施提示词\n\n## 向 OpenAI 上报\n\n## 代码现状核查\n\n固定输入截止点，固定压缩率，完成压缩。RGB5位量化，T05:14:20。';
  const terms = candidates(text);
  for (const value of ['为什么重划边界', '交付 008 实施提示词', '向 OpenAI 上报', '代码现状核查', '固定输入', '固定压缩', '完成压缩', 'RGB5', 'T05']) assert(!terms.some(x => x.value === value), value);
  assert(!candidates('常量、界面、分支、经验、结论、增量、字节、完整性、设计、签名。Reproduction App commit。').length);
});
