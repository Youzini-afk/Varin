import { runtimeFetch } from './transport/runtime-fetch.js';
import type { ThreadIdentity } from './threads.js';

export interface BotGroupMember {
  botId: string;
  name: string;
  listening: boolean;
  membership: string;
  changedBy?: 'user' | 'bot';
  calendar?: ThreadIdentity;
  conversation?: ThreadIdentity;
}

export type GroupDeliveryState = 'queued' | 'running' | 'answered' | 'silent' | 'informed' | 'asleep' | 'failed' | 'removed' | 'execution-failed';
export interface GroupDelivery {
  botId: string;
  membership: string;
  state: GroupDeliveryState;
  identity?: ThreadIdentity;
  runId?: string;
  detail?: string;
}

export interface BotGroupPost {
  id: string;
  at: number;
  author: { kind: 'user' } | { kind: 'bot'; botId: string; name: string } | { kind: 'system' };
  text: string;
  quoteId?: string;
  quote?: { text: string; author?: string };
  informs?: boolean;
  addressed: string[];
  delivery: GroupDelivery[];
  fact?: { kind: 'listen'; name: string; enabled: boolean; actor: 'user' | 'bot' };
  work?: { title: string; identity: ThreadIdentity };
  scheduleName?: string;
  watchName?: string;
  files?: GroupChatFile[];
}

export interface GroupChatFile { id: string; filename: string; mimeType: string; byteLength: number }

export interface BotGroupSummary {
  id: string;
  name: string;
  members: BotGroupMember[];
  updatedAt: number;
  preview?: string;
  active: boolean;
  needsAttention: boolean;
}

export interface BotGroupPage extends BotGroupSummary {
  posts: BotGroupPost[];
  before?: string;
}

export interface GroupPostInput {
  id: string;
  text: string;
  addressed: string[];
  quoteId?: string;
  reply?: boolean;
  files?: string[];
}

export type GroupChange =
  | { kind: 'listen'; botId: string; enabled: boolean }
  | { kind: 'add' | 'remove'; botId: string }
  | { kind: 'retry'; postId: string; botId: string }
  | { kind: 'delete' };

export async function botGroupRequest<T>(path = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await runtimeFetch(`/api/harness/bots/group-chats${path}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}

export async function uploadBotGroupFile(groupPath: string, id: string, file: File): Promise<GroupChatFile> {
  const query = new URLSearchParams({ id, filename: file.name, mimeType: file.type, byteLength: String(file.size) });
  const response = await runtimeFetch(`/api/harness/bots/group-chats${groupPath}/files?${query}`, {
    method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Unable to upload this file');
  return data as GroupChatFile;
}

export async function downloadBotGroupFile(groupPath: string, id: string): Promise<Blob> {
  const response = await runtimeFetch(`/api/harness/bots/group-chats${groupPath}/files/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error('Unable to download this file');
  return response.blob();
}
