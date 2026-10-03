import { describe, expect, test } from 'vitest';
import type { FoundationalPiPackageStatusEntry } from '@varin/protocol';
import {
  foundationalRestoreSucceeded,
  hasFoundationalPackageRestoreAction,
  projectFoundationalPackageStatus,
} from './foundational-package-presentation';

const entry = (
  overrides: Partial<FoundationalPiPackageStatusEntry> = {},
): FoundationalPiPackageStatusEntry => ({
  id: 'mcp',
  intent: 'eligible',
  observed: 'missing',
  operation: 'idle',
  provenance: 'none',
  ...overrides,
});

describe('foundational package presentation', () => {
  test('distinguishes missing, user-suppressed, and policy-skipped states', () => {
    expect(projectFoundationalPackageStatus(entry()).statusKey).toContain('.missing');
    expect(projectFoundationalPackageStatus(entry({ intent: 'suppressed' })).statusKey).toContain('.suppressed');
    expect(projectFoundationalPackageStatus(entry({ intent: 'policy_skipped' })).statusKey).toContain('.policySkipped');
  });

  test('keeps Pi observations and actionable failures honest', () => {
    expect(projectFoundationalPackageStatus(entry({ observed: 'enabled' })).statusKey).toContain('.enabled');
    expect(projectFoundationalPackageStatus(entry({ observed: 'disabled' })).statusKey).toContain('.disabled');
    expect(projectFoundationalPackageStatus(entry({ observed: 'configured_broken' })).statusKey).toContain('.configuredBroken');
    expect(projectFoundationalPackageStatus(entry({ observed: 'source_conflict' })).statusKey).toContain('.sourceConflict');
    expect(projectFoundationalPackageStatus(entry({ operation: 'failed_retryable' })).action).toBe('retry');
    expect(projectFoundationalPackageStatus(entry({ operation: 'action_required' })).action).toBe('none');
    expect(projectFoundationalPackageStatus(entry({
      intent: 'suppressed',
      observed: 'enabled',
      operation: 'action_required',
    })).action).toBe('restore');
    expect(projectFoundationalPackageStatus(entry({
      intent: 'suppressed',
      observed: 'configured_broken',
      operation: 'action_required',
    })).statusKey).toContain('.configuredBroken');
  });

  test('accepts a restore only when the requested entries no longer offer restore or retry', () => {
    const failed = {
      autoInstallNew: true,
      entries: [entry({ operation: 'failed_retryable' })],
      manifestRevision: 1,
      revision: 2,
      state: 'degraded' as const,
    };
    expect(foundationalRestoreSucceeded(failed, ['mcp'])).toBe(false);
    expect(foundationalRestoreSucceeded({
      ...failed,
      entries: [entry({
        observed: 'configured_broken',
        operation: 'action_required',
      })],
    }, ['mcp'])).toBe(false);
    expect(foundationalRestoreSucceeded({
      ...failed,
      entries: [entry({
        observed: 'source_conflict',
        operation: 'action_required',
      })],
    }, ['mcp'])).toBe(false);
    expect(foundationalRestoreSucceeded({
      ...failed,
      entries: [entry({ observed: 'enabled' })],
      state: 'ready',
    }, ['mcp'])).toBe(true);
  });

  test('never invents progress for running operations', () => {
    const projection = projectFoundationalPackageStatus(entry({ operation: 'verifying' }));
    expect(projection.running).toBe(true);
    expect(projection.statusKey).toContain('.working');
  });

  test('detects when restore controls are needed', () => {
    expect(hasFoundationalPackageRestoreAction({
      autoInstallNew: true,
      entries: [entry({ observed: 'missing' })],
      manifestRevision: 1,
      revision: 1,
      state: 'ready',
    })).toBe(true);
    expect(hasFoundationalPackageRestoreAction({
      autoInstallNew: true,
      entries: [entry({ observed: 'enabled' })],
      manifestRevision: 1,
      revision: 1,
      state: 'ready',
    })).toBe(false);
  });
});
