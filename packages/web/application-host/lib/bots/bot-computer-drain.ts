import { computerExecutionKey, type ComputerExecutionRef } from '@varin/protocol';
import { ComputerError } from '../computer/computer-error.js';
import type { ComputerService } from '../computer/computer-service.js';

/** The Bot owner supplies its original current and historical Run identities.
 * Shared desktops stay running; only these executions release their resources. */
export async function drainBotComputerExecutions(
  computers: Pick<ComputerService, 'finishExecution'>,
  executions: readonly ComputerExecutionRef[],
): Promise<void> {
  const original = [...new Map(executions.map(execution => [computerExecutionKey(execution), execution])).values()];
  const settled = await Promise.allSettled(original.map(execution => computers.finishExecution(execution)));
  const failed = original.filter((_, index) => settled[index]!.status === 'rejected');
  if (failed.length) throw new ComputerError('computer-input-release-unconfirmed',
    `Bot Computer release is not confirmed for Run(s): ${failed.map(execution => execution.runId).join(', ')}. Retry Sleep after the original desktop owner can confirm release.`);
}
