import type { JsonValue } from '@varin/protocol';
import { asJsonObject, parseJsoncObject, readJsonPath, removeJsoncPath, updateJsoncPath, type JsonObject } from '@/lib/jsonConfig';

export type McpServerTransportMode = 'http' | 'stdio' | 'unconfigured';
const STDIO_FIELDS = ['command', 'args', 'env', 'cwd'] as const;
const HTTP_FIELDS = ['url', 'headers', 'auth', 'oauth'] as const;
export const parseMcpConfigObject = (content: string): JsonObject => parseJsoncObject(content);
export const mcpSourceBooleanState = (document: JsonObject, path: readonly string[]): 'disabled' | 'enabled' | 'not-set' => {
  const value = readJsonPath(document, path);
  return value === true ? 'enabled' : value === false ? 'disabled' : 'not-set';
};
export const mcpServerTransport = (document: JsonObject, serverName: string): McpServerTransportMode => {
  const server = asJsonObject(readJsonPath(document, ['mcpServers', serverName]));
  return typeof server.command === 'string' ? 'stdio' : typeof server.url === 'string' ? 'http' : 'unconfigured';
};
export const setMcpConfigValue = (content: string, path: readonly string[], value: JsonValue): string => updateJsoncPath(content, path, value);
export const removeMcpConfigValue = (content: string, path: readonly string[]): string => removeJsoncPath(content, path);
export const switchMcpServerTransport = (content: string, serverName: string, transport: McpServerTransportMode): string => {
  const path = ['mcpServers', serverName];
  const server = asJsonObject(readJsonPath(parseMcpConfigObject(content), path));
  let next = content;
  const removed = transport === 'stdio' ? HTTP_FIELDS : transport === 'http' ? STDIO_FIELDS : [...STDIO_FIELDS, ...HTTP_FIELDS];
  for (const field of removed) next = removeJsoncPath(next, [...path, field]);
  if (transport === 'unconfigured') return removeJsoncPath(next, [...path, 'type']);
  const field = transport === 'stdio' ? 'command' : 'url';
  next = updateJsoncPath(next, [...path, field], typeof server[field] === 'string' ? server[field] : '');
  return updateJsoncPath(next, [...path, 'type'], transport);
};
