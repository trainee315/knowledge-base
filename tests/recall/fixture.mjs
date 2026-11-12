import { openApplication } from '../../dist/index.js';
import { noteCommand } from '../../dist/records/note.js';
import { configure } from '../../dist/recall/scope.js';

// 各主题互不共享文档；tune/acceptance 在生成时固定，验收查询不参与参数选择。
export const TOPICS = [
  ['combo', 'battle', '连击', '连击窗口为300毫秒。仅普通攻击命中后开始计时；闪避和受击必须清空计数。', '如何实现连续命中的攻击加成', '连击窗口'],
  ['retry', 'network', '重试', '只对幂等请求重试，最多3次，间隔200毫秒。鉴权失败不得重试。', '网络失败后哪些请求可以再次发送', '幂等请求'],
  ['save', 'storage', '存档', '写入临时文件后校验校验和，再原子替换正式存档。磁盘已满时保留旧文件并报错。', '如何避免保存过程中丢失已有数据', '原子替换'],
  ['damage', 'battle', '伤害', '先应用护盾再扣生命。无敌状态不扣血，伤害日志必须保留攻击来源。', '护盾与生命应按什么顺序结算', '护盾'],
  ['timeout', 'network', '超时', '请求总时限为5秒，包含排队时间；取消后禁止继续提交结果。', '等待队列是否消耗请求的时间预算', '包含排队'],
  ['migration', 'storage', '迁移', '迁移前备份旧版本。转换失败必须回滚，不能覆盖原始文件。验证：损坏样本测试通过。', '升级文件格式失败怎样恢复原数据', '迁移前备份'],
  ['cooldown', 'battle', '冷却', '技能冷却在成功释放后开始。被打断且未释放的技能不进入冷却，服务器时间为准。', '技能释放被中断后应该扣除冷却吗', '成功释放'],
  ['pagination', 'network', '分页', '使用稳定游标，按时间和ID排序；新记录不能导致下一页重复。删除后游标仍可继续读取。', '不断新增记录时怎样避免翻页重复', '稳定游标'],
  ['encryption', 'storage', '加密', '密钥仅从环境变量读取，不写入存档。日志不得输出密钥；解密失败保留密文。', '读取失败时能否覆盖加密的数据', '保留密文'],
  ['rollback', 'battle', '回滚', '计划：缓存全部战斗帧。验证：内存测试失败，尚未实施。后续决定只保存最近60帧；回滚后重新校验随机数状态。', '战斗状态回退需要保留哪些数据', '最近60帧'],
];

export async function fixture(dataDir) {
  const initial = await openApplication(dataDir); await initial.close();
  const resources = {}, records = [], queries = [];
  for (const project of ['alpha', 'beta', 'gamma']) for (let i = 0; i < TOPICS.length; i++) {
    const [key, module, title, body, paraphrase, exact] = TOPICS[i];
    const content = `# ${title}规范\n\n## 约束\n\n${body}\n\n## 来源\n\n项目 ${project}，模块 ${module}。这是合成资料。\n`;
    const result = await noteCommand(dataDir, 'add', { title: `${title}-${project}.md`, text: content, recordedAt: '2026-11-01T08:00:00+08:00' }, async () => Buffer.alloc(0));
    const id = result.resourceId; resources[id] = { projectId: project, modules: [module], sourcePaths: [`D:/synthetic/${project}/${module}/${key}.md`] }; records.push({ id, project, key, content });
    if (project === 'alpha') {
      for (const [kind, query] of [['exact', exact], ['paraphrase', paraphrase]]) queries.push({ id: `${key}-${kind}`, split: i < 4 ? 'tune' : 'acceptance', query, scope: { projectId: project, modules: [module] }, expected: [id], required: [body], noAnswer: false });
    }
  }
  for (const project of ['alpha', 'beta']) queries.push({ id: `${project}-no-answer`, split: project === 'alpha' ? 'tune' : 'acceptance', query: '税务申报的发票编号规则', scope: { projectId: project, modules: ['battle'] }, expected: [], required: [], noAnswer: true });
  const unknown = await noteCommand(dataDir, 'add', { title: 'unknown.md', text: '# 连击\n\n连击窗口为999秒，来源项目未知。' }, async () => Buffer.alloc(0));
  const config = { expectedRevision: 0, projects: ['alpha', 'beta', 'gamma'].map(id => ({ id, aliases: [], directories: [`D:/synthetic/${id}`], modules: ['battle', 'network', 'storage'], entries: [] })), resources, organizations: {} };
  await configure(dataDir, config);
  return { records, queries, unknown: unknown.resourceId, config };
}
