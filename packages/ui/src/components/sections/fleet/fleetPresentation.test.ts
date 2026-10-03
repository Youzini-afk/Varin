import { describe, expect, test } from 'vitest';
import type { PiFleetEntry } from '@varin/protocol';
import {
  entryAdvertisesAction,
  filterFleetEntries,
  findFleetEntry,
  fleetEntryIdentity,
  fleetProviderTone,
  formatFleetDuration,
  providerAdvertisesAction,
  runningFleetEntries,
} from './fleetPresentation';

const entry = (overrides: Partial<PiFleetEntry> = {}): PiFleetEntry => ({
  actions: [{ action: 'logs', scope: 'entry' }],
  key: 'task-1',
  kind: 'background-task',
  name: 'Build',
  providerId: 'pi-background-tasks',
  startedAt: 1_000,
  state: 'running',
  ...overrides,
});

describe('Fleet presentation', () => {
  test('formats elapsed time without showing negative durations', () => {
    expect(formatFleetDuration(10_000, 9_000)).toBe('0s');
    expect(formatFleetDuration(0, 59_999)).toBe('59s');
    expect(formatFleetDuration(0, 65_000)).toBe('1m 05s');
    expect(formatFleetDuration(0, 3_725_000)).toBe('1h 02m');
  });

  test('maps provider health to stable visual tones', () => {
    expect(fleetProviderTone('active')).toBe('success');
    expect(fleetProviderTone('degraded')).toBe('warning');
    expect(fleetProviderTone('incompatible')).toBe('error');
    expect(fleetProviderTone('unavailable')).toBe('muted');
  });

  test('filters work by provider, kind, state, and search without reading plugin wire', () => {
    const entries = [
      entry({ key: 'a', name: 'Reviewer', kind: 'delegated-agent', providerId: 'pi-subagents', agent: 'reviewer' }),
      entry({ key: 'b', name: 'Compile', kind: 'background-task', state: 'completed', description: 'npm test' }),
      entry({ key: 'c', name: 'Historian', kind: 'background-agent', state: 'running' }),
    ];
    expect(filterFleetEntries(entries, {
      kind: 'background-task',
      providerId: 'all',
      query: '',
      state: 'all',
    }).map((item) => item.key)).toEqual(['b']);
    expect(filterFleetEntries(entries, {
      kind: 'all',
      providerId: 'pi-subagents',
      query: 'review',
      state: 'running',
    }).map((item) => item.key)).toEqual(['a']);
    expect(runningFleetEntries(entries).map((item) => item.key)).toEqual(['a', 'c']);
    expect(fleetEntryIdentity(entries[1]!)).toBe('pi-background-tasks:b');
    expect(findFleetEntry({
      entries,
      omitted: 0,
      providers: [],
      totalActive: 2,
    }, 'pi-background-tasks:b')?.name).toBe('Compile');
  });

  test('reads advertised actions from the Fleet DTO', () => {
    const selected = entry({
      actions: [
        { action: 'logs', scope: 'entry' },
        { action: 'kill', destructive: true, scope: 'entry' },
      ],
    });
    expect(entryAdvertisesAction(selected, 'kill')).toBe(true);
    expect(providerAdvertisesAction({
      actions: [{ action: 'run', scope: 'provider' }],
      id: 'pi-background-tasks',
      label: 'pi-background-tasks',
      state: 'active',
    }, 'run')).toBe(true);
  });
});
