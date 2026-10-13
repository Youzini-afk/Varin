/** Publish one original reverse request; this never invokes an SDK responder or model. */
import { isDeepStrictEqual } from 'node:util';
import type { KernelClient } from './kernel-client.js';
import type { McpInteractionOpenParams, McpInteractionRecord, McpInteractionView } from './protocol.generated.js';

export const isDefiniteMcpPublicationFailure = (error: unknown): boolean => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return ['operation-error', 'protocol-error', 'cancelled', 'unauthorized', 'mcp_interaction_conflict'].includes(String(code));
};
export async function publishMcpInteractionRequest(input: McpInteractionOpenParams, options: {
  kernel: Pick<KernelClient, 'agentRuntimeRequest'>;
  disposed(): boolean;
  waitRetry(delay: number): Promise<void>;
  report(error: unknown): void;
}): Promise<McpInteractionRecord> {
  // Keep the exact admitted body across transport/storage retries.
  const original = structuredClone(input);
  let delay = 250;
  while (!options.disposed()) {
    try {
      return await options.kernel.agentRuntimeRequest<McpInteractionRecord, 'runtime.mcp.interaction.open'>(
        'runtime.mcp.interaction.open', original);
    } catch (error) {
      let view: McpInteractionView | undefined;
      try {
        view = await options.kernel.agentRuntimeRequest<McpInteractionView, 'runtime.mcp.interaction.read'>(
          'runtime.mcp.interaction.read', { operationId: original.binding.operationId, interactionId: original.id });
      } catch { /* Absence or uncertainty is not a successful publication. */ }
      if (view) {
        if (view.record.id !== original.id || !isDeepStrictEqual(view.record.binding, original.binding)
          || !isDeepStrictEqual(view.request, original.request) || !isDeepStrictEqual(view.presentation, original.presentation))
          throw Object.assign(new Error('mcp_interaction_conflict'), { code: 'mcp_interaction_conflict' });
        return view.record;
      }
      if (isDefiniteMcpPublicationFailure(error)) throw error;
      options.report(error);
      await options.waitRetry(delay); delay = Math.min(delay * 2, 30_000);
    }
  }
  throw Object.assign(new Error('mcp_interaction_owner_unavailable'), { code: 'mcp_interaction_owner_unavailable' });
}
