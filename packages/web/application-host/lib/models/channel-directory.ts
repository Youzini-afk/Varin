/** Reviewed service data can evolve independently of installed authentication/protocol behavior. */
import { readFileSync } from 'node:fs';
import { object } from './configuration.js';
import { modelList } from './discovery.js';
import type { ChannelType } from './channel-types.js';

export const CHANNEL_DIRECTORY_URL = 'https://raw.githubusercontent.com/Youzini-afk/Varin/main/packages/web/application-host/lib/models/channel-directory.json';
export const BUNDLED_CHANNEL_DIRECTORY: unknown = JSON.parse(readFileSync(new URL('./channel-directory.json', import.meta.url), 'utf8'));
export interface ChannelDirectoryEntry {
  id: string; name: string; kind: 'model-vendor' | 'agent-service' | 'local'; protocol: string;
  baseUrl: string; environmentVariable?: string; metadataId?: string;
}
const protocols = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations']);
export function parseChannelDirectory(value: unknown): ChannelDirectoryEntry[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.channels)) throw new Error('Invalid channel directory');
  const ids = new Set<string>();
  return value.channels.map(entry => {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()
      || !['model-vendor', 'agent-service', 'local'].includes(String(entry.kind)) || typeof entry.protocol !== 'string' || !protocols.has(entry.protocol)
      || typeof entry.baseUrl !== 'string' || entry.environmentVariable !== undefined && typeof entry.environmentVariable !== 'string'
      || entry.metadataId !== undefined && typeof entry.metadataId !== 'string') throw new Error('Invalid channel directory entry');
    const url = new URL(entry.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid channel directory endpoint');
    ids.add(entry.id);
    return { id: entry.id, name: entry.name, kind: entry.kind, protocol: entry.protocol, baseUrl: url.href.replace(/\/+$/, ''),
      ...(entry.environmentVariable ? { environmentVariable: entry.environmentVariable } : {}), ...(entry.metadataId ? { metadataId: entry.metadataId } : {}) } as ChannelDirectoryEntry;
  });
}
export function directoryChannel(entry: ChannelDirectoryEntry, template?: ChannelType): ChannelType {
  return { id: entry.id, name: entry.name, protocol: entry.protocol, defaultBaseUrl: entry.baseUrl,
    authentication: entry.kind === 'local' ? ['none', 'credential', 'environment'] : ['credential', 'environment', 'none'],
    operations: ['chat'], discovery: true, parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...(entry.environmentVariable ? { defaultEnvironmentVariable: entry.environmentVariable } : {}),
    ...(entry.metadataId ? { metadataId: entry.metadataId } : {}),
    discoveryRequest: template?.discoveryRequest ?? (channel => ({ url: `${channel.baseUrl.replace(/\/+$/, '')}/models` })),
    parseDiscovery: template?.parseDiscovery ?? modelList,
    ...(template?.discoveryCursor ? { discoveryCursor: template.discoveryCursor } : {}) };
}
