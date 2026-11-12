import type { PluginDefinition } from '../../contracts/index.js';
import { manifest } from '../shared.js';

/** 定时计划由应用服务装配，插件启停只控制定时执行。 */
export const cronPlugin: PluginDefinition = {
  manifest: { ...manifest('cron'), description: '配置知识库定时任务，查看运行记录。' },
  async load() { return {}; },
};
