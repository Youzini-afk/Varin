/** Configuration-only Host access; never starts an AgentSession or loads extensions. */
import { resolve } from 'node:path';
import { getAgentDir, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import type { PermissionPolicy } from '@varin/protocol';
import { readHostHarnessSettings } from './settings-authority.js';

export function mcpHostAgentDir(directory?: string): string {
  return resolve(directory ?? getAgentDir());
}
export function mcpHostProjectTrusted(agentDir: string, configCwd: string): boolean {
  return new ProjectTrustStore(agentDir).get(configCwd) === true;
}
export function readMcpHostPermissionPolicy(agentDir: string, configCwd: string, projectTrusted: boolean): PermissionPolicy {
  const harness = readHostHarnessSettings(agentDir, configCwd, projectTrusted);
  return { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] };
}
