import { DateTime, type Zone } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import type { ScheduledTaskSchedule } from '../projects/project-config.js';

// Existing Pi scheduling preserves its five-second admission slack. Native calendar
// calculations choose exact instants; neither pure function owns a timer or a queue.
const TASK_DUE_SLACK_MS = 5_000;

const parseTimeParts = (time: unknown): { hour: number; minute: number } | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === 'string' ? time : '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime: DateTime, time: unknown): DateTime | null => {
  const parsed = parseTimeParts(time);
  if (!parsed) {
    return null;
  }
  return baseDateTime.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
};

const resolveScheduleTimes = (schedule: ScheduledTaskSchedule): string[] => {
  const times: string[] = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (typeof candidate === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && typeof schedule?.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

export const computeOnceDueAt = (
  schedule: Partial<ScheduledTaskSchedule> | undefined,
  zone: string | Zone,
): number | null => {
  if (!schedule || typeof schedule.date !== 'string' || typeof schedule.time !== 'string') {
    return null;
  }
  const parsed = DateTime.fromFormat(
    `${schedule.date} ${schedule.time}`,
    'yyyy-LL-dd HH:mm',
    { zone },
  );
  return parsed.isValid ? parsed.toMillis() : null;
};

const weekdayAsZeroBased = (dateTime: DateTime): number | null => {
  if (!dateTime || typeof dateTime.weekday !== 'number') {
    return null;
  }
  return dateTime.weekday % 7;
};

export const computeNextRunAt = (task: {
  enabled?: boolean;
  schedule?: Partial<ScheduledTaskSchedule>;
} | null | undefined, nowMs = Date.now()): number | null => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const zone = typeof schedule.timezone === 'string' && schedule.timezone.trim().length > 0
    ? schedule.timezone.trim()
    : DateTime.local().zoneName;

  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) {
    return null;
  }

  if (schedule.kind === 'daily') {
    const times = resolveScheduleTimes(schedule as ScheduledTaskSchedule);
    if (times.length === 0) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (const time of times) {
      const candidateToday = applyTimeToDate(now, time);
      if (!candidateToday || !candidateToday.isValid) {
        continue;
      }
      if (candidateToday > minAllowed) {
        return candidateToday.toMillis();
      }
    }

    const tomorrow = now.plus({ days: 1 });
    const firstTomorrow = applyTimeToDate(tomorrow, times[0]);
    return firstTomorrow?.isValid ? firstTomorrow.toMillis() : null;
  }

  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      return null;
    }
    const times = resolveScheduleTimes(schedule as ScheduledTaskSchedule);
    if (times.length === 0) {
      return null;
    }
    const weekdaysSet = new Set(schedule.weekdays);
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const dayCandidate = now.plus({ days: dayOffset });
      const zeroBasedWeekday = weekdayAsZeroBased(dayCandidate);
      if (zeroBasedWeekday === null || !weekdaysSet.has(zeroBasedWeekday)) {
        continue;
      }
      for (const time of times) {
        const withTime = applyTimeToDate(dayCandidate, time);
        if (!withTime || !withTime.isValid) {
          continue;
        }
        if (withTime > minAllowed) {
          return withTime.toMillis();
        }
      }
    }
    return null;
  }

  if (schedule.kind === 'once') {
    const dueAt = computeOnceDueAt(schedule as ScheduledTaskSchedule, zone);
    if (dueAt === null) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });
    return dueAt > minAllowed.toMillis() ? dueAt : null;
  }

  if (schedule.kind === 'cron') {
    if (typeof schedule.cron !== 'string' || !schedule.cron) return null;
    try {
      const iterator = CronExpressionParser.parse(schedule.cron, {
        tz: zone,
        currentDate: new Date(nowMs),
      });
      return iterator.next().getTime();
    } catch {
      // Missing project metadata makes the task temporarily unrunnable.
      return null;
    }
  }

  return null;
};

