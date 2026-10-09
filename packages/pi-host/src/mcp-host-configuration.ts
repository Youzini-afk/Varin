/** Configuration-only Host access; never starts an AgentSession or loads extensions. */
import { resolve } from 'node:path';
import { getAgentDir, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent';
import { mergeHarnessSettings, type HarnessSettingsInput, type PermissionPolicy } from '@varin/protocol';

export function mcpHostAgentDir(directory?: string): string {
  return resolve(directory ?? getAgentDir());
}
export function mcpHostProjectTrusted(agentDir: string, configCwd: string): boolean {
  return new ProjectTrustStore(agentDir).get(configCwd) === true;
}
export function readMcpHostPermissionPolicy(agentDir: string, configCwd: string, projectTrusted: boolean): PermissionPolicy {
  const settings = SettingsManager.create(configCwd, agentDir, { projectTrusted });
  if (settings.drainErrors().length) throw new Error('MCP permission configuration is unavailable');
  const global = settings.getGlobalSettings() as { harness?: HarnessSettingsInput };
  const project = settings.getProjectSettings() as { harness?: HarnessSettingsInput };
  const harness = mergeHarnessSettings(global.harness ?? {}, projectTrusted ? project.harness ?? {} : {});
  return { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] };
}
