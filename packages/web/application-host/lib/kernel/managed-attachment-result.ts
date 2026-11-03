import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LaunchSource } from './protocol.generated.js';
import type { ManagedSourceBinding } from '../harness/managed-remote-types.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import { resourceThreadSource } from './thread-context.js';

/** Result authority can read the original immutable records after execution has
 * stopped. It never reopens file/process execution or reselects a working root. */
export async function withManagedAttachmentResult<T>(runtime: AgentRuntimeClient,
  scope: { threadId: string; runId: string; epoch: number; source: LaunchSource }, operationId: string,
  consume: (access: { client: ManagedSourceClient; binding: ManagedSourceBinding }) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (scope.source.resource_owner.kind !== 'managed_host') throw new Error('The original attachment has no managed owner');
  const client = await runtime.managedSource(scope.source.resource_owner, signal);
  // Binding admission must drain even when its caller has stopped observing.
  const binding = await client.bind({ coordinatorHostId: runtime.coordinatorHostId,
    scope: { kind: 'run', threadId: scope.threadId, runId: scope.runId, epoch: scope.epoch },
    source: resourceThreadSource(scope.source)!, purpose: 'result', retention: 'caller', operationId, deferMaterialization: true });
  const address = { coordinatorHostId: runtime.coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    signal?.throwIfAborted();
    if (!isDeepStrictEqual(binding.source, scope.source)) throw new Error('The original attachment Source changed');
    outcome = { ok: true, value: await consume({ client, binding }) };
  } catch (error) { outcome = { ok: false, error }; }
  const result = await client.release({ ...address, mode: 'retire' }) as { phase?: string };
  if (result.phase !== 'retired' && result.phase !== 'revoked') throw new Error('The attachment result reader has not stopped');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
