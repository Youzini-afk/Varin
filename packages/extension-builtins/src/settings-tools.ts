import type { VarinExtensionServiceProvision } from '@varin/extension-contract';

export const SETTINGS_CAPABILITY = 'settings';
const scope = { type: 'string', enum: ['global', 'project'] };
const patch = { type: 'object', additionalProperties: false, required: ['id'], properties: {
  id: { type: 'string', minLength: 1 }, scope,
  set: { type: 'object' }, reset: { type: 'array', items: { type: 'string' } }, expectedRevision: { type: 'string' },
} };
export const SETTINGS_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [
  { id: 'varin.settings.search', version: 1, tool: { name: 'settings_search', operation: 'read', completion: 'result',
    description: 'Find native application settings by keyword, category or stable id. Current values and supported owner actions are discovered here; unavailable owners never imply empty configuration.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string' }, category: { type: 'string' }, owner: { type: 'string', enum: ['app', 'agent-settings', 'client', 'action'] },
      id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
    } }, outputSchema: { type: 'object' } } },
  { id: 'varin.settings.read', version: 1, tool: { name: 'settings_read', operation: 'read', completion: 'result',
    description: 'Read a catalog setting with effective source and revision. Global native settings work without a project. Project settings require the original admitted trusted source. Client settings target one authenticated Surface bound to this exact Thread/branch.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: { type: 'string', minLength: 1 }, scope: { type: 'string', enum: ['global', 'project', 'effective'] }, detail: { type: 'boolean' },
    } }, outputSchema: { type: 'object' } } },
  { id: 'varin.settings.update', version: 1, tool: { name: 'settings_update', operation: 'effect', completion: 'result',
    description: 'Update or reset declared settings fields using expectedRevision from read. Same-owner fields commit atomically; compound items report independent owner outcomes. Device settings finish only after the original authenticated Surface acknowledges. Use settings_action for action entries.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...patch.properties, items: { type: 'array', minItems: 1, items: patch } },
      anyOf: [{ required: ['id', 'set'] }, { required: ['id', 'reset'] }, { required: ['items'] }] }, outputSchema: { type: 'object' } } },
  { id: 'varin.settings.action', version: 1, tool: { name: 'settings_action', operation: 'effect', completion: 'result',
    description: 'Invoke an advertised action through its native owner. Read the entry first. Pending actions return durable owner operationId references scoped to this Thread/branch and entry; status/cancel/reply reuse that operationId. Sign-in prompts and actual completion remain with the account owner.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'verb'], properties: {
      id: { type: 'string', minLength: 1 }, verb: { type: 'string', minLength: 1 }, args: { type: 'object' }, operationId: { type: 'string', minLength: 1 },
    } }, outputSchema: { type: 'object' } } },
];
