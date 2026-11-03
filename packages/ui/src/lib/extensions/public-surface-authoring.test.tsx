import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  defineCommand, defineSettingsPageMount, defineToolRenderer, resolveSurfaceExtensionModule,
  VARIN_CONVERSATION_SLOTS, type VarinManagedSurfaceModule, type VarinToolRendererPropsV1,
} from '@varin/extension-sdk';
import { initProject } from '../../../../extension-cli/src/init';
import { buildProject } from '../../../../extension-cli/src/build';
import { checkProject } from '../../../../extension-cli/src/project';
import type { SurfaceOwnerHandle, SurfaceOwnerIdentity } from '@varin/extension-surface';

vi.doMock('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));
const { varinSurfaceRuntime } = await import('./surface-runtime');
const { WorkbenchContributionSlot, workbenchMatchRenderersFromContributions, renderFirstWorkbenchMatch } = await import('./workbench-registry');
const { settingsPageRegistrationsFromSnapshot } = await import('../settings/surface-registry');
const { workbenchCommandRegistrationsFromSnapshot } = await import('../commands/surface-command-registry');

let root: Root, container: HTMLElement;
const handles: SurfaceOwnerHandle[] = [], directories: string[] = [];
const owner = (extensionId: string, generation = 1): SurfaceOwnerIdentity => ({
  extensionId, extensionVersion: '0.1.0', entrypointId: `${extensionId}.main`,
  realmId: 'public-author-test', hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078', desiredRevision: generation, generation,
});
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { for (const handle of handles.splice(0)) await handle.deactivate(10, 10); root.unmount(); });
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })));
  vi.unstubAllGlobals();
});

test('the default published starter becomes a visible interactive composer action and withdraws cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-public-starter-')); directories.push(directory);
  const project = await initProject({ directory: join(directory, 'extension'), id: 'dev.example.starter', name: 'Counter' });
  const dependencies = join(directory, 'node_modules', '@varin'); await mkdir(dependencies, { recursive: true });
  for (const name of ['extension-sdk', 'extension-contract']) {
    const entry = await realpath(fileURLToPath(import.meta.resolve(`@varin/${name}`)));
    await symlink(dirname(dirname(entry)), join(dependencies, name), 'junction');
  }
  const built = await buildProject(project.directory);
  expect((await checkProject(project.directory)).authorDiagnostics).toEqual([]);
  const module = createRequire(import.meta.url)(join(project.directory, built.outputs[0]!.file)) as VarinManagedSurfaceModule;
  const extension = resolveSurfaceExtensionModule(module);
  const handle = await varinSurfaceRuntime.activate({ owner: owner('dev.example.starter') }, context => extension.activate({
    ...context, assets: { read: async () => { throw new Error('No asset is needed'); }, url: async () => { throw new Error('No asset is needed'); } },
    styles: { use: async () => { throw new Error('No style asset is needed'); } },
  }));
  handles.push(handle);
  await act(async () => root.render(<WorkbenchContributionSlot kind="composer-action" slot={VARIN_CONVERSATION_SLOTS.composerTrailing} />));
  const button = container.querySelector('button')!;
  expect(button?.textContent).toBe('Counter · 0');
  button.click(); expect(button.textContent).toBe('Counter · 1');
  await act(async () => handle.deactivate(2, 2));
  expect(container.querySelector('button')).toBeNull();
  button.click(); expect(button.textContent).toBe('Counter · 1');
});

test('a public settings page mounts both regions without private React or translation interfaces', async () => {
  const disposed: string[] = [], signals: AbortSignal[] = [];
  handles.push(await varinSurfaceRuntime.activate({ owner: owner('dev.example.settings-public') }, context => {
    context.contribute({ id: 'dev.example.settings-public.page', kind: 'settings-page', contractVersion: 1,
      supports: ['web'], data: { slug: 'example-options', title: 'Example options', kind: 'split' },
    }, defineSettingsPageMount((element, mount) => {
      signals.push(mount.signal); element.textContent = `public ${mount.props.region}`;
      return () => { disposed.push(mount.props.region); element.replaceChildren(); };
    }));
  }));
  const registration = settingsPageRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot())
    .find(page => page.meta.slug === 'example-options')!;
  expect(registration.meta.title).toBe('Example options'); expect(registration.meta.titleKey).toBeUndefined();
  await act(async () => root.render(<>{registration.implementation.renderSidebar?.({})}{registration.implementation.renderContent()}</>));
  expect(container.textContent).toBe('public sidebarpublic content');
  await act(async () => handles[0]!.deactivate(2, 2));
  expect(container.textContent).toBe('');
  expect(disposed.sort()).toEqual(['content', 'sidebar']); expect(signals.every(signal => signal.aborted)).toBe(true);
});

