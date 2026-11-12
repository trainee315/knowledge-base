import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleService } from './client.js';

test('production serves built assets but keeps a nested service data directory private', async () => {
  const assets = await realpath(fileURLToPath(new URL('../web/assets/', import.meta.url)));
  const script = (await readdir(assets)).find(name => name.endsWith('.js'));
  assert.ok(script);
  const dataDir = await mkdtemp(join(assets, 'kb-static-private-'));
  try {
    await writeFile(join(dataDir, 'synthetic.js'), '// sample fixture', 'utf8');
    const state = await handleService(['start'], dataDir);
    assert.ok(state.running && 'url' in state);
    assert.equal((await fetch(state.url)).status, 200);
    assert.equal((await fetch(state.url + '/assets/' + script)).status, 200);
    assert.ok([403, 404].includes((await fetch(state.url + '/assets/' + basename(dataDir) + '/synthetic.js')).status));
  } finally {
    try { await handleService(['stop'], dataDir); }
    finally {
      const cleanup = await realpath(dataDir);
      assert.ok(cleanup.startsWith(assets + sep));
      await rm(cleanup, { recursive: true, force: true });
    }
  }
});
