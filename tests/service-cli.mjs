import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const CLI_TIMEOUT_MS = 60_000;

/** Run the built CLI in a fixture's own data directory. */
export function serviceCli(dataDir, words, { input, env = process.env } = {}) {
  const args = [ENTRY, ...words, '--data-dir', dataDir, '--json'];
  if (input !== undefined) args.push('--input', '-');
  const child = spawnSync(process.execPath, args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8', env, windowsHide: true, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true, child.stdout);
  return result.data;
}

export function preloadEnvironment(module, env = process.env) {
  const existing = env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '';
  return { ...env, NODE_OPTIONS: existing + '--import=' + module.href };
}
