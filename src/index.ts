import { CoreManager } from './core/manager.js';
import { PluginHost } from './core/plugins.js';
import { builtinPlugins } from './plugins/index.js';
export * from './contracts/index.js';
export { CoreManager } from './core/manager.js';
export { PluginHost, pluginOrder } from './core/plugins.js';
export { KnowledgeError } from './core/errors.js';
/** CLI 和只读预览复用同一宿主，确保插件启停一致。 */
export async function openApplication(dataDir: string, options: { readOnly?: boolean } = {}) {
  const manager = await CoreManager.open(dataDir, options); const plugins = new PluginHost(manager, builtinPlugins);
  try { await plugins.start(); } catch (error) { await manager.close(); throw error; }
  return { manager, plugins, close: async () => { try { await plugins.stop(); } finally { await manager.close(); } } };
}
