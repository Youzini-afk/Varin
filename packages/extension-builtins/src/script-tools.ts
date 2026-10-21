import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';
export const VARIN_BUILTIN_SCRIPT_EXTENSION_ID = 'varin.builtin.scripts';
export const SCRIPT_CAPABILITY = 'scripts.execute';
const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const identity = { type: 'string', minLength: 1 };
const declaration = (method: string, description: string, inputSchema: JsonObject, environment = false): VarinExtensionServiceProvision => ({
  id: `varin.script.${method}`, version: 1,
  tool: { name: `script_${method}`, description, inputSchema, outputSchema: { type: 'object' }, operation: 'effect',
    requirements: { source: 'physical', process: true }, completion: environment ? 'job' : 'result',
    ...(environment ? { lifetime: 'environment' as const } : {}) },
});
/** The installed ordinary services and actual Host domain consume these same declarations. */
export const SCRIPT_TOOL_DECLARATIONS = [
  declaration('open', 'Open an explicit persistent Node JavaScript environment on this Run’s selected physical source. Returns environmentId. It is unrestricted code execution with direct file/process/network effects, not an OS sandbox. The live environment remains a potential source writer between cells. Close it explicitly; this Run ending also closes it. Bindings survive cells, never a Host/helper restart or another Run.', schema({ cwd: { type: 'string' } }), true),
  declaration('run', 'Evaluate full async JavaScript in this Run’s existing environmentId. Supply a concise title describing this cell’s task in the user’s language (for example, inspect directory exclusions). Describe the intended action, not a claimed success. Lexical bindings persist. print and console append ordered text parts. emitImage({media_type,data_base64}) explicitly appends an image part. tools.invoke({callId,name,arguments}) calls the original selected tools with independent permissions and receipts; result completion.content has opaque data and ordered parts. Read nested data through completion.content.data and selectively forward a media part with emitImage(part.media). Nested images are not automatically published. A completed cell does not stop the environment or prove all external effects. Cancellation or an explicit timeout closes the environment. Never replay unknown cells.', schema({ environmentId: identity, title: { type: 'string', description: 'Brief user-facing task label for this script cell.' }, script: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 0 } }, ['environmentId', 'script'])),
  declaration('close', 'Close this Run’s exact script environment. Fence new cells, stop its original process tree, and drain already accepted callbacks. Independent tools.invoke process Jobs keep their own lifetime. Unknown cleanup remains explicit; open a fresh environmentId rather than replaying old cells.', schema({ environmentId: identity }, ['environmentId'])),
] as const;
