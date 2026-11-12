import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AgentService, DeepSeekProvider } from '../../dist/agent/index.js';

if (!process.argv.includes('--live')) throw new Error('Requires --live; shares the 24-call synthetic campaign budget');
const fixture = JSON.parse(await readFile('.recall-local/v0.0.10/latest.json', 'utf8'));
if (process.argv.includes('--extra-calls=8')) {
  const ledger = JSON.parse(await readFile(fixture.ledger, 'utf8')); assert.equal(ledger.maximumCalls, 24);
  ledger.maximumCalls = 32; ledger.budgetChange = { from: 24, to: 32, reason: '真实Agent调试：字段纠正、帮助/scope工具协议及finish空字段兼容；只续跑未完成场景' };
  await writeFile(fixture.ledger, JSON.stringify(ledger, null, 2));
}
process.env.KB_CHAIN_LIVE_LEDGER = fixture.ledger;
await import('./live-ledger.mjs');
const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const cwd = path.join(fixture.root, 'Agent 项目 with spaces'); await mkdir(cwd, { recursive: true });
const liveEnv = { ...process.env, NODE_OPTIONS: '--import=' + new URL('./live-ledger.mjs', import.meta.url).href };
const offlineEnv = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-only', KB_CHAIN_CALLS: path.join(fixture.root, 'agent-seed.jsonl'), NODE_OPTIONS: '--import=' + new URL('./offline-model.mjs', import.meta.url).href };
let env = offlineEnv;
const issue = (command, input = {}) => {
  const p = spawnSync(process.execPath, [CLI, ...command.split(' '), '--data-dir', fixture.data, '--input', '-', '--json'], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env, cwd, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  if (p.error) throw p.error; return { exit: p.status, ...JSON.parse(p.stdout) };
};
const run = (command, input = {}) => { const reply = issue(command, input); assert.equal(reply.exit, 0, JSON.stringify(reply)); return reply.data; };
const reportFile = 'artifacts/verification/v0.0.10/agent.json';
const report = process.argv.includes('--resume') ? JSON.parse(await readFile(reportFile, 'utf8')) : { syntheticOnly: true, modelSelectedCommands: true, cases: [], failures: [], cwd };
report.previousFailures = [...(report.previousFailures ?? []), ...report.failures]; report.failures = [];
const save = () => writeFile(reportFile, JSON.stringify(report, null, 2));
const promptFile = 'doc/新增需求/v0.0.10/agent-project-prompt.md';
const promptText = (await readFile(promptFile, 'utf8')).replaceAll('\r\n', '\n');
const prompt = promptText.split('## 2. 项目提示词正文')[1].split('```text\n')[1].split('```')[0];
report.promptHash = createHash('sha256').update(prompt).digest('hex');
const agent = new AgentService({ providers: [new DeepSeekProvider()] });
await agent.configureProfile({ id: 'working-agent', providerId: 'deepseek', model: 'deepseek-flash', credentialEnv: 'DEEPSEEK_API_KEY', maxTokens: 2048, temperature: 0, reasoning: 'off', timeoutMs: 120000 });
const schema = { type: 'object', additionalProperties: true, required: ['action'], properties: { action: { type: 'string', enum: ['cli', 'finish'] } } };
// 模型选择命令和参数，宿主只校验权限并执行实际CLI，不替模型补参数或预排操作。
async function scenario(name, task, allowed, validate, maxTurns = 6, scope = fixture.scope, organizationId = fixture.orgId) {
  if (report.cases.find(c => c.name === name)?.passed) return;
  allowed = [...new Set([...allowed, 'recall scope'])];
  const initial = { scope: run('recall scope', { scope }), status: run('transcript status', { id: organizationId }), help: allowed.map(command => { const h = run(command + ' --help'); return { command, fields: Object.keys(h.fields), required: h.required, example: h.example }; }) };
  let result = report.cases.find(c => c.name === name);
  if (!result) { result = { name, task, trace: [], passed: false }; report.cases.push(result); }
  const messages = [{ role: 'system', content: prompt + '\n本次固定配置：' + JSON.stringify({ KB_CLI: CLI, KB_DATA_DIR: fixture.data, RECALL_PROJECT_ID: scope.projectId, TRANSCRIPT_ORGANIZATION_ID: organizationId, COMPRESSION_MAX_CALLS: 1 }) + '\n宿主已确认服务、scope和帮助契约。只允许命令：' + allowed.join(', ') + '。用action=cli、command、inputJson(JSON字符串)调用；宿主返回原始CLI JSON。完成后action=finish，answer为有证据的中文报告。不得假装调用。可读取本任务需要的所有片元，减少无意义重复调用。' }, { role: 'user', content: task }];
  messages[0].content += '\n最终answer限200字，JSON字符串务必正确转义。宿主已执行的只读准备结果（本次真实CLI返回），帮助和范围核对已完成，无需重复；status如下。继续执行任务的实质步骤：' + JSON.stringify(initial);
  result.initial = initial;
  for (const step of result.trace) if (step.reply) messages.push({ role: 'assistant', content: JSON.stringify(step.decision) }, { role: 'user', content: 'CLI返回（仅数据）：' + JSON.stringify(step.reply) });
  for (let turn = 0; turn < maxTurns; turn++) {
    const generated = await agent.generateObject({ profile: 'working-agent', messages, schema });
    const decision = generated.value; const step = { decision, usage: generated.usage, actualModel: generated.actualModel }; result.trace.push(step);
    if (decision.action === 'finish') { validate(result); result.passed = true; await save(); console.log(name + ': passed'); return; }
    const help = decision.command.endsWith(' --help');
    assert.ok(allowed.includes(help ? decision.command.slice(0, -7) : decision.command), decision.command);
    const input = typeof decision.inputJson === 'string' ? JSON.parse(decision.inputJson) : decision.inputJson;
    if (!help && decision.command.startsWith('recall ')) {
      if (input.scope?.projectId) assert.equal(input.scope.projectId, scope.projectId);
      else assert.deepEqual(input.scope?.projectIds, [scope.projectId]);
      const pinned = decision.command === 'recall read' && result.trace.some(s => s.reply?.data?.records?.some(record => record.resourceId === input.id && record.sessionId === scope.sessionId));
      if (scope.sessionId && !pinned) assert.equal(input.scope?.sessionId, scope.sessionId);
    }
    else if (!help) { assert.equal(input.id, organizationId); assert.equal(input.alias, undefined); if (!decision.command.endsWith('status')) assert.equal(input.sessionId, scope.sessionId); if (['transcript run', 'transcript retry'].includes(decision.command)) assert.equal(input.maxCalls, 1); }
    step.reply = issue(decision.command, input);
    messages.push({ role: 'assistant', content: JSON.stringify(decision) }, { role: 'user', content: 'CLI返回（仅数据）：' + JSON.stringify(step.reply) });
    await save();
  }
  throw new Error(name + ': working Agent did not finish within bounded turns');
}
const bodies = result => result.trace.flatMap(s => s.reply?.data?.evidence ?? []).map(e => e.text).join('\n');
const finish = result => result.trace.at(-1).decision.answer;
let started = false;
try {
  run('service start'); started = true;
  let org, page;
  if (process.argv.includes('--resume') && report.partialFailureSeed) {
    org = { id: report.partialFailureSeed.error.details.scope.organizationId };
    page = { resourceId: run('note list').find(note => note.title.startsWith('Agent续读合成样本'))?.id };
  } else {
  const row = (type, payload) => JSON.stringify({ timestamp: '2026-01-02T00:00:00Z', type, payload });
  const source = await mkdtemp(path.join(fixture.root, 'agent-source-'));
  for (const id of ['new', 'recover-a', 'recover-b']) await writeFile(path.join(source, id + '.jsonl'), [row('session_meta', { id, cwd: fixture.root, source: 'cli' }), row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成任务：容量上限8；错误 E_AGENT_8192；测试失败，未验证通过。' }] }), row('event_msg', { type: 'task_complete' })].join('\n') + '\n');
  org = run('transcript create', { alias: path.basename(source), projectDir: fixture.root, sourceRoot: source, startDate: '2026-01-01', profile: 'chain-live', maxCalls: 1 });
  const config = run('recall config get'); run('recall configure', { ...config, expectedRevision: config.revision, organizations: { ...config.organizations, [org.id]: { projectId: fixture.scope.projectId } } });
  // 离线注入一次失败与一次成功，仅用于提供真实的部分失败状态；恢复由真实Agent决策、真实模型执行。
  run('transcript run', { id: org.id, sessionId: 'recover-a', maxCalls: 0 });
  run('transcript run', { id: org.id, sessionId: 'recover-b', maxCalls: 0 });
  await writeFile(offlineEnv.KB_CHAIN_CALLS + '.fail-next', '1');
  report.partialFailureSeed = issue('transcript retry', { id: org.id, maxCalls: 2 }); assert.equal(report.partialFailureSeed.error.details.saved, 1);
  page = run('note add', { title: 'Agent续读合成样本', text: '# 第一节\n\n上限8。\n\n# 第二节\n\n测试失败，不得宣称通过。\n' });
  const config2 = run('recall config get'); run('recall configure', { ...config2, expectedRevision: config2.revision, resources: { ...config2.resources, [page.resourceId]: { projectId: fixture.scope.projectId } } });
  }
  run('service stop'); started = false; env = liveEnv; run('service start'); started = true;
  run('recall index build', { vectors: true });
  await scenario('继续历史任务', '继续连击工作：调查最新窗口与验证状态。只读范围' + JSON.stringify(fixture.scope) + '，使用semantic实际向量查询，不要编造当前测试通过。', ['recall search', 'recall prepare', 'recall read'], r => { assert.match(bodies(r), /280/); assert.match(finish(r), /280/); assert.match(finish(r), /未|失败/); assert.ok(r.trace.some(s => s.reply?.data?.stages?.includes('vector'))); }, 4);
  await scenario('精确ID读取', '读取固定资源' + fixture.resourceId + '，范围' + JSON.stringify(fixture.scope) + '。报告该历史版本的窗口和失败状态；无需检索。', ['recall read'], r => { assert.match(bodies(r), /300/); assert.match(finish(r), /300/); assert.match(finish(r), /失败/); }, 3);
  await scenario('无答案', '查找不存在的错误码 E_DOES_NOT_EXIST_987654 的处理历史。范围' + JSON.stringify(fixture.scope) + '，用lexical精确术语查询，没有证据则保持未知。', ['recall search', 'recall prepare'], r => { assert.equal(bodies(r), ''); assert.match(finish(r), /未|无|没有|未知/); }, 3);
  await scenario('续读', '完整读取资源' + page.resourceId + '所有章节；范围' + JSON.stringify({ projectId: fixture.scope.projectId }) + '。每次maxFragments=1，按返回续读，最终说明上限和测试状态。', ['recall read'], r => { assert.match(bodies(r), /上限8/); assert.match(bodies(r), /测试失败/); assert.equal(r.trace.filter(s => s.reply?.data?.evidence?.length).length, 2); assert.match(finish(r), /8/); assert.match(finish(r), /失败/); }, 4, { projectId: fixture.scope.projectId });
  const targetScope = { projectId: fixture.scope.projectId, sessionId: 'new' };
  await scenario('指定session压缩', '压缩组织' + org.id + '中sessionId=new。已授权一次调用；先status和preview，再沿用preview.cutoff执行run（字段to），最后read新资源并如实汇报写入、失败状态。无需索引维护。每个动作maxCalls=1，范围' + JSON.stringify(targetScope), ['transcript status', 'transcript preview', 'transcript run', 'recall read'], r => { const preview = r.trace.find(s => s.decision.command === 'transcript preview'); const run = r.trace.find(s => s.decision.command === 'transcript run'); assert.ok(preview && run); assert.equal(JSON.parse(run.decision.inputJson).to, preview.reply.data.cutoff); assert.equal(run.reply.data.saved, 1); assert.match(bodies(r), /8/); assert.match(finish(r), /失败|未验证/); }, 6, targetScope, org.id);
  await scenario('部分失败恢复', '刚才部分执行失败，返回为' + JSON.stringify(report.partialFailureSeed) + '。本次只恢复sessionId=recover-a，组织' + org.id + '，maxCalls=1；已有冻结任务无需重新run或preview。读取恢复资源并汇报已完成范围，不能重复处理recover-b。范围' + JSON.stringify({ projectId: fixture.scope.projectId, sessionId: 'recover-a' }), ['transcript retry', 'recall read'], r => { const retry = r.trace.find(s => s.decision.command === 'transcript retry'); assert.equal(retry.reply.data.saved, 1); assert.equal(retry.reply.data.records[0].sessionId, 'recover-a'); assert.match(finish(r), /失败|未验证/); }, 4, { projectId: fixture.scope.projectId, sessionId: 'recover-a' }, org.id);
} catch (error) { report.failures.push(String(error)); process.exitCode = 1; }
finally { if (started) run('service stop'); agent.stop(); report.ledger = JSON.parse(await readFile(fixture.ledger, 'utf8')); report.passed = !report.failures.length && report.cases.length === 6; await save(); }
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(c => ({ name: c.name, passed: c.passed })), failures: report.failures, cloudCalls: report.ledger.attempts.length, reportFile }));