export const isMissedRecurringSlot = (
  task: { schedule: ScheduledTaskSchedule },
  scheduledFor: number,
  wokeAt: number,
): boolean => {
  if (task.schedule.kind === 'once') return false;
  const followingOccurrence = computeNextRunAt({
    enabled: true,
    schedule: task.schedule,
  }, scheduledFor);
  return followingOccurrence !== null && wokeAt > followingOccurrence;
};


/** Calendar arithmetic is pure. Catalog chooses missed-slot policy, advances its cursor and
 * owns the deadline. An unavailable/invalid rule is an error, never a successful empty schedule. */
export function calculateCalendarSlots(request: import('@varin/protocol').CalendarCalculation): import('@varin/protocol').CalendarCalculationResult {
  const { rule, timezone, after_ms: after, now_ms: now } = request;
  const current = DateTime.fromMillis(now, { zone: timezone });
  if (!current.isValid || !Number.isSafeInteger(after) || !Number.isSafeInteger(now)) throw new Error('calendar_clock_or_timezone_invalid');
  // The native absolute timer stores nanoseconds in signed i64. Reject an
  // unrepresentable rule explicitly rather than strand every other definition.
  const deadline = (at: number): number => {
    if (!Number.isSafeInteger(at) || at < 0 || at > 9_223_372_036_854) throw new Error('calendar_deadline_out_of_range');
    return at;
  };
  if (rule.kind === 'once') {
    const at = computeOnceDueAt(rule, timezone);
    if (at === null) throw new Error('calendar_once_invalid');
    // Once means one actual instant. Resolve an ambiguous wall time to its first
    // UTC occurrence, independent of Luxon's ambient offset/cache at calculation.
    const first = Math.min(...DateTime.fromMillis(at, { zone: timezone }).getPossibleOffsets().map(value => value.toMillis()));
    const slot = { at_ms: deadline(first), following_at_ms: null };
    return { next: slot, latest_due: first <= now ? slot : null, next_future: first > now ? slot : null };
  }
  const actual = (pivot: number, direction: 1 | -1): number => {
    if (rule.kind === 'cron') {
      // prev is exclusive too. One millisecond makes the requested latest slot inclusive
      // without inventing a grace window or replacing an occurrence by the wake time.
      const iterator = CronExpressionParser.parse(rule.expression, { tz: timezone, currentDate: new Date(direction === 1 ? pivot : pivot + 1), hashSeed: JSON.stringify([request.definition_id, request.generation]) });
      return (direction === 1 ? iterator.next() : iterator.prev()).getTime();
    }
    if (rule.times.length === 0 || rule.times.some(time => !parseTimeParts(time))) throw new Error('calendar_times_invalid');
    if (rule.kind === 'weekly' && (rule.weekdays.length === 0 || rule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('calendar_weekdays_invalid');
    const origin = DateTime.fromMillis(pivot, { zone: timezone }).startOf('day');
    // Daily/weekly rules repeat within one local week. This bound comes from their rule,
    // rather than an arbitrary catch-up window or a loop over all missed occurrences.
    for (let day = 0; day <= 7; day++) {
      const date = origin.plus({ days: direction * day });
      if (rule.kind === 'weekly' && !rule.weekdays.includes(date.weekday % 7)) continue;
      const candidates = [...new Set(rule.times.flatMap(time => {
        const local = applyTimeToDate(date, time);
        if (!local?.isValid) throw new Error('calendar_local_time_invalid');
        // An ambiguous wall time has two actual UTC occurrences. The durable key uses
        // each real instant, so a backward clock jump cannot collapse or replay them.
        return local.getPossibleOffsets().map(value => value.toMillis());
      }))].filter(at => direction === 1 ? at > pivot : at <= pivot).sort((a, b) => direction * (a - b));
      if (candidates.length) return candidates[0]!;
    }
    throw new Error('calendar_next_slot_unavailable');
  };
  const slot = (at: number): import('@varin/protocol').CalendarSlot => ({ at_ms: deadline(at), following_at_ms: deadline(actual(at, 1)) });
  const latest = actual(now, -1);
  return { next: slot(actual(after, 1)), latest_due: latest > after ? slot(latest) : null,
    next_future: slot(actual(Math.max(now, after), 1)) };
}
