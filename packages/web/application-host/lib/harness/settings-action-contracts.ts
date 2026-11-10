/** Executable argument contracts for the settings facade. Domain owners retain
 * semantic validation, CAS and persistence; this table describes only their
 * admitted action surface, shared by discovery, validation and permission routing. */
import { AGENT_PROFILE_CONFIG_SCHEMA, type SettingsActionContract, type SettingsCatalogEntry } from '@varin/application-client';
import { THINKING_LEVELS } from '@varin/protocol';
import { MODEL_CHANNEL_PATCH_SCHEMA, MCP_DOCUMENT_PATCH_SCHEMA } from './settings-domain-patches.js';

type Schema = Record<string, unknown>;
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableString = { type: ['string', 'null'] };
const object = (properties: Record<string, unknown> = {}, required: string[] = []): Schema =>
  ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const model = object({ providerId: string, modelId: string, thinkingLevel: { enum: THINKING_LEVELS } }, ['providerId', 'modelId']);
const threadModel = object({ ...model.properties as Schema, thinkingLevel: { enum: THINKING_LEVELS }, temperature: { type: 'number', minimum: 0 } }, ['providerId', 'modelId']);
const read = (inputSchema = object(), note?: string): SettingsActionContract => ({ inputSchema, mutation: 'none', ...(note ? { note } : {}) });
const write = (inputSchema: Schema, apply: SettingsCatalogEntry['apply'] = 'immediate', note?: string,
  authority?: SettingsActionContract['authority']): SettingsActionContract => ({ inputSchema, mutation: 'owner', apply, ...(note ? { note } : {}), ...(authority ? { authority } : {}) });
const revision = { expectedRevision: string };
const identified = { id: string, ...revision };
const auth = object({ provider: string, reference: string }, ['provider', 'reference']);
const reply = object({ operationId: string, redirect: string }, ['operationId', 'redirect']);
const profileConfig = AGENT_PROFILE_CONFIG_SCHEMA;
const connectionAuthentication = { oneOf: [
  object({ kind: { const: 'none' } }, ['kind']),
  object({ kind: { const: 'credential' }, reference: string }, ['kind', 'reference']),
  object({ kind: { const: 'environment' }, variable: string }, ['kind', 'variable']),
  object({ kind: { const: 'google-adc' }, file: string }, ['kind']),
  object({ kind: { const: 'aws-chain' }, profile: string }, ['kind']),
  object({ kind: { const: 'anthropic-federation' }, identityTokenFile: string, organizationId: string, federationRuleId: string, serviceAccountId: string, workspaceId: string }, ['kind', 'identityTokenFile', 'organizationId', 'federationRuleId']),
] };
const channelSchema = object({ id: string, name: string, type: string, enabled: { type: 'boolean' }, baseUrl: { type: 'string' }, authentication: connectionAuthentication,
  parameters: { type: 'object', description: 'Use this channel type’s parametersSchema from providers read; provider-specific parameters are validated by the model owner.' },
  connection: object({ headers: { type: 'object', additionalProperties: { type: 'string' } }, paths: { type: 'object', additionalProperties: { type: 'string' } },
    proxy: { oneOf: [object({ mode: { const: 'direct' } }, ['mode']), object({ mode: { const: 'proxy' }, url: string }, ['mode', 'url'])] } }),
  models: { type: 'array', items: { ...object({ id: string, name: string, description: { type: 'string' }, enabled: { type: 'boolean' },
    operations: { type: 'array', minItems: 1, items: { enum: ['chat', 'embedding', 'rerank', 'decision', 'image-generation', 'image-editing'] } },
    protocol: string, requestModelId: string, input: { type: 'array', items: { enum: ['text', 'image'] } },
    contextWindow: { ...integer, minimum: 1 }, maxOutputTokens: { ...integer, minimum: 1 }, reasoning: { type: 'boolean' },
    billing: { enum: ['metered', 'subscription', 'local'] }, thinkingLevelMap: { type: 'object', propertyNames: { enum: THINKING_LEVELS }, additionalProperties: { type: ['string', 'null'] } },
    ...Object.fromEntries(['pricing', 'thinking', 'parameters', 'compat', 'image', 'decision', 'tokenizer', 'catalog'].map(key => [key, { type: 'object', description: 'Native model metadata; use the configured channel model or owner model-directory descriptor as the starting value.' }])),
  }, ['id', 'name', 'enabled', 'operations']) } },
}, ['id', 'name', 'type', 'enabled', 'baseUrl', 'authentication', 'parameters', 'models']);


