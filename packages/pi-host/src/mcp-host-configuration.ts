/** Configuration-only Host access; never starts an AgentSession or loads extensions. */
import { readProjectTrust, resolvePiAgentDirectory } from '@varin/settings-store';
import type { PermissionPolicy } from '@varin/protocol';
import { readHostHarnessSettings } from './settings-authority.js';

export function mcpHostAgentDir(directory?: string): string {
  return resolvePiAgentDirectory(directory);
}
export function mcpHostProjectTrusted(agentDir: string, configCwd: string): boolean {
  return readProjectTrust(agentDir, configCwd) === true;
}
export function readMcpHostPermissionPolicy(agentDir: string, configCwd: string, projectTrusted: boolean): PermissionPolicy {
  const harness = readHostHarnessSettings(agentDir, configCwd, projectTrusted);
  return { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] };
}
