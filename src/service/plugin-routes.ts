import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createCronService } from './cron-service.js';

export interface PluginRouteContext {
  dataDir: string;
  dispatch(words: string[], input: Record<string, unknown>): Promise<unknown>;
  cron: Awaited<ReturnType<typeof createCronService>>;
}

export async function handlePluginRoutes(_request: IncomingMessage, _response: ServerResponse, _url: URL, _origin: string, _context: PluginRouteContext): Promise<boolean> {
  return false;
}
