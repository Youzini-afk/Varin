/** JSON shapes shared by model-facing discovery and settings admission. These
 * describe owner DTOs, not another settings store; owners still validate model
 * availability, trusted scope, credentials, path semantics and cross-field rules. */
import { AGENT_AVATAR_IDS, FAST_DECISION_PURPOSES, HARNESS_MODEL_ROLES, THINKING_LEVELS } from '@varin/protocol';

type Schema = Record<string, unknown>;
const string = { type: 'string' };
const nonempty = { type: 'string', minLength: 1 };
const boolean = { type: 'boolean' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...integer, minimum: 1 };
const strings = { type: 'array', items: nonempty };
const object = (properties: Schema, required: string[] = []): Schema => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const record = (value: Schema): Schema => ({ type: 'object', propertyNames: nonempty, additionalProperties: value });
const model = object({ providerId: nonempty, modelId: nonempty }, ['providerId', 'modelId']);
const modelSettings = object({ temperature: { type: 'number', minimum: 0 }, thinkingLevel: { enum: THINKING_LEVELS } });
const agentProperties = { external: object({ configurationId: nonempty, model: nonempty }, ['configurationId']), avatar: { enum: AGENT_AVATAR_IDS },
  name: nonempty, description: string, instructions: string, tools: strings, modelSettings };
export const HARNESS_MODEL_BINDING_SCHEMA: Schema = { ...object({ enabled: boolean, inherit: boolean, providerId: nonempty, modelId: nonempty,
  agent: object(agentProperties) }), dependentRequired: { providerId: ['modelId'], modelId: ['providerId'] } };
