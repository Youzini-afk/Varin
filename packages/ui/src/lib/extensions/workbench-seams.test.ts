import { expect, test } from 'vitest';
import type {
  VarinExtensionCatalogEntry,
  VarinWorkbenchResolvedLayout,
} from '@varin/extension-contract';
import {
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
  VARIN_WORKBENCH_SLOTS,
} from '@varin/extension-contract';
import type { SurfaceContribution } from '@varin/extension-surface';
import { projectWorkbenchSeams } from './workbench-seams';

const agentEntry = (enabled = true): VarinExtensionCatalogEntry => ({
  manifest: {
    schemaVersion: 1,
    id: 'varin.builtin.agent-workspace',
    version: '1.0.0',
    engines: { varin: '*' },
    contributions: [{
      contractVersion: 1,
      data: {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
            ],
            slots: [],
          },
          desktop: {
            replacementTargets: [
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
            ],
            slots: [],
          },
          mobile: {
            replacementTargets: [
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
            ],
            slots: [],
          },
        },
      },
      id: 'varin.builtin.agent-workspace.shell',
      kind: 'shell',
      replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
      supports: ['web', 'desktop', 'mobile'],
    }],
  },
  source: { display: 'Agent', kind: 'builtin' },
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  actual: [],
  capabilityGrants: [],
  installedAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
});

const ideEntry = (enabled = true): VarinExtensionCatalogEntry => ({
  manifest: {
    schemaVersion: 1,
    id: 'varin.builtin.ide-workbench',
    version: '1.0.0',
    engines: { varin: '*' },
    contributions: [{
      contractVersion: 1,
      data: {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.activity,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.status,
            ],
            slots: Object.values(VARIN_WORKBENCH_SLOTS),
          },
          desktop: {
            replacementTargets: [
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.activity,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel,
              VARIN_WORKBENCH_REPLACEMENT_TARGETS.status,
            ],
            slots: Object.values(VARIN_WORKBENCH_SLOTS),
          },
        },
      },
      id: 'varin.builtin.ide-workbench.shell',
      kind: 'shell',
      replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
      supports: ['web', 'desktop'],
    }],
  },
  source: { display: 'IDE', kind: 'builtin' },
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  actual: [],
  capabilityGrants: [],
  installedAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
});

const layout = (selections: Record<string, string>): VarinWorkbenchResolvedLayout => ({
  profileId: 'default',
  references: [],
  replacementSelections: selections,
});

const candidate = (id: string, target: string): SurfaceContribution => ({
  descriptor: {
    contractVersion: 1,
    data: {},
    id,
    kind: 'view',
    replacement: { target },
    supports: ['web'],
  },
  implementation: { render: () => null },
  owner: {
    desiredRevision: 1,
    entrypointId: 'main',
    extensionId: 'dev.example',
    extensionVersion: '1.0.0',
    generation: 1,
    hostId: 'host-1',
    realmId: 'realm-1',
  },
});

test('Agent does not show the six IDE structure targets', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell' }),
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  const targets = new Set(projections.map((p) => p.target));
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.activity)).toBe(false);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar)).toBe(false);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor)).toBe(false);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar)).toBe(false);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel)).toBe(false);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.status)).toBe(false);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator)).toBe(true);
});

test('IDE shows the six structure targets', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.ide-workbench.shell' }),
    shellContributionId: 'varin.builtin.ide-workbench.shell',
    shellExtensionId: 'varin.builtin.ide-workbench',
    shellStatus: 'ready',
    catalog: [ideEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  const targets = new Set(projections.map((p) => p.target));
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.activity)).toBe(true);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar)).toBe(true);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor)).toBe(true);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar)).toBe(true);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel)).toBe(true);
  expect(targets.has(VARIN_WORKBENCH_REPLACEMENT_TARGETS.status)).toBe(true);
});

test('Agent Mobile does not claim workspace.explorer support', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell' }),
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'mobile',
    visibleContributions: [],
  });
  const explorer = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer);
  expect(explorer).toBeUndefined();
});

test('IDE selection for a structure target becomes dormant when switching to Agent', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell',
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel]: 'dev.example.panel',
    }),
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  const panel = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel);
  expect(panel?.status).toBe('dormant');
  expect(panel?.selected).toBe('dev.example.panel');
});

test('dormant selection becomes supported again when switching back to IDE', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.ide-workbench.shell',
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel]: 'dev.example.panel',
    }),
    shellContributionId: 'varin.builtin.ide-workbench.shell',
    shellExtensionId: 'varin.builtin.ide-workbench',
    shellStatus: 'ready',
    catalog: [ideEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.panel', VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel)],
  });
  const panel = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel);
  expect(panel?.status).toBe('supported');
  expect(panel?.selected).toBe('dev.example.panel');
});

test('unsupported candidate does not appear in supported candidates', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell' }),
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.panel', VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel)],
  });
  const panel = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel);
  // panel target is not supported by Agent shell, so even though a candidate exists,
  // it should not appear as supported
  expect(panel).toBeUndefined();
});

test('missing selected contribution is distinct from dormant', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.ide-workbench.shell',
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor]: 'dev.example.missing-editor',
    }),
    shellContributionId: 'varin.builtin.ide-workbench.shell',
    shellExtensionId: 'varin.builtin.ide-workbench',
    shellStatus: 'ready',
    catalog: [ideEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.available-editor', VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor)],
  });
  const editor = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor);
  expect(editor?.status).toBe('missing-selection');
  expect(editor?.selected).toBe('dev.example.missing-editor');
  expect(editor?.status === 'missing-selection' ? editor.candidates.map((item) => item.descriptor.id) : [])
    .toEqual(['dev.example.available-editor']);
});

test('profile input object is not mutated', () => {
  const inputLayout = layout({
    [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell',
  });
  const frozen = JSON.stringify(inputLayout);
  projectWorkbenchSeams({
    layout: inputLayout,
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  expect(JSON.stringify(inputLayout)).toBe(frozen);
});

test('shell and transition are always platform', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell' }),
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.transition', VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition)],
  });
  const shell = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell);
  expect(shell?.status).toBe('platform');
  const transition = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition);
  expect(transition?.status).toBe('platform');
  expect(transition?.status === 'platform' ? transition.candidates.map((item) => item.descriptor.id) : [])
    .toEqual(['dev.example.transition']);
});

test('malformed shell contract shows existing selections as dormant, not supported', () => {
  const badEntry: VarinExtensionCatalogEntry = {
    ...agentEntry(),
    manifest: {
      ...agentEntry().manifest,
      contributions: [{
        contractVersion: 1,
        data: { contract: 'wrong', seams: {} },
        id: 'varin.builtin.agent-workspace.shell',
        kind: 'shell',
        replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
        supports: ['web', 'desktop', 'mobile'],
      }],
    },
  };
  const projections = projectWorkbenchSeams({
    layout: layout({
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'varin.builtin.agent-workspace.shell',
      [VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator]: 'dev.example.nav',
    }),
    shellContributionId: 'varin.builtin.agent-workspace.shell',
    shellExtensionId: 'varin.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [badEntry],
    surface: 'web',
    visibleContributions: [],
  });
  const nav = projections.find((p) => p.target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator);
  expect(nav?.status).toBe('dormant');
});
