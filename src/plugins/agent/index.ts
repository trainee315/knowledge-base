import type { PluginDefinition } from '../../contracts/index.js';
import { AgentService } from '../../agent/service.js';
import { DeepSeekProvider } from '../../agent/deepseek.js';
import { AgentError, agentAssert } from '../../agent/errors.js';
import type { AgentProfile, AgentProfileInput, AgentProvider, GenerateObjectInput, GenerateTextInput } from '../../agent/types.js';
import { defaultProfiles } from '../../agent/profiles.js';

const PROFILE_KEY = 'profiles'; // 唯一正式配置键，只含非秘密profile及schema版本。
interface ProfileState { schemaVersion: 1; profiles: AgentProfile[] }
const globals = new Set(['json', 'input', 'dataDir']);
function cleanInput(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter(([key]) => !globals.has(key))); }
function id(input: Record<string, unknown>): string { agentAssert(typeof input.id === 'string' && input.id.trim().length > 0, 'AGENT_INVALID_INPUT'); return input.id; }
function profileInput(input: Record<string, unknown>): AgentProfileInput {
  const value = cleanInput(input);
  for (const key of ['timeoutMs', 'maxTokens', 'temperature', 'expectedRevision']) if (typeof value[key] === 'string' && value[key] !== '') value[key] = Number(value[key]);
  return value as unknown as AgentProfileInput;
}
function generation(input: Record<string, unknown>): GenerateTextInput {
  const value = cleanInput(input);
  for (const key of ['timeoutMs', 'maxTokens', 'temperature']) if (typeof value[key] === 'string' && value[key] !== '') value[key] = Number(value[key]);
  // 纯CLI文本便捷输入；业务仍传完整messages，不混入任何业务prompt。
  if (value.prompt !== undefined) { agentAssert(typeof value.prompt === 'string' && value.messages === undefined, 'AGENT_INVALID_INPUT'); value.messages = [{ role: 'user', content: value.prompt }]; delete value.prompt; }
  return value as unknown as GenerateTextInput;
}
export interface AgentPluginOptions { service?: AgentService; providers?: AgentProvider[] }
export function createAgentPlugin(options: AgentPluginOptions = {}): PluginDefinition { return {
  manifest: { id: 'agent', version: '1.0.0', apiVersion: 1, dataVersion: 1, dependencies: {}, description: '通用受控文本/JSON生成基础设施，无业务prompt' },
  async load(context) {
    // load、status和profile查询仅本地读取；不会访问凭证文件或自动联网。
    const saved = await context.store.read<ProfileState>(PROFILE_KEY, { schemaVersion: 1, profiles: defaultProfiles() });
    agentAssert(saved?.schemaVersion === 1 && Array.isArray(saved.profiles), 'AGENT_INVALID_INPUT');
    const service = options.service ?? new AgentService({ providers: options.providers ?? [new DeepSeekProvider()], profiles: saved.profiles, saveProfiles: async profiles => { await context.store.write(PROFILE_KEY, { schemaVersion: 1, profiles }); } });
    context.registerCommand('agent status', async () => service.status());
    context.registerCommand('agent profile list', async () => service.listProfiles());
    context.registerCommand('agent profile get', async ({ input }) => { agentAssert(input.id === undefined || typeof input.id === 'string' && input.id.trim(), 'AGENT_INVALID_INPUT'); return service.getProfile(input.id as string | undefined); });
    context.registerCommand('agent profile set', async ({ input }) => service.configureProfile(profileInput(input)));
    context.registerCommand('agent profile delete', async ({ input }) => { await service.removeProfile(id(input)); return { deleted: true }; });
    context.registerCommand('agent config get', async () => ({ profiles: service.listProfiles(), status: service.status() }));
    context.registerCommand('agent config set', async ({ input }) => service.configureProfile(profileInput(input)));
    context.registerCommand('agent generate text', async ({ input }) => service.generateText(generation(input)));
    context.registerCommand('agent generate object', async ({ input }) => { const value = generation(input) as GenerateObjectInput; if (!value.schema) throw new AgentError('AGENT_UNSUPPORTED_SCHEMA'); return service.generateObject(value); });
    return { api: service, async stop() { service.stop(); } };
  },
}; }
export const agentPlugin = createAgentPlugin();
export default agentPlugin;
