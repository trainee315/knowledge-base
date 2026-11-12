import { DeepSeekProvider } from './deepseek.js';
import { CodexCliProvider } from './codex-cli.js';
import type { AgentProvider } from './types.js';
/** 插件和独立 Session 执行共用供应商注册，防止配置可选但执行找不到。 */
export function createDefaultProviders(): AgentProvider[] { return [new DeepSeekProvider(), new CodexCliProvider()]; }
