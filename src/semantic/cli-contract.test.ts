import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { commandHelp, validateCommand } from '../cli/contract.js';

test('semantic commands share mainline CLI help and validation contracts', () => {
  assert.equal(commandHelp([]).version, '0.0.15');
  assert.ok(commandHelp([]).commands?.includes('semantic create'));
  assert.deepEqual(commandHelp(['semantic', 'create']).required, ['name']);
  assert.doesNotThrow(() => validateCommand(['semantic', 'update'], { id: 'tag-id', description: '' }));
  assert.throws(() => validateCommand(['semantic', 'create'], { name: '性能优化', nameTypo: 'x' }), /nameTypo/);
});

test('semantic help and rejected options never start a service or read input for help', () => {
  const dataDir = path.join(tmpdir(), 'kb-semantic-help-' + randomUUID());
  const cli = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  const help = invoke(['semantic', 'create', '--help', '--input', path.join(dataDir, 'missing.json')]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).data.command, 'semantic create');
  const invalid = invoke(['semantic', 'create', '--name', '性能优化', '--name-typo', 'x']);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_ARGUMENT');
  assert.equal(existsSync(dataDir), false);
});
