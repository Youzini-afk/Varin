import { isDeepStrictEqual } from 'node:util';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedScriptControlReceipt, ManagedScriptControlRequest } from '../harness/managed-remote-types.js';

/** Only the original Catalog operation supplies this address. Recovery stops/observes;
 * it never opens another evaluator or replays a cell from retained process output. */
export async function controlManagedScript(client: ManagedSourceClient, input: ManagedScriptControlRequest): Promise<ManagedScriptControlReceipt> {
  const receipt = await client.scriptControl(input);
  if (receipt.processId !== input.processId || receipt.runId !== input.runId || receipt.threadId !== input.threadId
    || !isDeepStrictEqual(receipt.source, input.source) || typeof receipt.accepted !== 'boolean' || typeof receipt.executorStopped !== 'boolean'
    || receipt.process && (receipt.process.processId !== input.processId || receipt.process.workspaceId !== input.source.workspace_id || receipt.process.mode !== 'pipe')
    || receipt.executorStopped && (!receipt.accepted || !receipt.process || receipt.process.writerActive !== false || receipt.process.treeConfirmed !== true))
    throw new Error('Original managed script process receipt changed');
  return receipt;
}

/** Follow an accepted original guardian until its tree receipt is available. Revoking
 * a pipe subscription only stops observation; it is not physical-stop evidence. A
 * transport failure rejects this attempt, leaving Catalog's original receipt pending. */
export async function stopManagedScript(client: ManagedSourceClient, input: Omit<ManagedScriptControlRequest, 'stop'>): Promise<ManagedScriptControlReceipt> {
  let receipt = await controlManagedScript(client, { ...input, stop: true });
  while (receipt.accepted && !receipt.executorStopped) {
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    receipt = await controlManagedScript(client, { ...input, stop: false });
  }
  return receipt;
}
