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
  if (item.pending_events > 0 && item.timing.kind === 'passive') return t('arrangements.passive');
  if (item.pending_events > 0 || item.pending_occurrences > 0 || item.wait?.state === 'observed') return t('followups.queued');
  if (item.exhausted && item.observation?.delivery_pending) return t('followups.observationDelivery');
  if (item.repeat === 'each') return t('followups.observing');
  return t('followups.waiting');
}

export function followupTrigger(item: Followup, t: Translate): string {
  const trigger = item.trigger;
  if (trigger.kind === 'plugin_event') return item.name ?? `${trigger.source.extensionId} · ${trigger.source.sourceId}`;
  if (trigger.kind === 'at') return new Date(trigger.at_ms).toLocaleString();
  if (trigger.kind === 'file') return `${t(`followups.file.${trigger.condition}`)} · ${trigger.path}`;
  return t(`followups.trigger.${trigger.kind}`);
}

/** Preserve unknown adapter messages; translate only documented Host hold codes. */
export function externalFollowupHold(code: string, t: Translate): string {
  const known: Record<string, I18nKey> = {
    external_target_missing: 'arrangements.externalMissing', external_target_deleted: 'arrangements.externalDeleted', external_target_archived: 'arrangements.externalArchived',
    external_session_needs_review: 'arrangements.externalReview', external_configuration_missing: 'arrangements.externalConfigurationMissing', external_agent_disabled: 'arrangements.externalDisabled',
    external_harness_changed: 'arrangements.externalReview', external_configuration_changed: 'arrangements.externalReview', external_target_owner_changed: 'arrangements.externalOwnerChanged',
    arrangement_paused: 'followups.paused', bot_suspended: 'followups.hold.bot_suspended',
  };
  return known[code] ? t(known[code]) : code;
}

export function externalFollowupState(state: string, t: Translate): string {
  return ['queued', 'awaiting_input', 'preparing', 'running', 'waiting_user', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'].includes(state)
    ? t(`external.status.${state}` as I18nKey) : state;
}
