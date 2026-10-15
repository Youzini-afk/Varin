import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';
export const VARIN_BUILTIN_ENVIRONMENT_FORWARD_EXTENSION_ID = 'varin.builtin.environment-forward';
export const ENVIRONMENT_FORWARD_CAPABILITY = 'environment.forward';
const text = { type: 'string', minLength: 1 };
const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const declaration = (method: string, operation: 'read' | 'effect', description: string, inputSchema: JsonObject, job = false): VarinExtensionServiceProvision => ({
  id: `varin.environment.${method}`, version: 1,
  tool: { name: `environment_${method}`, description, operation, inputSchema, outputSchema: { type: 'object' },
    completion: job ? 'job' : 'result', ...(job ? { lifetime: 'thread' as const } : {}) },
});
/** Ordinary tools retain the original Catalog authority, including child and nested calls. */
export const ENVIRONMENT_FORWARD_TOOL_DECLARATIONS = [
  declaration('forward', 'effect', 'Expose a service through this coordinating Host. target optionally selects an existing configured machine or connection; otherwise use this Run’s frozen source owner, or local when no source is selected. A local target returns its direct address without starting a forward. A remote target creates a Thread-lifetime Job with a loopback listener on this Host, not on an arbitrary desktop. Listener readiness does not prove the target service is reachable. Later configuration changes never redirect it.', schema({ target: text, host: text, port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['port']), true),
  declaration('forwards', 'read', 'List this task family’s accepted service-forward Jobs and original owner evidence. A disconnected or unknown owner is not a stopped service.', schema({})),
  declaration('forward_get', 'read', 'Inspect the original service-forward Job by operationId within the task family. Reconcile existing listener evidence; never create a replacement.', schema({ operationId: text }, ['operationId'])),
  declaration('forward_close', 'effect', 'Cancel a service-forward Job in this task’s subtree and drain its original listener and streams. This does not stop the remote service process. Unknown old-Host cleanup remains explicit.', schema({ operationId: text }, ['operationId'])),
  declaration('forward_wait', 'read', 'Wait for an original service-forward Job’s listener-stop receipt using Catalog’s durable observation. Cancelling this wait does not close the forward or stop its service.', schema({ operationId: text }, ['operationId']), true),
] as const;
