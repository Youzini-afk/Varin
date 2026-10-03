import { expect, test } from 'vitest';
import type {
  VarinExtensionCatalogEntry,
  VarinExtensionHostStateSnapshot,
} from '@varin/extension-contract';
import {
  defaultVarinWorkbenchProfileDocument,
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  VARIN_WORKBENCH_IDE_PROFILE_ID,
  VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
} from '@varin/extension-contract';
import type { SurfaceRegistrySnapshot } from '@varin/extension-surface';
import { resolveWorkbenchShellView } from './workbench-shell-view';

const hostId = '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a';

const surfaceSnapshot = (failed = false): SurfaceRegistrySnapshot => ({
  actual: failed ? [{
    desiredRevision: 1,
    diagnostics: [],
    entrypointId: 'main',
    extensionId: VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
    extensionVersion: '1.0.0',
    generation: 1,
    hostId,
    realmId: 'surface',
    realmKind: 'surface',
    status: 'failed',
    updatedAt: '2026-08-20T00:00:00.000Z',
  }] : [],
  contributions: [],
  layoutReferences: [],
  replacementSelections: {},
  revision: 1,
  serviceSelections: {},
  services: [],
  visibleContributions: [],
});

const agentEntry = (enabled: boolean, failed = false): VarinExtensionCatalogEntry => ({
  actual: failed
    ? [{
      desiredRevision: 1,
      diagnostics: [],
      entrypointId: 'main',
      generation: 1,
      hostId,
      realmId: 'surface',
      realmKind: 'surface',
      status: 'failed',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }]
    : [],
  capabilityGrants: [],
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  installedAt: '2026-08-20T00:00:00.000Z',
  manifest: {
    contributions: [{
      contractVersion: 1,
      data: {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: { replacementTargets: [], slots: [] },
          desktop: { replacementTargets: [], slots: [] },
          mobile: { replacementTargets: [], slots: [] },
        },
      },
      id: VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
      kind: 'shell',
      replacement: { target: 'workbench.shell' },
      supports: ['web', 'desktop', 'mobile'],
    }],
    engines: { varin: '*' },
    id: VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
    schemaVersion: 1,
    version: '1.0.0',
  },
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
  source: { display: 'Agent Workspace', kind: 'builtin' },
  updatedAt: '2026-08-20T00:00:00.000Z',
});

const hostSnapshot = (
  entry: VarinExtensionCatalogEntry,
  options?: { authoritative?: boolean },
): VarinExtensionHostStateSnapshot => ({
  catalog: {
    authoritative: true,
    diagnostics: [],
    extensions: [entry],
    hostId,
    loadedAt: '2026-08-20T00:00:00.000Z',
    revision: 1,
    schemaVersion: 1,
    storageState: 'ready',
  },
  revision: 1,
  routing: {
    authoritative: true,
    diagnostics: [],
    document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' },
    hostId,
    storageState: 'missing',
  },
  services: { hostId, providers: [], revision: 0, selections: {} },
  workbench: {
    authoritative: options?.authoritative ?? true,
    diagnostics: [],
    document: defaultVarinWorkbenchProfileDocument(),
    hostId,
    storageState: 'missing',
  },
});

test('keeps a loading shell until the workbench document is authoritative', () => {
  expect(resolveWorkbenchShellView(null, 'web').view).toBe('loading');
  expect(resolveWorkbenchShellView(hostSnapshot(agentEntry(true), { authoritative: false }), 'web').view).toBe('loading');
});

test('disabling the Agent Workspace extension recovers without treating the catalog as missing', () => {
  const disabled = resolveWorkbenchShellView(hostSnapshot(agentEntry(false)), 'web');
  expect(disabled.view).toBe('recovery');
  expect(disabled.resolved?.status).toBe('disabled');
  expect(disabled.resolved?.shellExtensionId).toBe(VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID);

  const restored = resolveWorkbenchShellView(hostSnapshot(agentEntry(true)), 'web');
  expect(restored.view).toBe('ready');
  expect(restored.resolved?.status).toBe('ready');
  expect(restored.resolved?.shellContributionId).toBe(VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
});

test('a failed Agent Workspace actual state stays in Recovery', () => {
  const failed = resolveWorkbenchShellView(hostSnapshot(agentEntry(true, true)), 'web');
  expect(failed.view).toBe('recovery');
  expect(failed.resolved?.status).toBe('failed');
});

test('a failed Surface in another window does not put this window in Recovery', () => {
  const foreignFailure = resolveWorkbenchShellView(
    hostSnapshot(agentEntry(true, true)),
    'web',
    undefined,
    surfaceSnapshot(false),
  );
  expect(foreignFailure.view).toBe('ready');

  const localFailure = resolveWorkbenchShellView(
    hostSnapshot(agentEntry(true, true)),
    'web',
    undefined,
    surfaceSnapshot(true),
  );
  expect(localFailure.view).toBe('recovery');
  expect(localFailure.resolved?.status).toBe('failed');
});

test('the IDE profile is ready on web and recovers on mobile where it has no shell', () => {
  const ideEntry: VarinExtensionCatalogEntry = {
    ...agentEntry(true),
    manifest: {
      ...agentEntry(true).manifest,
      id: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
      contributions: [{
        contractVersion: 1,
        data: {
          contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
          seams: {
            web: { replacementTargets: [], slots: [] },
            desktop: { replacementTargets: [], slots: [] },
          },
        },
        id: VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
        kind: 'shell',
        replacement: { target: 'workbench.shell' },
        supports: ['web', 'desktop'],
      }],
    },
    source: { display: 'IDE Workbench', kind: 'builtin' },
  };
  const snapshot = hostSnapshot(ideEntry);
  snapshot.workbench.document = {
    ...snapshot.workbench.document,
    activeProfileId: VARIN_WORKBENCH_IDE_PROFILE_ID,
  };
  const web = resolveWorkbenchShellView(snapshot, 'web');
  expect(web.view).toBe('ready');
  expect(web.resolved?.shellContributionId).toBe(VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  const mobile = resolveWorkbenchShellView(snapshot, 'mobile');
  expect(mobile.view).toBe('recovery');
  expect(mobile.resolved?.status).toBe('builtin');
});
