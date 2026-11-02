/** Structured MCP edits preserve omitted credentials and unrelated JSONC source text. */
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { ModelConfigurationError, object } from '../models/configuration.js';
import { compileToolJsonSchema } from '../models/schema.js';
import type { McpConfigurationDocument } from '@varin/application-client';

export interface McpDocumentWriteReceipt extends McpConfigurationDocument {
  /** Saving the source and publishing the candidate are distinct facts. */
  activation: { state: 'ready' | 'unavailable'; detail?: string };
}

export interface McpServerPatch { name: string; set?: Record<string, unknown>; reset?: string[] }
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
const exposure = { enum: ['direct', 'codemode', 'deferred', 'hidden'] };
const setProperties = {
  command: { type: 'string', minLength: 1 }, args: { type: 'array', items: { type: 'string' } },
  cwd: { type: 'string' }, env: stringMap, url: { type: 'string' }, type: { enum: ['http', 'stdio'] },
  headers: stringMap, auth: { type: 'object', additionalProperties: false, required: ['provider'], properties: { provider: { type: 'string', minLength: 1 } } },
  'oauth.clientId': { type: 'string' }, 'oauth.clientSecret': { type: 'string' }, 'oauth.callbackPort': { type: 'integer', minimum: 0, maximum: 65535 },
  'oauth.callbackUrl': { type: 'string' }, 'oauth.scope': { type: 'string' },
  enabled: { type: 'boolean' }, exposure, toolExposure: { type: 'object', additionalProperties: exposure },
  description: { type: 'string' }, timeout: { type: 'number', exclusiveMinimum: 0 }, isolation: { enum: ['shared', 'session'] },
  'lifecycle.keepAlive': { type: 'boolean' }, 'lifecycle.idleTimeoutSeconds': { type: 'number', minimum: 0 },
};
const namedField = '^(env|headers|toolExposure)\\..+$';
export const MCP_SERVER_PATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    set: { type: 'object', minProperties: 1, additionalProperties: false, properties: setProperties,
      patternProperties: { '^env\\..+$': { type: 'string' }, '^headers\\..+$': { type: 'string' }, '^toolExposure\\..+$': exposure } },
    reset: { type: 'array', minItems: 1, uniqueItems: true, items: { anyOf: [
      { enum: [...Object.keys(setProperties), 'oauth', 'lifecycle'] }, { type: 'string', pattern: namedField },
    ] } },
  },
  anyOf: [{ required: ['set'] }, { required: ['reset'] }],
};
export const MCP_DOCUMENT_PATCH_SCHEMA = {
  ...MCP_SERVER_PATCH_SCHEMA,
  required: ['name', 'path', 'expectedRevision'],
  properties: { ...MCP_SERVER_PATCH_SCHEMA.properties,
    path: { type: 'string', minLength: 1 }, expectedRevision: { type: 'string', minLength: 1 } },
};
const validate = compileToolJsonSchema(MCP_SERVER_PATCH_SCHEMA);
export function patchMcpServerDocument(content: string, patch: McpServerPatch): string {
  if (!validate(patch) || Object.values(patch.set ?? {}).some(value => value === undefined)) throw new ModelConfigurationError('mcp-patch-invalid', 'Use declared MCP server set/reset paths and valid values');
  const errors: ParseError[] = [], document: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length || !object(document) || document.mcpServers !== undefined && !object(document.mcpServers)) {
    throw new ModelConfigurationError('mcp-config-invalid', 'Cannot patch a malformed MCP document');
  }
  const paths = [...Object.keys(patch.set ?? {}), ...(patch.reset ?? [])];
  if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && (other === path || other.startsWith(`${path}.`))))) {
    throw new ModelConfigurationError('mcp-patch-invalid', 'MCP patch paths cannot overlap');
  }
  let next = content;
  for (const path of paths) {
    const named = /^(env|headers|toolExposure)\.(.+)$/.exec(path);
    const parts = named ? [named[1]!, named[2]!] : path.split('.');
    next = applyEdits(next, modify(next, ['mcpServers', patch.name, ...parts], (patch.reset ?? []).includes(path) ? undefined : patch.set![path], {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: content.includes('\r\n') ? '\r\n' : '\n' },
    }));
  }
  return next;
}