const customAgent = object({ ...agentProperties, enabled: boolean, model, workFocus: { type: 'array', items: { enum: ['code', 'research'] } } }, ['name', 'description', 'instructions', 'enabled', 'workFocus']);
const profileOverrides = Object.fromEntries(Object.entries(agentProperties).filter(([key]) => key !== 'tools'));
export const AGENT_PROFILE_CONFIG_SCHEMA: Schema = { oneOf: [
  object({ kind: { const: 'builtin' }, slot: { enum: HARNESS_MODEL_ROLES }, binding: { ...HARNESS_MODEL_BINDING_SCHEMA,
    properties: { ...(HARNESS_MODEL_BINDING_SCHEMA.properties as Schema), agent: object(profileOverrides) } } }, ['kind', 'slot', 'binding']),
  object({ kind: { const: 'custom' }, key: string, agent: object({ ...profileOverrides, enabled: boolean, model,
    workFocus: { type: 'array', items: { enum: ['code', 'research'] } } }, ['name', 'description', 'instructions', 'enabled', 'workFocus']) }, ['kind', 'key', 'agent']),
] };
const ratio = { type: 'number', minimum: 0, exclusiveMaximum: 1 };
const fastBinding = object({ protocol: { const: 'typed-classifier' }, providerId: nonempty, modelId: nonempty, endpoint: nonempty }, ['protocol', 'providerId', 'modelId']);
const pickerModels = { type: 'array', maxItems: 1024, items: object({ providerID: nonempty, modelID: nonempty }, ['providerID', 'modelID']) };
const toggle = { enum: ['profile', 'on', 'off'] };
const fileEditor = object({
  ...Object.fromEntries(['autoClosingBrackets', 'autoClosingQuotes', 'autoSurround', 'detectIndentation', 'folding', 'fontLigatures', 'formatOnSave', 'formatOnType', 'insertSpaces', 'smoothScrolling'].map(key => [key, boolean])),
  accessibilitySupport: { enum: ['auto', 'on', 'off'] }, cursorBlinking: { enum: ['blink', 'smooth', 'phase', 'expand', 'solid'] }, cursorStyle: { enum: ['line', 'block', 'underline'] },
  lineHeight: { type: 'number', minimum: 0 }, lineNumbers: { enum: ['profile', 'on', 'off', 'relative'] }, minimap: toggle,
  renderWhitespace: { enum: ['none', 'boundary', 'selection', 'trailing', 'all'] }, stickyScroll: toggle, tabSize: positive, wordWrap: toggle,
});
const schemas: Record<string, Schema> = {
  favoriteModels: { ...pickerModels, maxItems: 64 }, hiddenModels: pickerModels,
  fileEditorSettings: fileEditor,
  notificationTemplates: object(Object.fromEntries(['completion', 'error', 'question', 'subtask'].map(key => [key, object({ title: string, message: string })]))),
  shortcutOverrides: { type: 'object', propertyNames: { ...nonempty, maxLength: 128 }, additionalProperties: { ...nonempty, maxLength: 128 } },
  managedRemoteTunnelPresets: { type: 'array', items: object({ id: nonempty, name: nonempty, hostname: nonempty }, ['id', 'name', 'hostname']) },
  skillCatalogs: { type: 'array', items: object({ id: nonempty, label: nonempty, source: nonempty, subpath: nonempty, gitIdentityId: nonempty }, ['id', 'label', 'source']) },
  draftStarters: { type: 'array', items: object({ type: { enum: ['command', 'skill'] }, name: nonempty }, ['type', 'name']) },
  utilityModel: model,
  'harness.tools': record(boolean),
  'harness.permissions.rules': { type: 'array', items: object({ tool: nonempty, match: object({ param: nonempty, pattern: { type: 'string', maxLength: 512 } }, ['param', 'pattern']), decision: { enum: ['allow', 'deny', 'ask'] }, authority: nonempty }, ['tool', 'decision']) },
  'harness.images': object({ generation: { anyOf: [model, { type: 'null' }] }, editing: { anyOf: [model, { type: 'null' }] } }),
  'harness.agents': record(customAgent),
  'harness.delegationModelSelection': {
    ...object({ enabled: boolean, model: object({ providerId: { ...nonempty, pattern: '\\S' }, modelId: { ...nonempty, pattern: '\\S' } }, ['providerId', 'modelId']),
      thinkingLevel: { enum: THINKING_LEVELS } }),
    if: { properties: { enabled: { const: true } }, required: ['enabled'] },
    then: { required: ['model'] },
  },
  'harness.nextStep': object({ enabled: boolean }),
  'harness.embedding': object({ protocol: { enum: ['local', 'openai-compatible'] }, providerId: nonempty, modelId: nonempty, dimensions: positive, maxTokens: positive }, ['protocol', 'providerId', 'modelId']),
  'harness.rerank': object({ protocol: { const: 'http-rerank' }, providerId: nonempty, modelId: nonempty, endpoint: nonempty, maxDocumentTokens: positive }, ['protocol', 'providerId', 'modelId']),
  'harness.fastDecision': object({ default: fastBinding, purposes: object(Object.fromEntries(FAST_DECISION_PURPOSES.map(key => [key, { anyOf: [fastBinding, { const: 'off' }] }]))) }),
  'harness.web.sourcePreferences': object({ preferredDomains: strings, excludedDomains: strings }),
  'harness.web.search': { anyOf: [
    object({ provider: { enum: ['brave', 'exa', 'tavily', 'jina', 'searxng', 'anysearch'] }, endpoint: nonempty, credentialRef: nonempty }, ['provider']),
    object({ connections: { type: 'array', items: object({ id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' }, name: nonempty, enabled: boolean,
      provider: { enum: ['brave', 'exa', 'tavily', 'jina', 'searxng', 'anysearch'] }, endpoint: nonempty, credentialRef: nonempty, description: { type: 'string' } }, ['id', 'name', 'enabled', 'provider']) },
      defaultConnectionId: nonempty, fallbackConnectionIds: { type: 'array', uniqueItems: true, items: nonempty }, enabled: boolean, smartSelection: boolean }, ['connections', 'fallbackConnectionIds']),
  ] },
  'harness.documentReading': object({ doclingCommand: string, tesseractCommand: string, ocrLanguage: string }),
  'harness.web.domains': object({ allow: strings, block: strings }),
  'harness.dispatch': object({ concurrency: positive, askBefore: record(boolean) }),
  'harness.worktree': object({ setup: string, setupTimeoutMs: positive, copyIgnored: strings, shareDependencies: boolean, reclaimIdle: boolean,
    budget: object({ maxBytes: positive, minFreeRatio: ratio }) }),
  'harness.knowledge': object({ eventRetentionDays: integer, autoOrganize: object({ user: boolean, bot: boolean }) }),
  retry: object({ enabled: boolean, maxRetries: integer, initialDelayMs: integer, maxDelayMs: integer,
    rules: { type: 'array', items: object({ field: { enum: ['status', 'code', 'message'] }, match: { enum: ['exact', 'contains', 'regex'] }, pattern: nonempty, action: { enum: ['retry', 'stop'] } }, ['field', 'match', 'pattern', 'action']) } }),
};
export function settingsValueSchema(path: string): Schema | undefined {
  return path.startsWith('harness.models.') ? HARNESS_MODEL_BINDING_SCHEMA : schemas[path];
}
