import { describe, expect, test } from 'vitest';
import type { PiCommandDescriptor } from '@varin/protocol';
import { buildRtkCommand, rtkCommandObserved, rtkRuntimeState } from './rtk-runtime';

const command = (name: string): PiCommandDescriptor => ({
  name,
  source: 'extension',
  sourceInfo: { origin: 'top-level', path: name, scope: 'user', source: name },
});

describe('RTK optimizer runtime command adapter', () => {
  test('uses only the exact registered rtk command as extension-loaded evidence', () => {
    expect(rtkCommandObserved([command('rtk')])).toBe(true);
    expect(rtkCommandObserved([command('/rtk')])).toBe(false);
    expect(rtkCommandObserved([command('rtk-status')])).toBe(false);
  });

  test('builds only current native informational and metrics actions', () => {
    expect(buildRtkCommand('show')).toBe('/rtk show');
    expect(buildRtkCommand('verify')).toBe('/rtk verify');
    expect(buildRtkCommand('stats')).toBe('/rtk stats');
    expect(buildRtkCommand('clear-stats')).toBe('/rtk clear-stats');
  });

  test('distinguishes session, loading, failure, absence, and command presence', () => {
    expect(rtkRuntimeState({ hasActiveSession: false, commandsChecked: true, commandsFailed: false, commandObserved: true })).toBe('no-session');
    expect(rtkRuntimeState({ hasActiveSession: true, commandsChecked: false, commandsFailed: false, commandObserved: false })).toBe('loading');
    expect(rtkRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: true, commandObserved: false })).toBe('failure');
    expect(rtkRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: false, commandObserved: false })).toBe('not-observed');
    expect(rtkRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: false, commandObserved: true })).toBe('available');
  });
});
