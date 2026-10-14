/** Streamable HTTP's body/header projection (MCP 2026-07-28, SEP-2243). */
import { ProtocolError } from '@modelcontextprotocol/client';

export const isModernMcpVersion = (version: string | undefined) => version !== undefined && version >= '2026-07-28';
export function encodeMcpHeaderValue(value: string): string {
  return /[^\t\x20-\x7e]/.test(value) || value.trim() !== value || value.startsWith('=?base64?')
    ? `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
}
interface Declaration { path: string[]; name: string; type: 'string' | 'integer' | 'boolean' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const branches = ['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'];
const maps = ['patternProperties', 'dependentSchemas', '$defs', 'definitions'];
export function mcpHeaderDeclarations(schema: unknown): Declaration[] {
  const declarations: Declaration[] = [], names = new Set<string>();
  const visit = (node: unknown, path: string[] | null) => {
    if (!object(node)) return;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'], type = node.type;
      if (!path?.length || typeof name !== 'string' || !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(name)
        || !['string', 'integer', 'boolean'].includes(String(type)) || names.has(name.toLowerCase())) {
        throw new ProtocolError(-32602, 'MCP tool header declarations are invalid');
      }
      names.add(name.toLowerCase()); declarations.push({ path, name, type: type as Declaration['type'] });
    }
    for (const [key, child] of Object.entries(object(node.properties) ? node.properties : {})) visit(child, path && [...path, key]);
    for (const key of branches) for (const child of Array.isArray(node[key]) ? node[key] : [node[key]]) visit(child, null);
    for (const key of maps) for (const child of Object.values(object(node[key]) ? node[key] : {})) visit(child, null);
  };
  visit(schema, []); return declarations;
}
export function mcpArgumentHeaders(declarations: readonly Declaration[], args: unknown) {
  const headers: Record<string, string> = {};
  for (const declaration of declarations) {
    let value = args;
    for (const key of declaration.path) value = object(value) ? value[key] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value !== declaration.type && !(declaration.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value))) {
      throw new ProtocolError(-32602, 'MCP header parameter does not match its declaration');
    }
    headers[`Mcp-Param-${declaration.name}`] = encodeMcpHeaderValue(String(value));
  }
  return headers;
}
