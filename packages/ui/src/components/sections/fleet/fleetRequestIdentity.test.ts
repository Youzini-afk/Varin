import { describe, expect, test } from 'vitest';
import {
  fleetSessionTargetKey,
  fleetUiRequestIsCurrent,
  type FleetUiRequestIdentity,
} from './fleetRequestIdentity';

const identity = (sessionId: string, generation = 1): FleetUiRequestIdentity => ({
  generation,
  runtimeKey: 'runtime-a',
  sessionId,
  targetKey: fleetSessionTargetKey('runtime-a', sessionId),
});

describe('fleetUiRequestIsCurrent', () => {
  test('requires session, runtime key, target key, and generation to match', () => {
    const captured = identity('session-a');
    expect(fleetUiRequestIsCurrent(captured, captured)).toBe(true);
    expect(fleetUiRequestIsCurrent(captured, { ...captured, generation: 2 })).toBe(false);
    expect(fleetUiRequestIsCurrent(captured, { ...captured, runtimeKey: 'runtime-b' })).toBe(false);
    expect(fleetUiRequestIsCurrent(captured, identity('session-b'))).toBe(false);
    expect(fleetUiRequestIsCurrent(captured, { ...captured, sessionId: null, targetKey: captured.targetKey })).toBe(false);
  });

  test('ignores a deferred session A action after switching to session B', async () => {
    let settleA!: (value: { logs: string; snapshotKey: string }) => void;
    const deferredA = new Promise<{ logs: string; snapshotKey: string }>((resolve) => {
      settleA = resolve;
    });
    const sessionA = identity('session-a', 1);
    const sessionB = identity('session-b', 2);
    const view = {
      busy: 'session-b:idle' as string | null,
      logs: null as string | null,
      snapshotKey: null as string | null,
      toast: null as string | null,
    };

    const applyA = deferredA.then((result) => {
      if (!fleetUiRequestIsCurrent(sessionA, sessionB)) return;
      view.busy = null;
      view.logs = result.logs;
      view.snapshotKey = result.snapshotKey;
    });
    const applyAError = deferredA.then(() => undefined, (error: unknown) => {
      if (!fleetUiRequestIsCurrent(sessionA, sessionB)) return;
      view.toast = error instanceof Error ? error.message : String(error);
      view.busy = null;
    });

    settleA({ logs: 'secret-from-a', snapshotKey: 'task-from-a' });
    await Promise.all([applyA, applyAError]);

    expect(view.busy).toBe('session-b:idle');
    expect(view.logs).toBeNull();
    expect(view.snapshotKey).toBeNull();
    expect(view.toast).toBeNull();
  });
});
