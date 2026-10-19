/** Sender observation, captured before a user message crosses the Host transport. */
export interface MessageTimeObservation {
  sentAt: string;
  timeZone: string;
}

export interface MessageTimeSettings {
  enabled: boolean;
  /** null follows the sending device; a named zone applies independently of the Host. */
  timeZone: string | null;
}

export function observeMessageTime(): MessageTimeObservation {
  return { sentAt: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}

/** One representation shared by the settings preview and the actual message context. */
export function formatMessageTime(sentAt: string | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(sentAt));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === name)!.value;
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset} [${timeZone}]`;
}
