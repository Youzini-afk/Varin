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

});
