import type { HistoryItem } from '@varin/protocol';
import type { ThreadIdentity } from './threads.js';
/** A frozen selection in native message text, using UTF-16 offsets. */
export interface ChatMemoryPassage {
  entryId: string;
  start: number;
  text: string;
  revision?: string;
}

export interface ChatMemoryOwner {
  scope: 'workspace' | 'bot' | 'session' | 'user';
  ownerId: string | null;
}

export type ChatMemoryNature = 'experience' | 'decision' | 'preference' | 'judgment' | 'instruction';

export interface ChatMemoryDraft {
  content: string;
  trigger: string;
  nature?: ChatMemoryNature;
  sources: ChatMemoryPassage[];
}

export interface ChatMemoryExtraction {
  owner: ChatMemoryOwner;
  drafts: ChatMemoryDraft[];
}

export interface ChatMemoryReceipt {
  created: boolean;
  owner: ChatMemoryOwner;
  item: {
    id: number;
    content: string;
    trigger: string;
    status: 'suggested' | 'accepted' | 'dismissed';
    invalidAt?: number;
  };
}

/** Original runtime history; item IDs are never interpreted as Pi entry IDs. */
export interface ThreadMemoryPassage {
  itemId: string;
  start: number;
  text: string;
  revision?: string;
}
export interface ThreadMemoryDraft {
  content: string;
  trigger: string;
  nature?: ChatMemoryNature;
  sources: ThreadMemoryPassage[];
}
export interface ThreadMemorySelection extends ThreadIdentity {
  headId: string;
}
export interface ThreadMemoryAPI {
  preview(input: ThreadMemorySelection & { requestKey: string; retryOf?: string; sources: ThreadMemoryPassage[] }, signal?: AbortSignal): Promise<{ owner: ChatMemoryOwner; requestKey: string; drafts: ThreadMemoryDraft[] }>;
  save(input: ThreadMemorySelection & { target: 'owner' | 'user'; expectedOwner: ChatMemoryOwner; draft: ThreadMemoryDraft }): Promise<ChatMemoryReceipt>;
  undo(input: ThreadMemorySelection & { target: 'owner' | 'user'; expectedOwner: ChatMemoryOwner; id: number; expected: { content: string; trigger: string; status: 'accepted'; invalidAt: number | null } }): Promise<{ undone: true }>;
}

/** Canonical original UTF-16 text used by both selection presentation and source validation. */
export function threadMemorySourceText(item: Pick<HistoryItem, 'source' | 'content'>): string {
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (item.source === 'user') return typeof item.content === 'string' ? item.content : typeof object(item.content).text === 'string' ? object(item.content).text as string : '';
  const content = object(object(item.content).content);
  if (content.kind === 'text' && typeof content.text === 'string') return content.text;
  const output = content.kind === 'output' ? object(content.output)
    : content.kind === 'tool_result' ? object(object(object(content.result).completion).content) : {};
  return Array.isArray(output.parts) ? output.parts.map(object).filter(part => part.kind === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}
