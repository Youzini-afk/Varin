import { formatMessageTime, type MessageTimeObservation, type MessageTimeSettings } from '@varin/protocol';

export function parseClientTime(value: unknown): MessageTimeObservation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('sentAt' in value) || typeof value.sentAt !== 'string'
    || !('timeZone' in value) || typeof value.timeZone !== 'string') throw new Error('Invalid message time observation');
  return { sentAt: value.sentAt, timeZone: value.timeZone };
}

export function messageSentTime(settings: MessageTimeSettings, observation?: MessageTimeObservation): string | undefined {
  if (!settings.enabled) return undefined;
  // API callers without a sending-device observation use UTC, independently of execution placement.
  return formatMessageTime(observation?.sentAt ?? Date.now(), settings.timeZone ?? observation?.timeZone ?? 'UTC');
}
