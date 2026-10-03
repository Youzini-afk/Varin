import { describe, expect, test } from 'vitest';
import type { PiCommandDescriptor } from '@varin/protocol';
import {
  buildPiLensRuntimeCommand,
  observedPiLensRuntimeCommands,
  piLensRuntimeState,
} from './pi-lens-runtime';

const command = (name: string): PiCommandDescriptor => ({
  name,
  source: 'extension',
  sourceInfo: { origin: 'top-level', path: name, scope: 'user', source: name },
});

describe('pi-lens runtime command adapter', () => {
  test('keeps only commands observed by command.list', () => {
    expect(observedPiLensRuntimeCommands([
      command('/lens-health'),
      command('lens-map'),
      command('websearch'),
    ])).toEqual(new Set(['lens-health', 'lens-map']));
  });

  test('dispatches the native slash command without fabricating a result', () => {
    expect(buildPiLensRuntimeCommand('lens-health')).toBe('/lens-health');
  });

  test('distinguishes session, loading, failure, and not-observed states', () => {
    expect(piLensRuntimeState({ hasActiveSession: false, commandsChecked: false, commandsFailed: false, commandNames: new Set() })).toBe('no-session');
    expect(piLensRuntimeState({ hasActiveSession: true, commandsChecked: false, commandsFailed: false, commandNames: new Set() })).toBe('loading');
    expect(piLensRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: true, commandNames: new Set() })).toBe('failure');
    expect(piLensRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: false, commandNames: new Set() })).toBe('not-observed');
  });
});
