import { expect, test } from 'vitest';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@varin/extension-surface';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import {
  ensureBuiltinWorkbenchCommands,
  executeSurfaceCommandContribution,
  setBuiltinWorkbenchCommandsEnabled,
  workbenchCommandRegistrationsFromSnapshot,
} from './surface-command-registry';

test('withdraws and restores built-in command contributions without a document refresh', async () => {
  await ensureBuiltinWorkbenchCommands();
  const registrations = workbenchCommandRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot());
  const expectedCommandIds = [
    'new-session',
    'new-worktree',
    'add-project',
    'workspace-search',
    'toggle-sidebar',
    'toggle-terminal',
    'context-usage',
    'open-settings',
    'split-editor',
    'split-editor-orthogonal',
    'close-editor',
    'save-active-file',
    'editor.saveAll',
    'editor.find',
    'editor.replace',
    'editor.goToLine',
    'editor.goToSymbol',
    'editor.formatDocument',
    'editor.renameSymbol',
    'editor.quickFix',
    'editor.goToDefinition',
    'editor.findReferences',
    'editor.fold',
    'editor.unfold',
    'editor.toggleWordWrap',
    'editor.toggleMinimap',
    'editor.addCursorAbove',
    'editor.addCursorBelow',
    'editor.focusPreviousGroup',
    'editor.focusNextGroup',
  ];
  expect(registrations.map((registration) => registration.meta.commandId)).toEqual(expectedCommandIds);
  expect(registrations.find((registration) => registration.meta.commandId === 'editor.saveAll')?.contributionId)
    .toBe('varin.builtin.commands.editor.save-all');
  expect(registrations.find((registration) => registration.meta.commandId === 'toggle-sidebar')?.meta.mobileTitleKey)
    .toBe('commandPalette.item.showSessionSwitcher');

  await setBuiltinWorkbenchCommandsEnabled(false);
  expect(workbenchCommandRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot())).toEqual([]);

  await setBuiltinWorkbenchCommandsEnabled(true);
  expect(workbenchCommandRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot()).length)
    .toBe(expectedCommandIds.length);
});

test('a declarative command activates and executes the latest dynamic implementation', async () => {
  const contribution: SurfaceContribution = {
    descriptor: {
      contractVersion: 1,
      data: {
        commandId: 'lazy-command',
        icon: 'play',
        keywords: [],
        order: 10,
        titleKey: 'commandPalette.item.openSettings',
      },
      entrypoint: 'dev.example.command.manifest',
      id: 'dev.example.command.lazy',
      kind: 'command',
      supports: ['web'],
    },
    implementation: { kind: 'declarative' },
    owner: {
      desiredRevision: 1,
      entrypointId: 'dev.example.command.manifest',
      extensionId: 'dev.example.command',
      extensionVersion: '1.0.0',
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'command-test',
    },
  };
  const snapshot = (value: SurfaceContribution): SurfaceRegistrySnapshot => ({
    actual: [],
    contributions: [value],
    layoutReferences: [],
    replacementSelections: {},
    revision: 1,
    serviceSelections: {},
    services: [],
    visibleContributions: [value],
  });
  let current = snapshot(contribution);
  let activations = 0;
  const executed: Array<string | null> = [];
  const dependencies = {
    getSnapshot: () => current,
    trigger: async () => {
      activations += 1;
      current = snapshot({
        ...contribution,
        implementation: { execute: (context: { currentDirectory: string | null }) => { executed.push(context.currentDirectory); } },
        owner: { ...contribution.owner, entrypointId: 'main', generation: 2 },
      });
    },
  };

  expect(workbenchCommandRegistrationsFromSnapshot(current).map((registration) => registration.meta.commandId))
    .toEqual(['lazy-command']);
  await executeSurfaceCommandContribution(
    contribution.descriptor.id,
    { currentDirectory: '/workspace', isMobile: false },
    dependencies,
  );
  await executeSurfaceCommandContribution(
    contribution.descriptor.id,
    { currentDirectory: '/workspace/next', isMobile: false },
    dependencies,
  );
  expect(activations).toBe(1);
  expect(executed).toEqual(['/workspace', '/workspace/next']);
});
