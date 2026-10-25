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

import React from 'react';
import {
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID,
  type VarinApplicationSurface,
} from '@varin/extension-contract';
import { registerWorkbenchShellComponent } from '@/lib/extensions/shell-component-registry';
import { registerBuiltinSettingsWorkbench } from './settings/register';

const registered = new Set<string>();

// Register the contribution synchronously; evaluate its UI only when the selected/candidate
// Shell actually renders. Suspense belongs to that Shell slot, not the whole application.
export const registerLazyWorkbenchShell = (
  id: string,
  load: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>,
): void => {
  if (registered.has(id)) return;
  let failed = false;
  const create = () => React.lazy(async () => {
    try { return await load(); }
    catch (error) { failed = true; throw error; }
  });
  let implementation = create();
  registerWorkbenchShellComponent(id, (props) => React.createElement(implementation, props), () => {
    if (!failed) return;
    failed = false;
    implementation = create();
  });
  registered.add(id);
};

export const registerWorkbenchShells = (surface: VarinApplicationSurface): void => {
  registerBuiltinSettingsWorkbench();
  if (surface === 'web' || surface === 'desktop' || surface === 'mobile') {
    registerLazyWorkbenchShell(VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
      () => import('./agent/AgentWorkspaceShell').then(m => ({ default: m.AgentWorkspaceShell })));
    registerLazyWorkbenchShell(VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID,
      () => import('./bot/BotWorkspaceShell').then(m => ({ default: m.BotWorkspaceShell })));
    registerLazyWorkbenchShell(VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID,
      () => import('./research/ResearchWorkbenchShell').then(m => ({ default: m.ResearchWorkbenchShell })));
  }
  if (surface === 'web' || surface === 'desktop') {
    registerLazyWorkbenchShell(VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
      () => import('./ide/IdeWorkbenchShell').then(m => ({ default: m.IdeWorkbenchShell })));
  }
};
