import { describe, expect, test } from 'vitest';
import type { PiCommandDescriptor } from '@varin/protocol';
import { aftRuntimeState, observedAftStatusCommand } from './aft-runtime';

const command = (name: string): PiCommandDescriptor => ({
  name,
  source: 'extension',
  sourceInfo: { origin: 'top-level', path: name, scope: 'user', source: name },
});

describe('AFT runtime observation', () => {
  test('observes only the command-list aft-status entry', () => {
    expect(observedAftStatusCommand([command('aft-status')])).toBe(true);
    expect(observedAftStatusCommand([command('/aft-status')])).toBe(false);
    expect(observedAftStatusCommand([command('aft')])).toBe(false);
  });

  test('keeps no session, probe failure, absence, and availability distinct', () => {
    expect(aftRuntimeState({ commandsChecked: true, commandsFailed: false, hasActiveSession: false, statusCommandObserved: true })).toBe('no-session');
    expect(aftRuntimeState({ commandsChecked: false, commandsFailed: false, hasActiveSession: true, statusCommandObserved: false })).toBe('loading');
    expect(aftRuntimeState({ commandsChecked: false, commandsFailed: true, hasActiveSession: true, statusCommandObserved: false })).toBe('failure');
    expect(aftRuntimeState({ commandsChecked: true, commandsFailed: false, hasActiveSession: true, statusCommandObserved: false })).toBe('not-observed');
    expect(aftRuntimeState({ commandsChecked: true, commandsFailed: false, hasActiveSession: true, statusCommandObserved: true })).toBe('available');
  });
});
