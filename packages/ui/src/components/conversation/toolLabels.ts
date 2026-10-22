import type { I18nKey, useI18n } from '@/lib/i18n';

export const workToolLabels: Record<string, I18nKey> = {
  todo: 'chat.tools.plan', memory: 'chat.tools.memory', goal_report: 'chat.tools.goal', follow_up: 'chat.tools.followup',
  settings_read: 'chat.tools.settings', settings_search: 'chat.tools.settings', settings_update: 'chat.tools.settings', settings_action: 'chat.tools.settings',
  threads: 'chat.tools.readThreads', read_thread: 'chat.tools.readThreads', child_status: 'chat.tools.childStatus',
  child_report: 'chat.tools.childReport', wait_child: 'chat.tools.childWait', child_cancel: 'chat.tools.childCancel',
  agent_rename: 'chat.tools.rename', submit_code: 'chat.tools.submitCode', update: 'chat.tools.updateCode',
  ask_user: 'chat.tools.question', question_status: 'chat.tools.question', tool_describe: 'chat.tools.capabilities', resource_read: 'chat.tools.resource',
};

const states: Record<string, I18nKey> = {
  ready: 'chat.tools.state.ready', applied: 'chat.tools.state.applied', partial: 'chat.tools.state.partial',
  failed: 'chat.timeline.tools.error', cancelled: 'chat.timeline.tools.cancelled', unknown: 'chat.timeline.tools.unknown',
  pending: 'chat.tools.state.pending', in_progress: 'chat.timeline.tools.running', running: 'chat.timeline.tools.running',
  starting: 'harness.threads.state.starting', completed: 'chat.timeline.tools.success', succeeded: 'chat.timeline.tools.success',
  exited: 'chat.tools.state.exited', released: 'chat.tools.state.released', blocked: 'chat.tools.state.blocked',
  unavailable: 'chat.tools.state.unavailable', missing: 'chat.tools.state.missing', stale: 'chat.tools.state.stale',
  global: 'chat.tools.scope.global', project: 'chat.tools.scope.project', thread: 'chat.tools.scope.thread', currentThread: 'chat.tools.scope.thread',
  immediate: 'chat.tools.effect.immediate', 'next-run': 'chat.tools.effect.nextRun', restart: 'chat.tools.effect.restart', manual: 'chat.tools.effect.manual',
};
export const toolValueLabel = (value: unknown, t: ReturnType<typeof useI18n>['t']): string =>
  typeof value === 'string' ? states[value] ? t(states[value]) : value : '';
