import { VARIN_TOOL_CONFIRMATION_CAPABILITY, type JsonValue } from '@varin/extension-contract';
import type { VarinHostCapabilityClient } from './index.js';

/** Consume the original tool's exact one-action confirmation immediately before dispatch.
 * Use invocation capabilities, never activation capabilities. Failure must not be retried.
 * This is not a permission prompt and cannot approve a direct service call.
 */
export async function confirmToolEffect(client: VarinHostCapabilityClient, input: JsonValue): Promise<void> {
  await client.call(VARIN_TOOL_CONFIRMATION_CAPABILITY, 'consume', input);
}
