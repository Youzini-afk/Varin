/**
 * Workbench shell registration.
 *
 * This module registers built-in workbench shell components with the
 * extension runtime's shell component registry. It is the bridge between
 * the workbenches layer (which owns the shell React components) and the
 * extension runtime (which needs to resolve them by extension ID).
 *
 * Call this before the extension runtime activates shell contributions. The
 * requested Surface loads only the official shells it can actually use.
 */

import {
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID,
  type VarinApplicationSurface,
} from '@varin/extension-contract';
import { registerWorkbenchShellComponent } from '@/lib/extensions/shell-component-registry';
import { registerBuiltinSettingsWorkbench } from './settings/register';

let agentRegistration: Promise<void> | null = null;
let ideRegistration: Promise<void> | null = null;
let researchRegistration: Promise<void> | null = null;
let botRegistration: Promise<void> | null = null;

const registerAgentShell = (): Promise<void> => {
  if (agentRegistration) return agentRegistration;
  const pending = import('./agent/AgentWorkspaceShell').then(({ AgentWorkspaceShell }) => {
    registerWorkbenchShellComponent(VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID, AgentWorkspaceShell);
  });
  agentRegistration = pending;
  void pending.catch(() => {
    if (agentRegistration === pending) agentRegistration = null;
  });
  return pending;
};

const registerIdeShell = (): Promise<void> => {
  if (ideRegistration) return ideRegistration;
  const pending = import('./ide/IdeWorkbenchShell').then(({ IdeWorkbenchShell }) => {
    registerWorkbenchShellComponent(VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, IdeWorkbenchShell);
  });
  ideRegistration = pending;
  void pending.catch(() => {
    if (ideRegistration === pending) ideRegistration = null;
  });
  return pending;
};

const registerResearchShell = (): Promise<void> => {
  if (researchRegistration) return researchRegistration;
  const pending = import('./research/ResearchWorkbenchShell').then(({ ResearchWorkbenchShell }) => {
    registerWorkbenchShellComponent(VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID, ResearchWorkbenchShell);
  });
  researchRegistration = pending;
  void pending.catch(() => {
    if (researchRegistration === pending) researchRegistration = null;
  });
  return pending;
};

const registerBotShell = (): Promise<void> => {
  if (botRegistration) return botRegistration;
  const pending = import('./bot/BotWorkspaceShell').then(({ BotWorkspaceShell }) => {
    registerWorkbenchShellComponent(VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID, BotWorkspaceShell);
  });
  botRegistration = pending;
  void pending.catch(() => {
    if (botRegistration === pending) botRegistration = null;
  });
  return pending;
};

export const registerWorkbenchShells = async (surface: VarinApplicationSurface): Promise<void> => {
  registerBuiltinSettingsWorkbench();
  const registrations: Promise<void>[] = [];
  if (surface === 'web' || surface === 'desktop' || surface === 'mobile') {
    registrations.push(registerAgentShell());
    registrations.push(registerBotShell());
  }
  if (surface === 'web' || surface === 'desktop') {
    registrations.push(registerIdeShell());
  }
  if (surface === 'web' || surface === 'desktop' || surface === 'mobile') {
    registrations.push(registerResearchShell());
  }
  await Promise.all(registrations);
};
