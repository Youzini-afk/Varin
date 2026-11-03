import { parseVarinAgentDriverDescription, VARIN_AGENT_DRIVER_SERVICE_ID, VARIN_AGENT_DRIVER_VERSION } from '@varin/extension-contract';
import type { ExtensionsAPI } from '@varin/application-client';

/** Inspect the actual selected generation, not a claim copied from a manifest. Caller retains
 * endpoint identity across awaits; describe cannot silently resolve to a different provider. */
export async function readAgentDriverDescription(api: ExtensionsAPI, input: {
  extensionId: string; providerKey: string; hostId: string;
  assertCurrent(): void; signal: AbortSignal;
}) {
  const state = async () => {
    input.assertCurrent(); input.signal.throwIfAborted();
    const snapshot = await api.hostState();
    input.assertCurrent(); input.signal.throwIfAborted();
    if (!snapshot.catalog.authoritative || snapshot.catalog.hostId !== input.hostId) throw new Error('Driver inspection Host changed');
    return snapshot;
  };
  let snapshot = await state();
  let provider = snapshot.services.providers.find(candidate => candidate.providerKey === input.providerKey && candidate.status === 'active');
  if (!provider) {
    input.assertCurrent(); input.signal.throwIfAborted();
    await api.activateExtension(input.extensionId);
    snapshot = await state();
    provider = snapshot.services.providers.find(candidate => candidate.providerKey === input.providerKey && candidate.status === 'active');
  }
  if (!provider) throw new Error('Selected driver has no active implementation');
  input.assertCurrent(); input.signal.throwIfAborted();
  const description = await api.invokeService({ serviceId: VARIN_AGENT_DRIVER_SERVICE_ID,
    version: VARIN_AGENT_DRIVER_VERSION, method: 'describe', args: [], providerId: provider.providerId }, input.signal);
  input.assertCurrent(); input.signal.throwIfAborted();
  return parseVarinAgentDriverDescription(description);
}