test('a public command has an author label and executes through the product command registration', async () => {
  const execute = vi.fn();
  handles.push(await varinSurfaceRuntime.activate({ owner: owner('dev.example.command-public') }, context => {
    context.contribute({ id: 'dev.example.command-public.run', kind: 'command', contractVersion: 1,
      supports: ['web'], data: { title: 'Count this workspace', keywords: ['count'] },
    }, defineCommand(execute));
  }));
  const registration = workbenchCommandRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot())
    .find(command => command.contributionId === 'dev.example.command-public.run')!;
  expect(registration.meta.title).toBe('Count this workspace'); expect(registration.meta.titleKey).toBeUndefined();
  await registration.implementation.execute({ currentDirectory: '/project', isMobile: false });
  expect(execute).toHaveBeenCalledWith({ currentDirectory: '/project', isMobile: false });
  await handles[0]!.deactivate(2, 2);
  expect(workbenchCommandRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot())).not.toContain(registration);
});

test('a public tool renderer receives detached presentation, mounts, updates and releases its original instance', async () => {
  const disposed: string[] = [], signals: AbortSignal[] = [];
  let matched: Readonly<VarinToolRendererPropsV1> | undefined;
  handles.push(await varinSurfaceRuntime.activate({ owner: owner('dev.example.renderer') }, context => {
    context.contribute({ id: 'dev.example.renderer.result', kind: 'tool-renderer', contractVersion: 1,
      supports: ['web'], placement: { slot: VARIN_CONVERSATION_SLOTS.tools }, data: {},
    }, defineToolRenderer({ matches: input => { matched = input; return input.call.name === 'example'; },
      mount: (element, mount) => {
        signals.push(mount.signal); const text = String(mount.props.result?.details ?? 'pending'); element.textContent = text;
        return () => { disposed.push(text); element.replaceChildren(); };
      },
    }));
  }));
  const renderers = workbenchMatchRenderersFromContributions<VarinToolRendererPropsV1>(varinSurfaceRuntime.getSnapshot().visibleContributions);
  const input = { cwd: '/project', call: { id: 'call', name: 'example', arguments: {} }, result: { details: 'first' } };
  await act(async () => root.render(<>{renderFirstWorkbenchMatch(renderers, input)}</>));
  expect(container.textContent).toBe('first'); expect(matched).not.toBe(input); expect(matched?.call).not.toBe(input.call);
  expect(Object.isFrozen(matched?.call)).toBe(true);
  const next = { ...input, result: { details: 'second' } };
  await act(async () => root.render(<>{renderFirstWorkbenchMatch(renderers, next)}</>));
  expect(container.textContent).toBe('second'); expect(disposed).toEqual(['first']); expect(signals[0]?.aborted).toBe(true);
  await act(async () => handles[0]!.deactivate(2, 2));
  expect(container.textContent).toBe(''); expect(disposed).toEqual(['first', 'second']);
});

test('private distribution renderers remain usable and old unimplemented metadata does not break other entries', async () => {
  const execute = vi.fn();
  handles.push(await varinSurfaceRuntime.activate({ owner: owner('dev.example.legacy') }, context => {
    context.contribute({ id: 'dev.example.legacy.settings', kind: 'settings-page', contractVersion: 1, supports: ['web'],
      data: { slug: 'legacy-options', title: 'Legacy options', titleKey: 'settings.page.general.title',
        group: 'general', kind: 'single', icon: 'settings-3', order: 4 },
    }, { renderContent: () => <span>legacy settings</span> });
    context.contribute({ id: 'dev.example.legacy.command', kind: 'command', contractVersion: 1, supports: ['web'],
      data: { commandId: 'legacy.command', titleKey: 'commandPalette.item.newSession', icon: 'play', order: 4 },
    }, { execute });
    context.contribute({ id: 'dev.example.legacy.renderer', kind: 'tool-renderer', contractVersion: 1, supports: ['web'],
      placement: { slot: VARIN_CONVERSATION_SLOTS.tools }, data: {},
    }, { matches: () => true, render: () => <span>legacy result</span> });
    context.contribute({ id: 'dev.example.legacy.malformed-settings', kind: 'settings-page', contractVersion: 1, supports: ['web'],
      data: { title: 'Unfinished page', slug: 'invalid_slug' },
    }, defineSettingsPageMount(() => undefined));
    context.contribute({ id: 'dev.example.legacy.malformed-command', kind: 'command', contractVersion: 1, supports: ['web'],
      data: { title: 17 },
    }, { execute });
    for (const kind of ['settings-page', 'command'] as const) {
      context.contribute({ id: `dev.example.legacy.empty-${kind}`, kind, contractVersion: 1, supports: ['web'], data: {} }, { kind: 'declarative' });
    }
  }));
  const snapshot = varinSurfaceRuntime.getSnapshot();
  const pages = settingsPageRegistrationsFromSnapshot(snapshot), commands = workbenchCommandRegistrationsFromSnapshot(snapshot);
  expect(pages.map(page => page.contributionId)).toEqual(['dev.example.legacy.settings']);
  expect(commands.map(command => command.contributionId)).toEqual(['dev.example.legacy.command']);
  expect(commands[0]?.meta.titleKey).toBe('commandPalette.item.newSession');
  await commands[0]!.implementation.execute({ currentDirectory: null, isMobile: true });
  expect(execute).toHaveBeenCalledOnce();
  const renderers = workbenchMatchRenderersFromContributions(snapshot.visibleContributions);
  await act(async () => root.render(<>{pages[0]!.implementation.renderContent()}{renderFirstWorkbenchMatch(renderers, {})}</>));
  expect(container.textContent).toBe('legacy settingslegacy result');
});
