import { spawn, spawnSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';

// 配对实际开发命令，交替先后顺序；不得用CPU空闲或低优先级替代负载结果。
let rows = [];
const guarded = process.argv.includes('--guarded');
const pairCount = process.argv.includes('--extended') ? 20 : 5;
const variant = process.argv.find(a => a.startsWith('--variant='))?.slice('--variant='.length);
if (variant !== undefined && !/^[a-z0-9-]{1,40}$/.test(variant)) throw new Error('INVALID_VARIANT');
const output = `artifacts/verification/v0.0.8/developer-load${guarded ? '-guarded' : ''}${pairCount === 20 ? '-extended' : ''}${variant ? '-' + variant : ''}.json`;
if (process.argv.includes('--resume')) { const prior = JSON.parse(await readFile(output, 'utf8')); if (prior.complete) throw new Error('ALREADY_COMPLETE'); rows = prior.rows; }
const measure = async workload => {
  const started = performance.now();
  const args = workload === 'build' ? ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'] : ['--test', 'dist/core/core.test.js'];
  const child = spawnSync(process.execPath, guarded ? ['dist/cli/main.js', 'recall', 'workload', '--input', '-'] : args, { input: guarded ? JSON.stringify({ command: 'node', args }) : undefined, windowsHide: true, encoding: 'utf8', timeout: 180000 });
  if (child.status !== 0) throw new Error(child.stderr + child.stdout);
  return performance.now() - started;
};
async function paired(mode, workload, loaded) {
  if (!loaded) return { durationMs: await measure(workload) };
  const child = spawn(process.execPath, ['tests/recall/load-worker.mjs', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.on('error', problem => { if (problem.code !== 'EPIPE') error += String(problem); });
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error))); });
  void exit.catch(() => {}); // 同步开发命令结束前也接住失败；下方仍await并使本次配对失败。
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('load startup timeout')), 10000); const poll = () => { if (output.includes('ready')) { clearTimeout(timer); resolve(); } else setTimeout(poll, 20); }; poll(); });
  const durationMs = await measure(workload); if (!child.stdin.destroyed) child.stdin.end('stop'); await exit;
  const stats = JSON.parse(output.trim().split('\n').at(-1)); return { durationMs, stats };
}
for (const mode of ['index-cached', 'index-cold', 'query']) for (const workload of ['build', 'tests']) for (let repeat = 0; repeat < pairCount; repeat++) {
  if (rows.some(r => r.mode === mode && r.workload === workload && r.repeat === repeat)) continue;
  const order = repeat % 2 ? [true, false] : [false, true]; const pair = { mode, workload, repeat };
  for (const loaded of order) pair[loaded ? 'loaded' : 'idle'] = await paired(mode, workload, loaded);
  pair.slowdown = pair.loaded.durationMs / pair.idle.durationMs - 1; rows.push(pair);
  console.log(JSON.stringify({ mode, workload, repeat, slowdown: pair.slowdown }));
  await writeFile(output, JSON.stringify({ complete: false, guarded, rows }, null, 2));
}
const thresholds = JSON.parse(await readFile('doc/新增需求/v0.0.8/thresholds.json', 'utf8'));
const summary = [];
for (const mode of ['index-cached', 'index-cold', 'query']) for (const workload of ['build', 'tests']) {
  const values = rows.filter(r => r.mode === mode && r.workload === workload).map(r => r.slowdown);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1));
  const upper95 = mean + (pairCount === 20 ? 1.729 : 2.132) * sd / Math.sqrt(values.length); // 一侧95% t上界，df=19或4。
  summary.push({ mode, workload, mean, upper95, passed: upper95 <= thresholds.resources.workloadSlowdownUpper95Max });
}
await writeFile(output, JSON.stringify({ complete: true, guarded, pairCount, rows, summary, limitations: ['保护模式通过显式workload入口中断/推迟召回，以召回可用性换取开发负载优先；未包裹的外部构建不受保护', '冷编码只清除合成库派生向量缓存，原文/模型文件保持不变', 'fsRead/fsWrite在Windows可能不可用，0不能解释为无I/O', 'GPU未启用，未进行GPU利用率归因', '配对测试仍受其他开发活动影响，原始样本全部保留'] }, null, 2));
console.log(JSON.stringify(summary));