/** Does not read live settings or credentials, so search can disclose this cheaply. */
export function getSettingsActionContracts(entry: SettingsCatalogEntry): Record<string, SettingsActionContract> {
  let contracts: Record<string, SettingsActionContract>;
  switch (entry.actionRef?.domain) {
    case 'service:web-search': {
      const provider = { enum: ['brave', 'exa', 'tavily', 'jina', 'searxng', 'anysearch'] };
      const fields = { name: string, description: { type: 'string' }, enabled: { type: 'boolean' }, endpoint: nullableString };
      contracts = {
        list: read(),
        add: write(object({ ...revision, connection: object({ ...fields, endpoint: string, provider }, ['provider']) }, ['expectedRevision', 'connection']), 'next-request', 'The Host assigns the connection ID and its private credential reference.', 'credentials'),
        patch: write(object({ ...identified, set: { ...object(fields), minProperties: 1 } }, ['id', 'expectedRevision', 'set']), 'next-request', 'Only supplied fields change; null endpoint restores the provider default.'),
        remove: write(object(identified, ['id', 'expectedRevision']), 'next-request', 'Removes the connection and route references. Credentials are retained; remove-credential explicitly removes a key.', 'credentials'),
        route: write(object({ ...revision, set: { ...object({ defaultConnectionId: nullableString, fallbackConnectionIds: { type: 'array', uniqueItems: true, items: string }, enabled: { type: 'boolean' }, smartSelection: { type: 'boolean' } }), minProperties: 1 } }, ['expectedRevision', 'set']), 'next-request'),
        'restore-default': write(object(revision, ['expectedRevision']), 'next-request', 'Restores the built-in keyless route without removing any saved key.', 'credentials'),
        test: read(object({ id: string }, ['id']), 'Runs one real Varin documentation search on this saved connection, with no fallback or cached result. Provider usage may be charged.'),
        'credential-status': read(object({ id: string }, ['id'])),
        'enter-credential': write(object({ id: string }, ['id']), 'next-request', 'Opens a private password field in the interface bound to this conversation. Do not ask for a key in chat or pass one in tool arguments. Query/cancel the returned operation to observe completion.', 'credentials'),
        'remove-credential': write(object({ id: string }, ['id']), 'next-request', 'Removes the key under this saved connection reference; any connection sharing that reference also loses access.', 'credentials'),
      };
      break;
    }
    case 'service:self-bot': contracts = {
      read: read(), update: write({ ...object({ expectedRevision: integer, name: string, instructions: nullableString,
        model: { anyOf: [model, { type: 'null' }] } }, ['expectedRevision']), minProperties: 2 }, 'next-request',
      'Updates this Bot profile. Name is immediate; instructions/model propagate to direct Bot conversations at safe request boundaries. Delegated work retains its model.'),
    }; break;
    case 'service:self-conversation': contracts = {
      read: read(), 'select-model': write(object({ model: threadModel }, ['model']), 'next-request',
        'Selects only the admitted current Run. The original operation identity is the idempotency key; desired and active are distinct. Does not change Bot or future-session defaults.'),
    }; break;
    case 'runtime:providers': contracts = {
      list: read(), status: read(), read: read(), models: read(),
      save: write(object({ channel: { ...channelSchema, description: 'Complete channel for creation/replacement. Prefer patch for an existing channel so hidden secrets survive.' }, ...revision }, ['channel', 'expectedRevision']), 'next-request'),
      patch: write(MODEL_CHANNEL_PATCH_SCHEMA, 'next-request', 'Patch only declared channel fields. Set models.<literal model ID>.description to edit an introduction (empty string explicitly clears it); reset that path to restore directory defaults. Omitted secrets, other models and unrelated fields are retained by the owner.'),
      remove: write(object(identified, ['id', 'expectedRevision']), 'next-request'),
      connect: write(auth, 'next-request', 'Starts an owned authorization flow; inspect the returned operation.', 'credentials'),
      login: write(auth, 'next-request', 'Starts an owned authorization flow; inspect the returned operation.', 'credentials'),
      reply: write(reply, 'next-request', undefined, 'credentials'),
      disconnect: write(object({ reference: string }, ['reference']), 'next-request', undefined, 'credentials'),
      'discover-models': write(object({ id: string }, ['id']), 'next-request', 'Refreshes an existing channel through its configured endpoint and account.'),
    }; break;
    case 'runtime:mcp': contracts = {
      status: read(), read: read(object({ path: string }), 'With a source path, reads its revision and redacted document metadata; without it, reads the server directory.'),
      write: write(object({ path: string, content: { type: 'string' }, ...revision }, ['path', 'content', 'expectedRevision']), 'next-run',
        'Explicit full-document replacement. Hidden fields are not reconstructed from redacted reads; use patch for a single existing definition.', 'credentials'),
      patch: write(MCP_DOCUMENT_PATCH_SCHEMA, 'next-run', 'Patch one named server in the selected source; omitted secrets and JSONC comments are preserved. Command, endpoint and credential-routing paths require semantic management authority; ordinary enablement/description/timeouts do not.'),
      connect: write(object({ name: string }, ['name'])), reconnect: write(object({ name: string }, ['name'])), disconnect: write(object({ name: string }, ['name'])),
      login: write(object({ name: string }, ['name']), 'next-request', undefined, 'credentials'), reply: write(reply, 'next-request', undefined, 'credentials'),
    }; break;
    case 'service:agents': contracts = {
      list: read(), status: read(), read: read(),
      create: write(object({ ...revision, config: profileConfig, tools: { type: 'array', items: string } }, ['expectedRevision', 'config', 'tools']), 'next-run'),
      update: write(object({ ...identified, config: profileConfig, tools: { type: ['array', 'null'], items: string } }, ['id', 'expectedRevision', 'config']), 'next-run'),
      enable: write(object(identified, ['id', 'expectedRevision']), 'next-run'), disable: write(object(identified, ['id', 'expectedRevision']), 'next-run'),
      delete: write(object(identified, ['id', 'expectedRevision']), 'next-run'),
    }; break;
    case 'service:embedding-requests': contracts = {
      read: read(), write: write(object({ revision: string, config: object({ concurrentRequests: { ...integer, minimum: 1 }, requestIntervalMs: { ...integer, maximum: 2147483647 },
        localCpuMode: { enum: ['auto', 'efficient', 'performance'] }, localCpuThreads: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }) }, ['revision', 'config']), 'restart'),
    }; break;
    case 'service:extension-packages': contracts = {
      list: read(), remove: write(object({ id: string, expectedRevision: integer }, ['id', 'expectedRevision'])),
    }; break;
    case 'service:extensions': {
      const shell = { contributionId: string, surface: { enum: ['web', 'desktop', 'mobile'] }, profileId: string, scopeId: string, expectedRevision: integer };
      contracts = { list: read(), enable: write(object({ extensionId: string, expectedRevision: integer }, ['extensionId', 'expectedRevision'])),
        disable: write(object({ extensionId: string, expectedRevision: integer }, ['extensionId', 'expectedRevision'])),
        select: entry.id === 'extensions.workbench.shell'
          ? write(object(shell, ['contributionId', 'expectedRevision']))
          : write(object({ profileId: string, expectedRevision: integer }, ['profileId', 'expectedRevision'])),
        clear: write(object(Object.fromEntries(Object.entries(shell).filter(([key]) => key !== 'contributionId')), ['expectedRevision'])),
        apply: write(object({ profileId: string, expectedCatalogRevision: integer }, ['profileId', 'expectedCatalogRevision'])),
      }; break;
    }
    case 'service:git': contracts = {
      status: read(), list: read(), create: write(object({ id: string, name: string, userName: string, userEmail: string }, ['userName', 'userEmail'])),
      update: write({ ...object({ id: string, name: string, userName: string, userEmail: string }, ['id']), minProperties: 2 }), delete: write(object({ id: string }, ['id'])),
    }; break;
    case 'service:projects': {
      const target = { projectId: string, ...revision };
      contracts = { rename: write(object({ ...target, name: string }, ['projectId', 'expectedRevision', 'name'])),
        'set-default-work-focus': write(object({ ...target, focus: { enum: ['code', 'research'] } }, ['projectId', 'expectedRevision', 'focus'])),
        'set-color': write(object({ ...target, color: nullableString }, ['projectId', 'expectedRevision', 'color'])),
        'set-icon': write(object({ ...target, icon: nullableString }, ['projectId', 'expectedRevision', 'icon'])),
      }; break;
    }
    case 'service:remote-instances': contracts = { status: read(), revoke: write(object({ clientId: string }, ['clientId']), 'immediate', undefined, 'credentials') }; break;
    case 'runtime:language-support': contracts = { status: read(), prepare: write(object({ languageId: string }, ['languageId'])), cancel: write(object({ languageId: string }, ['languageId'])) }; break;
    case 'service:tunnel': contracts = { status: read(object({ provider: string })), start: write(object({ provider: string, mode: string }), 'immediate', 'Starts remote access to this Host; requires explicit semantic permission authority.', 'permissions'), stop: write(object()) }; break;
    default: contracts = {};
  }
  return Object.fromEntries(Object.entries(contracts).filter(([verb]) => entry.actionRef?.verbs?.includes(verb)));
}
export function getSettingsActionContract(entry: SettingsCatalogEntry, verb: string): SettingsActionContract | undefined {
  return getSettingsActionContracts(entry)[verb];
}
