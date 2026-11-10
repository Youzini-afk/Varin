import type { VarinExtensionServiceProvision } from '@varin/extension-contract';

export const SETTINGS_CAPABILITY = 'settings';
const scope = { type: 'string', enum: ['global', 'project'] };
const patch = { type: 'object', additionalProperties: false, required: ['id'], properties: {
  id: { type: 'string', minLength: 1 }, scope,
  set: { type: 'object' }, reset: { type: 'array', items: { type: 'string' } }, expectedRevision: { type: 'string' },
} };
export const SETTINGS_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [
  { id: 'varin.settings.search', version: 2, tool: { name: 'settings_search', operation: 'read', completion: 'result',
    description: 'Find native settings by keyword, category or stable id. Default searches return concise candidates and read links; next continues the list. An exact id or detail:full returns field and per-verb schemas. settings_read reads one setting with its current values and edit contract.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string' }, category: { type: 'string' }, owner: { type: 'string', enum: ['app', 'agent-settings', 'client', 'action'] },
      id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
      detail: { enum: ['summary', 'full'] },
    } }, outputSchema: { type: 'object' } } },
  { id: 'varin.settings.read', version: 2, tool: { name: 'settings_read', operation: 'read', completion: 'result',
    description: 'Read saved layers, merged configured next-use values, a revision-bound settings ref and actual apply timing (not an active Run snapshot). Global native settings work without a project. Project settings require the original admitted trusted source. Client settings target one authenticated Surface bound to this exact Thread/branch.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: { type: 'string', minLength: 1 }, scope: { type: 'string', enum: ['global', 'project', 'effective'] }, detail: { type: 'boolean' },
    } }, outputSchema: { type: 'object' } } },
  { id: 'varin.settings.update', version: 2, tool: { name: 'settings_update', operation: 'effect', completion: 'result',
    description: 'Update or reset declared settings fields. id accepts the settings ref from settings_read, which preserves the observed scope and revision; semantic ids with explicit expectedRevision remain supported. App and Agent-file groups use owner CAS; compound items retain their original index, scope, timing and mutation outcome without global rollback. Client consistency is owner-declared; do not supply a revision to a last-write-wins owner. JSON fields replace the declared path unless a domain patch action says otherwise. Device settings finish only after the original authenticated Surface acknowledges. Use settings_action for action entries.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...patch.properties, items: { type: 'array', minItems: 1, items: patch } },
      oneOf: [
        { not: { required: ['items'] }, anyOf: [{ required: ['id', 'set'] }, { required: ['id', 'reset'] }] },
        { required: ['items'], not: { anyOf: ['scope', 'set', 'reset', 'expectedRevision'].map(key => ({ required: [key] })) } },
      ] }, outputSchema: { type: 'object' } } },
  { id: 'varin.settings.action', version: 2, tool: { name: 'settings_action', operation: 'effect', completion: 'result',
    description: 'Invoke an advertised action through its native owner. Use the exact per-verb inputSchema returned by search/read. self.bot-profile changes only the current Bot; self.conversation-model stages the current admitted Run without changing defaults. Pending actions return durable owner operationId references scoped to this Thread/branch and entry; status/cancel/reply reuse that operationId. Sign-in prompts and actual completion remain with the account owner.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'verb'], properties: {
      id: { type: 'string', minLength: 1 }, verb: { type: 'string', minLength: 1 }, args: { type: 'object' }, operationId: { type: 'string', minLength: 1 },
    } }, outputSchema: { type: 'object' } } },
];
