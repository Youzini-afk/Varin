/** The Catalog owns admission; an exact readback is the only recovery for an uncertain commit ACK. */
import { isDeepStrictEqual } from 'node:util';
import type { KernelClient } from './kernel-client.js';
import type { McpToolLease } from './tool-bridge.js';
import type { LaunchIntent, McpBinding } from './protocol.generated.js';

export async function commitPreparedMcpBinding(kernel: KernelClient, runId: string, lease: McpToolLease,
  readLaunch: () => Promise<LaunchIntent | null>, signal: AbortSignal): Promise<McpBinding> {
  signal.throwIfAborted();
  try {
    await kernel.agentRuntimeRequest('runtime.launch.mcp.prepare',
      { runId, binding: lease.binding, ...(lease.derivations?.length ? { derivations: lease.derivations } : {}) }, signal);
  } catch (error) {
    // A one-time child transition may have committed before its ACK was lost. Read
    // without the cancelled preparation signal; this cannot authorize a new effect.
    const committed = await readLaunch().catch(() => null);
    if (!committed || !isDeepStrictEqual(committed.selection.mcp_binding, lease.binding)) throw error;
  }
  signal.throwIfAborted();
  const binding = await kernel.registerMcpOwner(runId, lease);
  // Proof release is durable cleanup, not admission of a second candidate. An
  // uncertain ACK must not destroy the only committed live view. The original
  // child discovery/terminal duty retries this same Source/execution cleanup.
  void Promise.resolve().then(() => lease.releaseDerivations?.()).catch(() => undefined);
  return binding;
}
