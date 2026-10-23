import type { Followup } from '@varin/protocol';
import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

export const independentFollowup = (item: Followup) => item.actor?.kind !== 'goal';

/** Definition control and occurrence delivery have separate lifetimes. A once
 * definition may remain active after its wait has been consumed. */
export function isPastFollowup(item: Followup): boolean {
  return item.state === 'cancelled' || (item.exhausted && item.pending_occurrences === 0
    && !item.observation?.delivery_pending) || (item.repeat === 'once'
    && (item.wait?.state === 'consumed' || item.occurrence?.delivery?.state === 'delivered' || item.occurrence?.state === 'cancelled'));
}

export const pendingFollowup = (item: Followup) => independentFollowup(item) && !isPastFollowup(item);

export function followupStatus(item: Followup, t: Translate): string {
  if (item.state === 'cancelled' || item.repeat === 'once' && item.occurrence?.state === 'cancelled') return t('chat.followup.status.cancelled');
  if (item.repeat === 'once' && (item.wait?.state === 'consumed' || item.occurrence?.delivery?.state === 'delivered')) return t('followups.delivered');
  if (isPastFollowup(item)) return t('followups.ended');
  if (item.state === 'paused') return t('followups.paused');
  const hold = item.occurrence?.hold_reason;
  if (hold) return t(`followups.hold.${hold}`);
  if (item.pending_occurrences > 0 || item.wait?.state === 'observed') return t('followups.queued');
  if (item.exhausted && item.observation?.delivery_pending) return t('followups.observationDelivery');
  if (item.repeat === 'each') return t('followups.observing');
  return t('followups.waiting');
}

export function followupTrigger(item: Followup, t: Translate): string {
  const trigger = item.trigger;
  if (trigger.kind === 'at') return new Date(trigger.at_ms).toLocaleString();
  if (trigger.kind === 'file') return `${t(`followups.file.${trigger.condition}`)} · ${trigger.path}`;
  return t(`followups.trigger.${trigger.kind}`);
}
