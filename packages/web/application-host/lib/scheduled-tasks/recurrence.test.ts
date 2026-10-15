import { Settings } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { CalendarCalculation } from '@varin/protocol';
import { calculateCalendarSlots } from './recurrence.js';
const request = (rule: CalendarCalculation['rule'], timezone: string, after: string, now: string): CalendarCalculation => ({
  definition_id: 'calendar:actual', generation: 1, revision: 1, owner_epoch: 1, rule, timezone,
  after_ms: Date.parse(after), now_ms: Date.parse(now),
});
describe('calendar arithmetic supplied to the original native occurrence owner', () => {
  it('returns actual adjacent slots and coalescing candidates without iterating missed runs', () => {
    const value = calculateCalendarSlots(request({ kind: 'cron', expression: '0 * * * *' }, 'UTC', '2021-01-01T00:00:00Z', '2026-10-10T12:34:56Z'));
    expect(value.next?.at_ms).toBe(Date.parse('2021-01-01T01:00:00Z'));
    expect(value.latest_due).toEqual({ at_ms: Date.parse('2026-10-10T12:00:00Z'), following_at_ms: Date.parse('2026-10-10T13:00:00Z') });
    expect(value.next_future?.at_ms).toBe(value.latest_due?.following_at_ms);
    const backwards = calculateCalendarSlots(request({ kind: 'daily', times: ['09:00'] }, 'UTC', '2026-10-11T12:00:00Z', '2026-10-10T12:00:00Z'));
    expect(backwards.latest_due).toBeNull(); expect(backwards.next_future?.at_ms).toBe(Date.parse('2026-10-12T09:00:00Z'));
  });
  it('keeps an overdue once identity and does not discard a slot five seconds away', () => {
    const once = calculateCalendarSlots(request({ kind: 'once', date: '2026-01-01', time: '09:00' }, 'UTC', '2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z'));
    expect(once.next).toEqual({ at_ms: Date.parse('2026-01-01T09:00:00Z'), following_at_ms: null });
    expect(once.latest_due).toEqual(once.next); expect(once.next_future).toBeNull();
    const near = calculateCalendarSlots(request({ kind: 'daily', times: ['09:00'] }, 'UTC', '2026-10-10T08:59:58Z', '2026-10-10T08:59:58Z'));
    expect(near.next?.at_ms).toBe(Date.parse('2026-10-10T09:00:00Z'));
  });
  it('uses distinct actual UTC instants through the daylight-saving fold and validates unavailable rules', () => {
    const originalNow = Settings.now;
    try {
      for (const ambient of ['2026-07-01T00:00:00Z', '2026-12-01T00:00:00Z']) {
        Settings.now = () => Date.parse(ambient); Settings.resetCaches();
        expect(calculateCalendarSlots(request({ kind: 'once', date: '2026-11-01', time: '01:30' }, 'America/New_York', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')).next?.at_ms).toBe(Date.parse('2026-11-01T05:30:00Z'));
      }
    } finally { Settings.now = originalNow; Settings.resetCaches(); }
    const first = calculateCalendarSlots(request({ kind: 'daily', times: ['01:30'] }, 'America/New_York', '2026-11-01T04:00:00Z', '2026-11-01T04:00:00Z'));
    expect(first.next).toEqual({ at_ms: Date.parse('2026-11-01T05:30:00Z'), following_at_ms: Date.parse('2026-11-01T06:30:00Z') });
    const second = calculateCalendarSlots(request({ kind: 'daily', times: ['01:30'] }, 'America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'));
    expect(second.latest_due?.at_ms).toBe(Date.parse('2026-11-01T06:30:00Z'));
    expect(second.next_future?.at_ms).toBe(Date.parse('2026-11-02T06:30:00Z'));
    expect(() => calculateCalendarSlots(request({ kind: 'once', date: '9999-01-01', time: '09:00' }, 'UTC', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'))).toThrow('calendar_deadline_out_of_range');
    expect(() => calculateCalendarSlots(request({ kind: 'daily', times: ['09:00'] }, 'not/a-zone', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'))).toThrow();
  });
});
