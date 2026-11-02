/** Safe settings projections and narrow adapters over the original domain owners. */
import { parse, type ParseError } from 'jsonc-parser';
import type { ModelConnectionsSnapshot } from '@varin/application-client';
import { MODEL_CATALOG_FIELDS } from '@varin/application-client';
import { ModelConfigurationError, object } from '../models/configuration.js';
import type { ModelsService } from '../models/service.js';
import type { ModelChannelPatch } from '../models/channel-patch.js';
import { validateMcpPolicy, validateMcpServerConfig } from '../mcp/configuration.js';
export { applyModelChannelPatch, MODEL_CHANNEL_PATCH_SCHEMA } from '../models/channel-patch.js';
export { MCP_DOCUMENT_PATCH_SCHEMA } from '../mcp/configuration-patch.js';
export type { McpDocumentWriteReceipt } from '../mcp/configuration-patch.js';

/** Never return URL credentials or query values, even for non-standard secret names. */
export function sanitizeSettingsUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[present]');
    return url.toString();
  } catch { return { isSet: value.length > 0 }; }
}
const presence = (value: unknown) => ({ isSet: value !== undefined && value !== null && value !== '' });
const secretMap = (value: unknown) => object(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, presence(entry)])) : presence(value);
const sanitizeParameters = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeParameters);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /secret|password|credential|api[-_]?key|authorization|access[-_]?token|refresh[-_]?token/i.test(key) ? presence(entry) : sanitizeParameters(entry)]));
};
const pick = (value: object, keys: readonly string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));

export function sanitizeModelConnections(snapshot: ModelConnectionsSnapshot) {
  return {
    revision: snapshot.revision, types: snapshot.types, issues: snapshot.issues, directory: snapshot.directory,
    channels: snapshot.channels.map(({ connection, baseUrl, parameters, models, ...channel }) => ({
      ...pick(channel, ['id', 'name', 'type', 'enabled']),
      authentication: pick(channel.authentication, ['kind', 'reference', 'variable', 'file', 'profile', 'identityTokenFile', 'organizationId', 'federationRuleId', 'serviceAccountId', 'workspaceId']),
      baseUrl: sanitizeSettingsUrl(baseUrl), parameters: sanitizeParameters(parameters),
      models: models.map(model => ({ ...pick(model, ['id', 'enabled', ...MODEL_CATALOG_FIELDS]),
        ...(model.catalog ? { catalog: pick(model.catalog, ['source', 'overrides', 'match']) } : {}),
        ...(model.parameters ? { parameters: sanitizeParameters(model.parameters) } : {}),
        ...(model.compat ? { compat: sanitizeParameters(model.compat) } : {}),
        ...(model.image?.parameters ? { image: { ...model.image, parameters: sanitizeParameters(model.image.parameters) } } : {}),
        ...(model.tokenizer?.kind === 'url' ? { tokenizer: { ...model.tokenizer, url: sanitizeSettingsUrl(model.tokenizer.url) } } : {}),
      })),
      ...(connection ? { connection: {
        ...(connection.paths ? { paths: connection.paths } : {}),
        headersConfigured: Boolean(connection.headers && Object.keys(connection.headers).length),
        ...(connection.headers ? { headers: secretMap(connection.headers) } : {}),
        ...(connection.proxy ? { proxy: { mode: connection.proxy.mode, ...('url' in connection.proxy ? { url: sanitizeSettingsUrl(connection.proxy.url) } : {}) } } : {}),
      } } : {}),
    })),
  };
}

export async function patchModelChannel(owner: Pick<ModelsService, 'patch'>, args: Record<string, unknown>) {
  if (typeof args.id !== 'string' || !args.id.trim() || typeof args.expectedRevision !== 'string' || !args.expectedRevision) {
    throw new ModelConfigurationError('channel-patch-invalid', 'Channel id and expectedRevision are required');
  }
  return owner.patch(args.id, {
    ...(args.set !== undefined ? { set: args.set as NonNullable<ModelChannelPatch['set']> } : {}),
    ...(args.reset !== undefined ? { reset: args.reset as NonNullable<ModelChannelPatch['reset']> } : {}),
  }, args.expectedRevision);
}

function safeMcpServer(name: string, value: unknown): unknown {
  if (!object(value) || typeof validateMcpServerConfig(name, value) === 'string') return { malformed: true };
  const fields = ['command', 'cwd', 'type', 'enabled', 'exposure', 'toolExposure', 'description', 'timeout', 'isolation', 'lifecycle', 'auth'];
  const oauth = value.oauth;
  return {
    ...Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])),
    ...(value.url !== undefined ? { url: sanitizeSettingsUrl(value.url) } : {}),
    ...(value.args !== undefined ? { args: { isSet: true, ...(Array.isArray(value.args) ? { count: value.args.length } : {}) } } : {}),
    ...(value.env !== undefined ? { env: secretMap(value.env) } : {}),
    ...(value.headers !== undefined ? { headers: secretMap(value.headers) } : {}),
    ...(object(oauth) ? { oauth: { ...Object.fromEntries(['clientId', 'callbackPort', 'scope'].filter(key => oauth[key] !== undefined).map(key => [key, oauth[key]])),
      ...(oauth.callbackUrl !== undefined ? { callbackUrl: sanitizeSettingsUrl(oauth.callbackUrl) } : {}),
      ...(oauth.clientSecret !== undefined ? { clientSecret: presence(oauth.clientSecret) } : {}),
    } } : {}),
  };
}
export function sanitizeMcpDocument(value: unknown) {
  if (!object(value)) return { unavailable: true };
  const content = typeof value.content === 'string' ? value.content : undefined;
  const metadata = Object.fromEntries(['exists', 'format', 'path', 'revision', 'root', 'scope', 'activation'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const errors: ParseError[] = [];
  const parsed: unknown = content === undefined ? undefined : parse(content, errors, { allowTrailingComma: true });
  return {
    ...metadata, content: { isSet: content !== undefined && content.length > 0, ...(content === undefined ? {} : { bytes: Buffer.byteLength(content) }) },
    ...(errors.length || !object(parsed) ? { documentState: 'malformed' } : { document: {
      ...(Array.isArray(parsed.sources) ? { sources: parsed.sources.filter(source => typeof source === 'string') } : {}),
      ...(typeof parsed.autoEnableCodemode === 'boolean' ? { autoEnableCodemode: parsed.autoEnableCodemode } : {}),
      ...(object(parsed.mcpServers) ? { mcpServers: Object.fromEntries(Object.entries(parsed.mcpServers).map(([name, server]) => [name, safeMcpServer(name, server)])) } : {}),
      ...(object(parsed.mcpPolicies) ? { mcpPolicies: Object.fromEntries(Object.entries(parsed.mcpPolicies).map(([name, policy]) => [name, object(policy) && !validateMcpPolicy(policy)
        ? Object.fromEntries(['enabled', 'exposure', 'toolExposure'].filter(key => policy[key] !== undefined).map(key => [key, policy[key]])) : { malformed: true }])) } : {}),
    } }),
  };
}
