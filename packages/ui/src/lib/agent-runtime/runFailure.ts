import type { RunFailure } from '@varin/protocol';
import type { I18nKey, useI18n } from '@/lib/i18n';

const keys = new Map<string, I18nKey>([
  ['context_candidate_capacity', 'harness.threads.failure.context_candidate_capacity'],
  ['context_capacity', 'harness.threads.failure.context_capacity'],
  ['context_background_disabled', 'harness.threads.failure.context_background_disabled'],
  ['context_compaction_failed', 'harness.threads.failure.context_compaction_failed'],
  ['context_policy_unavailable', 'harness.threads.failure.context_policy_unavailable'],
  ['context_preparation_failed', 'harness.threads.failure.context_preparation_failed'],
  ['execution_failed', 'harness.threads.failure.execution_failed'],
  ['tool_not_declared', 'harness.threads.failure.tool_not_declared'],
  ['unknown_tool_schema', 'harness.threads.failure.unknown_tool_schema'],
  ['stale_tool_schema', 'harness.threads.failure.stale_tool_schema'],
  ['invalid_tool_call', 'harness.threads.failure.invalid_tool_call'],
  ['invalid_tool_arguments', 'harness.threads.failure.invalid_tool_arguments'],
]);

export function runFailureMessage(failure: RunFailure, t: ReturnType<typeof useI18n>['t']): string {
  const key = keys.get(failure.code);
  if (!key) return failure.message;
  return [failure.toolName, t(key)].filter(Boolean).join(' · ');
}
