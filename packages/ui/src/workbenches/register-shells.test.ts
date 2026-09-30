import { describe, expect, it } from 'vitest';
import {
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID,
} from '@varin/extension-contract';
import { resolveWorkbenchShellComponent } from '@/lib/extensions/shell-component-registry';
import { ensureBuiltinSettingsContributions } from '@/lib/settings/surface-registry';
import { registerWorkbenchShells } from './register-shells';

describe('production workbench registration', () => {
  it('registers the built-in shells and the Settings composition source', async () => {
    await registerWorkbenchShells('web');
    expect(resolveWorkbenchShellComponent(VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID)).toBeTruthy();
    expect(resolveWorkbenchShellComponent(VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID)).toBeTruthy();
    expect(resolveWorkbenchShellComponent(VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID)).toBeTruthy();
    expect(resolveWorkbenchShellComponent(VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID)).toBeTruthy();
    await expect(ensureBuiltinSettingsContributions()).resolves.toBeUndefined();
  });
});
