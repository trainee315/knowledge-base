import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 每次创建独立的演示根目录；不接收覆盖现有库的目标路径。
const REPO = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = join(REPO, 'dist', 'cli', 'main.js');
const SAMPLES = fileURLToPath(new URL('./samples/', import.meta.url));
const CLI_TIMEOUT_MS = 60_000; // 限制单次演示 CLI 等待时间。
const ORGANIZE_BUDGET = { maxTasks: 100, maxDurationMs: 60_000, maxCalls: 0, maxCost: 0 }; // 仅推进离线演示任务，模型次数与费用预算均为零。
let demoRoot;
let dataDir;
let service;

/** 全部正式数据经真实构建后的 CLI 写入，JSON 通过 stdin 避开 shell 转义。 */
async function cli(words, input = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [ENTRY, ...words, '--data-dir', dataDir, '--input', '-', '--json'], {
      cwd: REPO, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error(`CLI 超时：${words.join(' ')}`)); }, CLI_TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => { /* 退出状态与 JSON 错误在 close 中统一处理。 */ });
    child.once('error', (error) => { clearTimeout(timer); fail(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout);
        if (code || !result.ok) throw new Error(`${words.join(' ')}: ${result.error?.message ?? stderr ?? stdout}`);
        done(result.data);
      } catch (error) { fail(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function command(words) {
  const quote = (value) => process.platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(ENTRY)} ${words.join(' ')} --data-dir ${quote(dataDir)} --json`;
}

/** 生成可保留的最小演示：多格式、UUID 链接、人工判断、待判断候选与体系。 */
async function main() {
  if (process.argv.length > 2) throw new Error('用法：node examples/create-demo.mjs（不接收现有数据目录）');
  try { await access(ENTRY); } catch { throw new Error('缺少 dist/cli/main.js，请先运行 npm install 和 npm run build'); }
  demoRoot = await mkdtemp(join(tmpdir(), 'knowledge-base-demo-'));
  dataDir = join(demoRoot, '演示知识库');
  service = await cli(['service', 'start']);
  const sources = join(demoRoot, '示例原件'); await mkdir(sources);
  const knowledgeTag = await cli(['tag', 'create'], { name: 'knowledge', aliases: ['知识管理'], description: 'knowledge 资源收集、组织与复用。' });
  const previewTag = await cli(['tag', 'create'], { name: 'preview', aliases: ['预览'], description: 'preview 页面与只读浏览。' });
  const provider = await cli(['relation', 'providers']);
  assert.equal(provider.kind, 'heuristic');

  const resources = {}; // 保存 CLI 返回的稳定身份，供 Markdown 链接和体系节点复用。
  for (const [key, filename] of [['reference', 'knowledge-reference.txt'], ['settings', 'preview-settings.json'], ['opaque', 'opaque-resource.kbdemo']]) {
    const target = join(sources, filename); await copyFile(join(SAMPLES, filename), target);
    resources[key] = (await cli(['resource', 'import'], { file: target, source: 'examples/create-demo.mjs' })).resource;
  }
  const guide = (await readFile(join(SAMPLES, 'knowledge-guide.md'), 'utf8'))
    .replaceAll('{{REFERENCE_UUID}}', resources.reference.id)
    .replaceAll('{{SETTINGS_UUID}}', resources.settings.id)
    .replaceAll('{{OPAQUE_UUID}}', resources.opaque.id);
  const guideFile = join(sources, 'knowledge-guide.md'); await writeFile(guideFile, guide);
  resources.guide = (await cli(['resource', 'import'], { file: guideFile, source: 'examples/create-demo.mjs' })).resource;
  await cli(['organize', 'run'], ORGANIZE_BUDGET);

  const candidates = await cli(['organize', 'candidates']);
  const accepted = candidates.find((candidate) => candidate.resourceId === resources.guide.id && candidate.tagId === knowledgeTag.id);
  const rejected = candidates.find((candidate) => candidate.resourceId === resources.reference.id && candidate.tagId === knowledgeTag.id);
  assert.ok(accepted && rejected, '演示需要指南与参考资料的 knowledge 候选');
  await cli(['organize', 'submit'], { candidateId: accepted.id, accepted: true, source: 'manual', reason: '演示人工接受：指南明确介绍知识库收集与组织流程。' });
  await cli(['organize', 'submit'], { candidateId: rejected.id, accepted: false, source: 'manual', reason: '演示人工拒绝：保留一条显式拒绝记录供观察，不代表评分自动归属。' });

  const system = await cli(['system', 'create'], { name: '知识库上手示例', description: '人为指定的阅读顺序；节点通过 UUID 连接真实资源。' });
  await cli(['system', 'update'], { id: system.id, nodes: [
    { id: 'guide', title: '01 · 上手指南', resourceId: resources.guide.id, order: 1 },
    { id: 'reference', parentId: 'guide', title: '02 · 参考资料（人工拒绝示例）', resourceId: resources.reference.id, order: 2 },
    { id: 'settings', title: '03 · JSON 配置（待判断候选）', resourceId: resources.settings.id, order: 3 },
    { id: 'opaque', title: '04 · 未知格式原件', resourceId: resources.opaque.id, order: 4 },
  ] });

  const checked = await cli(['check']); assert.equal(checked.valid, true);
  const matched = await cli(['organize', 'query'], { tags: ['知识管理'] }); assert.equal(matched.total, 1);
  const unsupported = await cli(['organize', 'query'], { parseStatus: ['unsupported'] }); assert.equal(unsupported.total, 1);
  const pending = await cli(['organize', 'candidates']); assert.ok(pending.length > 0);
  const all = await cli(['organize', 'candidates'], { includeResolved: true });
  const resolvedCount = all.filter((candidate) => candidate.status !== 'pending').length; assert.ok(resolvedCount >= 2);
  const content = await cli(['content', 'get'], { id: resources.guide.id }); assert.equal(content.referenceStatus, 'valid');
  const manifest = {
    schemaVersion: 1, createdAt: new Date().toISOString(), demoRoot, dataDir,
    resources: Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, { id: value.id, originalName: value.originalName, uri: `kb://resource/${value.id}` }])),
    tags: { knowledge: knowledgeTag.id, preview: previewTag.id }, systemId: system.id,
    check: checked, tagMatched: matched.total, unsupported: unsupported.total, pendingCandidates: pending.length, resolvedCandidates: resolvedCount,
    commands: { previewStart: command(['preview', 'start']), previewStop: command(['preview', 'stop']), query: command(['organize', 'query']), candidates: command(['organize', 'candidates']), check: command(['check']) },
    note: '演示库保留在系统临时目录。脚本在生成期间启动并停止独立服务，浏览前请运行清单中的启动命令。',
  };
  const manifestFile = join(demoRoot, 'demo-manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  return { ok: true, dataDir, manifestFile, resources: checked.resources, tagMatched: matched.total, unsupported: unsupported.total, pendingCandidates: pending.length, resolvedCandidates: resolvedCount, previewStartCommand: manifest.commands.previewStart, previewStopCommand: manifest.commands.previewStop, serviceRunning: false };
}

try {
  let result;
  try { result = await main(); }
  finally { if (service) await cli(['service', 'stop']); }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: error.message, demoRoot, dataDir }) + '\n');
  process.exitCode = 1;
}
