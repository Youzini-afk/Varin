import { describe, expect, test } from 'vitest';
import type { PiCommandDescriptor } from '@varin/protocol';
import {
  hermesMemoryRuntimeState,
  observedHermesMemoryCommand,
} from './hermes-memory-runtime';

const command = (name: string): PiCommandDescriptor => ({
  name,
  source: 'extension',
  sourceInfo: { origin: 'top-level', path: name, scope: 'user', source: name },
});

describe('Hermes Memory runtime observation', () => {
  test('uses only the exact command-list memory-insights signature', () => {
    expect(observedHermesMemoryCommand([command('memory-insights')])).toBe(true);
    expect(observedHermesMemoryCommand([command('/memory-insights')])).toBe(false);
    expect(observedHermesMemoryCommand([command('memory-search')])).toBe(false);
  });

  test('keeps no session, probe failure, absence, and observation distinct', () => {
    expect(hermesMemoryRuntimeState({ commandsChecked: true, commandsFailed: false, hasActiveSession: false, signatureObserved: true })).toBe('no-session');
    expect(hermesMemoryRuntimeState({ commandsChecked: false, commandsFailed: false, hasActiveSession: true, signatureObserved: false })).toBe('loading');
    expect(hermesMemoryRuntimeState({ commandsChecked: false, commandsFailed: true, hasActiveSession: true, signatureObserved: false })).toBe('failure');
    expect(hermesMemoryRuntimeState({ commandsChecked: true, commandsFailed: false, hasActiveSession: true, signatureObserved: false })).toBe('not-observed');
    expect(hermesMemoryRuntimeState({ commandsChecked: true, commandsFailed: false, hasActiveSession: true, signatureObserved: true })).toBe('available');
  });
});
