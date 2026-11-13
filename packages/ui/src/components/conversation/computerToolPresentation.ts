import type { I18nKey, useI18n } from '@/lib/i18n';
import { toolRecord, toolText } from './toolInvocation';

type Translate = ReturnType<typeof useI18n>['t'];
const propertyLabels = {
  name: 'chat.tools.computer.property.name', role: 'chat.tools.computer.property.role', value: 'chat.tools.computer.property.value',
  enabled: 'chat.tools.computer.property.enabled', selected: 'chat.tools.computer.property.selected', checked: 'chat.tools.computer.property.checked',
  expanded: 'chat.tools.computer.property.expanded', actions: 'chat.tools.computer.property.actions',
} as const satisfies Record<string, I18nKey>;
const resultLabels: Record<string, I18nKey> = {
  satisfied: 'chat.tools.computer.satisfied', timed_out: 'chat.tools.computer.timedOut', cancelled: 'chat.tools.computer.cancelled',
  target_lost: 'chat.tools.computer.targetLost', unavailable: 'chat.tools.computer.unavailable',
};
const effectLabels: Record<string, I18nKey> = {
  none: 'chat.tools.computer.noInput', dispatched: 'chat.tools.computer.dispatched', verified: 'chat.tools.computer.verified',
  partial: 'chat.tools.computer.partial', unknown: 'chat.tools.computer.unknown',
};
export const computerPropertyLabel = (property: string, t: Translate) =>
  Object.hasOwn(propertyLabels, property) ? t(propertyLabels[property as keyof typeof propertyLabels]) : property;

/** Only returned properties become facts. Missing requested values stay unknown, never false. */
export function computerProperties(properties: unknown, unavailable: unknown, requested: unknown, t: Translate): { property: string; text: string }[] {
  const values = toolRecord(properties);
  const unavailableKeys = new Set(Array.isArray(unavailable) ? unavailable.filter((key): key is string => typeof key === 'string') : []);
  const keys = new Set([...Object.keys(values), ...unavailableKeys,
    ...(Array.isArray(requested) ? requested.filter((key): key is string => typeof key === 'string') : [])]);
  return [...keys].map(property => {
    const value = values[property];
    const text = unavailableKeys.has(property) ? t('chat.tools.computer.propertyUnavailable')
      : value === undefined || value === null ? t('chat.tools.computer.propertyUnknown')
        : value === true ? t('chat.tools.computer.true') : value === false ? t('chat.tools.computer.false')
          : property === 'checked' && value === 'mixed' ? t('chat.tools.computer.mixed')
            : Array.isArray(value) ? value.filter(item => typeof item === 'string').join(', ')
              : typeof value === 'string' ? value : t('chat.tools.computer.propertyUnknown');
    return { property, text: `${computerPropertyLabel(property, t)}: ${text}` };
  });
}

export function computerActionLabel(action: Record<string, unknown>, t: Translate): string {
  if (action.kind === 'set_checked') return t(action.checked === false ? 'chat.tools.computer.action.uncheck' : 'chat.tools.computer.action.check');
  if (action.kind === 'set_expanded') return t(action.expanded === false ? 'chat.tools.computer.action.collapse' : 'chat.tools.computer.action.expand');
  if (action.kind === 'select') return t(action.selection === 'remove' ? 'chat.tools.computer.action.removeSelection'
    : action.selection === 'add' ? 'chat.tools.computer.action.addSelection' : 'chat.tools.computer.action.select');
  if (action.kind === 'scroll_into_view') return t('chat.tools.computer.action.scrollIntoView');
  return '';
}

export function computerConditionLabel(condition: unknown, t: Translate): string {
  const labels: Record<string, I18nKey> = {
    present: 'chat.tools.computer.condition.present', absent: 'chat.tools.computer.condition.absent',
    property: 'chat.tools.computer.condition.property', changed: 'chat.tools.computer.condition.changed',
    window_opened: 'chat.tools.computer.condition.windowOpened', window_closed: 'chat.tools.computer.condition.windowClosed',
  };
  return typeof condition === 'string' && labels[condition] ? t(labels[condition]) : '';
}

/** Concise receipts shared by the full card and folded activity, not a second status authority. */
export function computerResultSummary(name: string, data: Record<string, unknown>, args: Record<string, unknown>, t: Translate): string {
  if (name === 'computer_await') return typeof data.status === 'string' && resultLabels[data.status] ? t(resultLabels[data.status]) : '';
  if (name === 'computer_query') {
    if (typeof data.status === 'string' && resultLabels[data.status]) return t(resultLabels[data.status]);
    if (data.properties !== undefined || Array.isArray(data.unavailableProperties))
      return computerProperties(data.properties, data.unavailableProperties, args.properties, t).map(item => item.text).join(' · ');
    const observation = toolRecord(data.observation);
    if (Array.isArray(observation.elements)) return t(data.complete !== true ? 'chat.tools.computer.returnedMatches'
      : data.nextOffset != null || typeof args.offset === 'number' && args.offset > 0 ? 'chat.tools.computer.matchPage'
        : 'chat.tools.computer.matches', { count: observation.elements.length });
  }
  if (name === 'computer_act') {
    const response = toolRecord(data.result), receipt = toolRecord(response.receipt), observed = toolRecord(receipt.observedState);
    const action = toolRecord(args.action), effect = toolText(receipt.effect) || toolText(response.outcome) || (response.accepted === true ? 'dispatched' : '');
    if (!effectLabels[effect]) return '';
    const alreadySet = effect === 'none' && (
      action.kind === 'set_checked' && typeof action.checked === 'boolean' && observed.checked === action.checked
      || action.kind === 'set_expanded' && typeof action.expanded === 'boolean' && observed.expanded === action.expanded
      || action.kind === 'set_value' && typeof action.value === 'string' && observed.value === action.value
      || action.kind === 'select' && (action.selection === 'add' && observed.selected === true || action.selection === 'remove' && observed.selected === false));
    return [t(alreadySet ? 'chat.tools.computer.alreadySet' : effectLabels[effect]!),
      ...computerProperties(receipt.observedState, undefined, undefined, t).filter(item => item.property !== 'name' && item.property !== 'role').map(item => item.text)].join(' · ');
  }
  return '';
}
