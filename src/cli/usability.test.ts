import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { commandHelp, commands, validateCommand } from './contract.js';
import { menu } from './interactive.js';
import { KnowledgeError } from '../core/errors.js';
import { openApplication } from '../index.js';

const CLI = fileURLToPath(new URL('./main.js', import.meta.url));
const invoke = (dir: string, args: string[], input?: unknown) => {
  const result = spawnSync(process.execPath, [CLI, ...args, '--data-dir', dir], { encoding: 'utf8', windowsHide: true, timeout: 30000, input: input === undefined ? undefined : JSON.stringify(input) });
  return { ...result, value: result.stdout.startsWith('{') ? JSON.parse(result.stdout) : undefined };
};

test('all built-in plugin commands have offline help and executable parameter examples', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kb-help-'));
  try {
    const app = await openApplication(dir);
    try { for (const name of app.plugins.commandNames()) assert.ok(commands[name], name + ' missing help'); }
    finally { await app.close(); }
    for (const [name, spec] of Object.entries(commands)) {
      const help = commandHelp(name.split(' '));
      assert.ok('command' in help);
      assert.equal(help.command, name);
      assert.ok(help.exampleCommand);
      for (const field of Object.values(help.fields ?? {})) assert.ok(field.type && field.description, name);
      assert.doesNotThrow(() => validateCommand(name.split(' '), spec.example), name);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('help, errors and diagnosis stay offline; format and input precedence are stable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-offline-'));
  const dir = path.join(root, '未创建的 中文 库');
  try {
    for (const args of [['help', 'resource', 'import'], ['resource', 'import', '-h'], ['resource', '--help']]) {
      const result = invoke(dir, [...args, '--input', path.join(root, 'missing.json')]);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.value.ok, true);
    }
    const typo = invoke(dir, ['resource', 'import', '--fiel', 'x']);
    assert.equal(typo.status, 2); assert.match(typo.value.error.suggestions.join(' '), /--file/);
    const unknown = invoke(dir, ['resorce', 'list']);
    assert.equal(unknown.status, 2); assert.match(unknown.value.error.suggestions.join(' '), /resource list/);
    const missing = invoke(dir, ['resource', 'import']);
    assert.equal(missing.status, 2); assert.match(missing.value.error.message, /--file/);
    assert.equal(invoke(dir, ['resource', 'import', '--help', '--format', 'text', '--json']).value.ok, true);
    assert.match(invoke(dir, ['resource', 'import', '--help', '--format', 'text']).stdout, /必填：file/);
    assert.equal(invoke(dir, ['help', 'does-not-exist']).status, 2);
    const mixed = invoke(dir, ['resource', 'import', '--input', '-', '--file', 'override.md'], { file: 4, format: 'text' });
    assert.equal(mixed.status, 1); assert.match(mixed.stdout, /SERVICE_OFFLINE/);
    assert.equal(invoke(dir, ['interactive']).status, 2);
    const diagnostic = invoke(dir, ['doctor']);
    assert.equal(diagnostic.status, 1); assert.equal(diagnostic.value.data.healthy, false);
    await assert.rejects(access(dir));
    assert.doesNotThrow(() => validateCommand(['org', 'list'], {}));
    assert.doesNotThrow(() => validateCommand(['resource', 'list'], { ids: 'a,b' }));
    assert.doesNotThrow(() => validateCommand(['cron', 'runs'], { jobId: 'job', limit: 10 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('service start is idempotent; import, diagnostics, errno suggestions and logs work in an isolated library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-usability 中文 '));
  const dir = path.join(root, 'data');
  const conflict = path.join(root, 'conflict');
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const first = invoke(dir, ['up', '--no-open']); assert.equal(first.status, 0, first.stdout);
    const second = invoke(dir, ['up', '--no-open']); assert.equal(second.value.data.pid, first.value.data.pid);
    const response = await fetch(first.value.data.url); assert.equal(response.status, 200);
    assert.equal(invoke(dir, ['doctor']).value.data.healthy, true);
    const source = path.join(root, '设计 说明.md'); await writeFile(source, '# 设计说明\n易用性测试');
    const added = invoke(dir, ['resource', 'import', '--file', source]); assert.equal(added.status, 0, added.stdout);
    const fetched = invoke(dir, ['resource', 'get', '--id', added.value.data.resource.id, '--content']); assert.match(fetched.value.data.content, /易用性测试/);
    const missing = invoke(dir, ['resource', 'import', '--file', path.join(root, 'missing.md')]);
    assert.equal(missing.value.error.code, 'ENOENT'); assert.match(missing.value.error.suggestions.join(' '), /路径/);
    const failed = invoke(conflict, ['service', 'start', '--port', String((occupied.address() as { port: number }).port)]);
    assert.equal(failed.value.error.code, 'EADDRINUSE', failed.stdout);
    assert.match(invoke(conflict, ['service', 'logs']).value.data.text, /EADDRINUSE/);
    assert.equal(invoke(dir, ['service', 'logs', '--lines', '0']).status, 2);
  } finally {
    invoke(dir, ['service', 'stop']); invoke(conflict, ['service', 'stop']);
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('interactive retries only the invalid path, selects resource IDs and reports completed changes', async () => {
  const replies = ['3', 'missing.md', '"D:/中文 空格/说明.md"', '4', '说明', '1', '0'];
  const calls: { words: string[]; input: Record<string, unknown> }[] = [];
  const output: string[] = [];
  const result = await menu({ ask: async () => replies.shift()!, write: text => output.push(text), cancelled: () => false }, async (words, input) => {
    calls.push({ words, input });
    if (input.file === 'missing.md') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (words.join(' ') === 'resource list') return [{ resource: { id: 'resource-id', originalName: '说明.md' } }];
    return { done: true };
  }, 'D:/data');
  assert.equal(calls[1].input.file, 'D:/中文 空格/说明.md');
  assert.equal(calls[3].input.id, 'resource-id');
  assert.equal(result.completedChanges, 1);
  assert.match(output.join(''), /--help/);
  let cancelled = false;
  const stopped = await menu({ ask: async () => { cancelled = true; throw new KnowledgeError('CANCELLED', '取消'); }, write: () => {}, cancelled: () => cancelled }, async () => { throw new Error('must not execute'); }, 'D:/data');
  assert.equal(stopped.completedChanges, 0); assert.equal(stopped.cancelled, true);
});
