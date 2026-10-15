import type { WorkspaceCombinedRecoveryPlan } from '@varin/extension-contract';
import type { RecoveryPreference } from '@varin/protocol';

export const shouldOpenRecoveryDialog = (
  preference: RecoveryPreference,
  plan: WorkspaceCombinedRecoveryPlan,
): boolean => (
  preference === 'ask'
  || plan.coverage !== 'ready'
  || plan.conflicts.length > 0
);
