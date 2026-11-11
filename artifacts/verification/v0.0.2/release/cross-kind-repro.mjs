import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const { CoreManager } = await import(pathToFileURL(path.resolve('dist/core/manager.js')));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-kind-release-'));
const source = path.join(root, 'note.txt');
const results = {};
try {
  await fs.writeFile(source, 'synthetic reference');
  for (const direction of ['organization-to-resource', 'resource-to-organization']) {
    const manager = await CoreManager.open(path.join(root, direction));
    try {
      const { resource } = await manager.importResource(source);
      await manager.createOrganization({ id: resource.id, type: 'review', name: 'same UUID', references: direction === 'organization-to-resource' ? [{ kind: 'resource', id: resource.id }] : [] });
      if (direction === 'resource-to-organization') await manager.updatePluginMeta(resource.id, 'review', {}, { references: [{ kind: 'organization', id: resource.id }] });
      try {
        if (direction === 'organization-to-resource') { await manager.deleteResource(resource.id); await manager.purgeResource(resource.id); }
        else await manager.deleteOrganization(resource.id);
        results[direction] = { blocked: false };
      } catch (error) { results[direction] = { blocked: error.code === 'REFERENCED', code: error.code }; }
    } finally { await manager.close(); }
  }
  assert(Object.values(results).every(result => result.blocked));
  console.log(JSON.stringify({ phase: 'after-fix', results, networkRequests: 0 }));
} finally {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('kb-kind-release-')) throw new Error('Unexpected cleanup target');
  await fs.rm(target, { recursive: true, force: true });
}
