import type { PluginDefinition } from '../contracts/index.js';
/** 通用组织浏览仅依赖此静态声明，不初始化转录执行器。 */
export const transcriptPlugin: PluginDefinition = { manifest: { id: 'transcripts', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: { agent: '^1.0.0' }, organizationTypes: [{ id: 'session-transcript', name: 'Session 转录', config: {} }] }, async load() { return {}; } };
