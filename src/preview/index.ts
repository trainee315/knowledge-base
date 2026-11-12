import { handleService } from '../service/client.js';

/** 兼容旧预览入口，进程生命周期由统一服务管理。 */
export function handlePreview(args: string[], dataDir: string): Promise<unknown> {
  return handleService(args.filter(arg => arg !== '--json'), dataDir);
}
