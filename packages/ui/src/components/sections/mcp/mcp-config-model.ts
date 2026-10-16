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
export const switchMcpServerTransport = (content: string, serverName: string, transport: Exclude<McpServerTransportMode, 'unconfigured'>): string => {
  const path = ['mcpServers', serverName];
  const server = asJsonObject(readJsonPath(parseMcpConfigObject(content), path));
  // A transport switch retains the server, even when its old definition is empty or minimal.
  let next = updateJsoncPath(content, [...path, 'type'], transport);
  const removed = transport === 'stdio' ? HTTP_FIELDS : STDIO_FIELDS;
  for (const field of removed) next = removeJsoncPath(next, [...path, field]);
  const field = transport === 'stdio' ? 'command' : 'url';
  return updateJsoncPath(next, [...path, field], typeof server[field] === 'string' ? server[field] : '');
};
