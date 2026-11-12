import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 独立合成库；固定CLI路径，故意从中文/空格项目目录调用，永不读取真实session。
const repo = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(repo, 'dist/cli/main.js');
const base = path.join(repo, '.recall-local/v0.0.10'); await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'demo-')), data = path.join(root, 'knowledge-data');
const env = { ...process.env, DEEPSEEK_API_KEY: 'offline-demo-only', NODE_OPTIONS: '--import=' + new URL('./offline-provider.mjs', import.meta.url).href };
const issue = (command, input = {}, cwd = root) => {
  const p = spawnSync(process.execPath, [CLI, ...command.split(' '), '--data-dir', data, '--input', '-', '--json'], { env, cwd, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (p.error) throw p.error; const result = JSON.parse(p.stdout); assert.equal(p.status, 0, JSON.stringify(result)); return result.data;
};
const manual = (await readFile(path.join(repo, 'doc/新增需求/v0.0.10/agent-project-prompt.md'), 'utf8')).replaceAll('\r\n', '\n');
const prompt = manual.split('## 2. 项目提示词正文')[1].split('```text\n')[1].split('```')[0];
const report = { syntheticOnly: true, provider: 'offline-demo', root, data, projects: [] };
let started = false;
try {
  issue('service start'); started = true;
  issue('agent profile set', { id: 'demo-only', providerId: 'deepseek', model: 'deepseek-flash', credentialEnv: 'DEEPSEEK_API_KEY', maxTokens: 2048, temperature: 0, reasoning: 'off' });
  for (const projectId of ['example-a', 'example-b']) {
    const project = path.join(root, projectId + ' 项目'), source = path.join(project, 'synthetic-sessions'); await mkdir(source, { recursive: true });
    const sessionId = projectId + '-main';
    const row = (type, payload) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type, payload });
    for (const id of [sessionId, projectId + '-other']) {
      const body = projectId === 'example-a' ? '连击窗口原为300毫秒；用户纠正为280毫秒，已实施但尚未重跑测试。只保留最近60帧，全部帧缓存因内存超限否决。错误 E_COMBO_8192 未解决。' : '同名连击术语：本项目窗口为999毫秒，禁止混用项目A的280毫秒。测试失败，未验证通过。';
      await writeFile(path.join(source, id + '.jsonl'), [row('session_meta', { id, cwd: project, source: 'cli' }), row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] }), row('event_msg', { type: 'task_complete' })].join('\n') + '\n');
    }
    const org = issue('transcript create', { alias: projectId, projectDir: project, sourceRoot: source, startDate: '2026-01-01', profile: 'demo-only', maxCalls: 0 }, project);
    const config = issue('recall config get', {}, project);
    issue('recall configure', { ...config, expectedRevision: config.revision, projects: [...config.projects, { id: projectId, directories: [project] }], organizations: { ...config.organizations, [org.id]: { projectId } } }, project);
    const scope = { projectId, sessionId };
    const previewInput = { id: org.id, sessionId, maxCalls: 1, maxSessions: 1, to: new Date().toISOString() };
    const preview = issue('transcript preview', previewInput, project); assert.deepEqual(preview.candidates.map(c => c.sessionId), [sessionId]);
    const saved = issue('transcript run', previewInput, project); assert.equal(saved.saved, 1);
    const resourceId = saved.records[0].resourceId;
    assert.ok(issue('recall read', { id: resourceId, scope }, project).evidence.length);
    const bindings = { KB_CLI: CLI, KB_DATA_DIR: data, PROJECT_DIR: project, RECALL_PROJECT_ID: projectId, TRANSCRIPT_ORGANIZATION_ID: org.id, TRANSCRIPT_PROFILE: 'demo-only', COMPRESSION_MAX_CALLS: 0, INDEX_MAINTENANCE: 'explicit-only', DEMO: '合成资料；零云端调用；真实使用须另配profile和授权预算' };
    const requests = { 'project-config.json': bindings, 'compress-preview.json': { ...previewInput, maxCalls: 0 }, 'retry.json': { id: org.id, sessionId, maxCalls: 0 }, 'investigate.json': { mode: 'task', task: '继续连击工作，核对窗口、否决理由和测试状态', scope, retrievalMode: 'lexical', maxBytes: 12000, budgetTokens: 4000 }, 'read.json': { id: resourceId, scope, maxFragments: 1 } };
    for (const [name, value] of Object.entries(requests)) await writeFile(path.join(project, name), JSON.stringify(value, null, 2));
    await writeFile(path.join(project, 'AGENT_PROMPT.md'), '# 本项目知识库接入\n\n配置（真实生成ID，仅此演示库有效）：\n```json\n' + JSON.stringify(bindings, null, 2) + '\n```\n\n' + prompt);
    report.projects.push({ project, projectId, sessionId, organizationId: org.id, resourceId, otherSessionProcessed: false });
  }
  issue('recall index build');
  for (const project of report.projects) {
    const result = issue('recall search', { query: '连击窗口', scope: { projectId: project.projectId }, retrievalMode: 'lexical' }, project.project);
    assert.deepEqual([...new Set(result.evidence.map(e => e.resourceId))], [project.resourceId]); assert.equal(result.usage.modelCalls, 0);
    project.search = { resourceIds: [project.resourceId], stages: result.stages, modelCalls: result.usage.modelCalls };
  }
  report.passed = true;
} finally { if (started) issue('service stop'); }
const commands = [`node "${CLI}" service start --data-dir "${data}" --json`, ...report.projects.map(p => `node "${CLI}" recall prepare --input "${path.join(p.project, 'investigate.json')}" --data-dir "${data}" --json`), `node "${CLI}" service stop --data-dir "${data}" --json`];
report.commands = commands;
await writeFile(path.join(root, 'manifest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
