import { describe, expect, test } from 'vitest';
import type { VarinExtensionCatalogEntry, VarinExtensionStaticContribution } from '@varin/extension-contract';
import {
  VARIN_DEBUG_SERVICE_ID,
  VARIN_LANGUAGE_SERVICE_ID,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
  VARIN_WORKBENCH_SLOTS,
} from '@varin/extension-contract';
import {
  describeWorkbenchContributionPlacement,
  describeWorkbenchShellSeams,
  workbenchInspectorOwnsDocuments,
  workbenchInspectorOwnsLanguage,
  workbenchInspectorOwnsRun,
} from './workbench-inspector';

const shellEntry = (overrides?: Partial<VarinExtensionStaticContribution>): VarinExtensionCatalogEntry => ({
  manifest: {
    schemaVersion: 1,
    id: 'dev.example.shell',
    version: '1.0.0',
    engines: { varin: '*' },
    contributions: [{
      contractVersion: 1,
      data: {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor],
            slots: [VARIN_WORKBENCH_SLOTS.editorActions],
          },
        },
      },
      id: 'dev.example.shell.entry',
      kind: 'shell',
      replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
      supports: ['web'],
      ...overrides,
    }],
  },
  source: { display: 'Test', kind: 'builtin' },
  desired: { enabled: true, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  actual: [],
  capabilityGrants: [],
  installedAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
});

describe('workbench inspector summaries', () => {
  test('describe contribution placement and replacement without private state', () => {
    expect(describeWorkbenchContributionPlacement({
      id: 'dev.example.view',
      kind: 'view',
      contractVersion: 1,
      placement: { slot: VARIN_WORKBENCH_SLOTS.primarySidebarViews, order: 10 },
    })).toEqual({
      id: 'dev.example.view',
      kind: 'view',
      contractVersion: 1,
      contractCompatibility: 'supported',
      placement: VARIN_WORKBENCH_SLOTS.primarySidebarViews,
    });
    expect(describeWorkbenchContributionPlacement({
      id: 'dev.example.shell',
      kind: 'shell',
      contractVersion: 1,
      replacement: { target: 'workbench.shell' },
    }).replacement).toBe('workbench.shell');
  });

  test('describe contribution placement reports unsupported contract version', () => {
    const result = describeWorkbenchContributionPlacement({
      id: 'dev.example.future',
      kind: 'view',
      contractVersion: 99,
    });
    expect(result.contractCompatibility).toBe('unsupported-contract-version');
    expect(result.contractVersion).toBe(99);
    expect(result.supportedVersions).toEqual([1]);
  });

  test('identifies document and language owners from public service and capability ids', () => {
    expect(workbenchInspectorOwnsLanguage(VARIN_LANGUAGE_SERVICE_ID)).toBe(true);
    expect(workbenchInspectorOwnsRun(VARIN_DEBUG_SERVICE_ID)).toBe(true);
    expect(workbenchInspectorOwnsDocuments('workspace.documents')).toBe(true);
    expect(workbenchInspectorOwnsDocuments('workspace.search')).toBe(false);
  });

  test('describeWorkbenchShellSeams returns declared seams for a valid shell', () => {
    const summary = describeWorkbenchShellSeams(
      'dev.example.shell.entry',
      'dev.example.shell',
      [shellEntry()],
      'web',
    );
    expect(summary).not.toBeNull();
    expect(summary?.declaredReplacementTargets).toEqual([VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor]);
    expect(summary?.declaredSlots).toEqual([VARIN_WORKBENCH_SLOTS.editorActions]);
    expect(summary?.contractValid).toBe(true);
    expect(summary?.contractIssues).toEqual([]);
  });

  test('describeWorkbenchShellSeams returns null for missing shell ids', () => {
    expect(describeWorkbenchShellSeams(undefined, undefined, [], 'web')).toBeNull();
  });

  test('describeWorkbenchShellSeams returns null when shell not in catalog', () => {
    expect(describeWorkbenchShellSeams('dev.example.shell.entry', 'dev.example.shell', [], 'web')).toBeNull();
  });

  test('describeWorkbenchShellSeams returns null for unsupported surface', () => {
    expect(describeWorkbenchShellSeams(
      'dev.example.shell.entry',
      'dev.example.shell',
      [shellEntry()],
      'mobile',
    )).toBeNull();
  });

  test('describeWorkbenchShellSeams reports invalid contract', () => {
    const summary = describeWorkbenchShellSeams(
      'dev.example.shell.entry',
      'dev.example.shell',
      [shellEntry({ data: { contract: 'wrong', seams: {} } })],
      'web',
    );
    expect(summary).not.toBeNull();
    expect(summary?.contractValid).toBe(false);
    expect(summary?.contractIssues.length).toBeGreaterThan(0);
    expect(summary?.declaredReplacementTargets).toEqual([]);
  });
});
