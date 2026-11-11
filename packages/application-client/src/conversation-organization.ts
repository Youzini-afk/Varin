/** Catalog-owned navigation. None of these references grants content or file access. */
export type ConversationOrganizationRef = { kind: 'native' | 'external'; id: string };
export type ConversationOrganizationObject = { kind: 'container' | 'native' | 'external'; id: string };
export interface ConversationOrganizationPlacement { containerId: string | null }
/** Creation-time source intent. Later project/tree edits do not rewrite this original receipt. */
export interface ConversationCreationDefaults {
  projectId: string | null;
  source?: { resourceOwner: import('@varin/protocol').SourceResourceOwner; path: string; workspaceId?: string | null };
}
export interface ConversationOrganizationContainer {
  id: string; kind: 'group' | 'project'; parentId: string | null; order: number;
  revision: number; childrenRevision: number; name: string | null; icon: string | null;
  color: string | null; projectId: string | null;
}
export interface ConversationOrganizationPosition {
  conversation: ConversationOrganizationRef; containerId: string | null; order: number;
  revision: number; explicit: boolean; inheritedFrom: ConversationOrganizationRef | null;
}
export interface ConversationOrganizationEntry {
  conversation: ConversationOrganizationRef; title: string; archived: boolean; pinned: boolean;
  revision: number; position: ConversationOrganizationPosition;
  origin: { botId: string | null; conversation: ConversationOrganizationRef | null; directBotId: string | null };
  path: string[];
}
export interface ConversationOrganizationQuery {
  containerId?: string | null; rootOnly?: boolean; recursive?: boolean; query?: string;
  botId?: string; archived?: 'exclude' | 'include' | 'only'; limit?: number; cursor?: string;
}
export interface ConversationOrganizationSnapshot {
  initialized: boolean; revision: number; rootRevision: number; cursor: number;
  containers: ConversationOrganizationContainer[]; conversations: ConversationOrganizationEntry[]; nextCursor: string | null;
}
export interface ConversationOrganizationParentVersion { containerId: string | null; childrenRevision: number }
export type ConversationOrganizationOperation =
  | { action: 'create'; id: string; kind: 'group' | 'project'; parentId: string | null; name?: string | null; icon?: string | null; color?: string | null; projectId?: string | null; parents: ConversationOrganizationParentVersion[]; before?: ConversationOrganizationObject | null }
  | { action: 'update'; id: string; expectedRevision: number; name?: string | null; icon?: string | null; color?: string | null }
  | { action: 'move'; items: { object: ConversationOrganizationObject; expectedRevision: number; expectedParentId: string | null }[]; parentId: string | null; before?: ConversationOrganizationObject | null; parents: ConversationOrganizationParentVersion[] }
  | { action: 'dissolve'; id: string; expectedRevision: number; parents: ConversationOrganizationParentVersion[] }
  | { action: 'restore'; items: {object: ConversationOrganizationObject; expectedRevision: number; expectedParentId: string | null; parentId: string | null; before?: ConversationOrganizationObject | null; inherit: boolean}[]; parents: ConversationOrganizationParentVersion[] };
export interface ConversationOrganizationCommand { key: string; operation: ConversationOrganizationOperation }
export interface ConversationOrganizationReceipt {
  key: string; revision: number; cursor: number; containers: ConversationOrganizationContainer[];
  positions: ConversationOrganizationPosition[]; removed: string[];
}
export interface ConversationOrganizationEvent { cursor: number; subject: string; revision: number; kind: string; data: unknown }
export type ConversationOrganizationFailureCode = 'invalid_request' | 'forbidden' | 'not_found' | 'conflict' | 'projects_unavailable' | 'unavailable' | 'unknown_outcome' | 'invalid_response';
export class ConversationOrganizationError extends Error {
  constructor(readonly code: ConversationOrganizationFailureCode, message: string, readonly status = 400, readonly details?: unknown) { super(message); this.name = 'ConversationOrganizationError'; }
}
export interface ConversationOrganizationMetadataItem {
  conversation: ConversationOrganizationRef; expectedRevision: number;
  patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean };
}
export interface ConversationOrganizationMetadataResult {
  conversation: ConversationOrganizationRef;
  status: 'succeeded' | 'conflict' | 'busy' | 'failed' | 'unknown';
  result?: unknown; code?: string; message?: string;
}
export interface ConversationOrganizationProjectResult {
  projectId: string; registered: boolean; navigation: 'completed' | 'pending';
  receipt?: ConversationOrganizationReceipt;
  failure?: { code: ConversationOrganizationFailureCode; message: string };
}
export interface ConversationOrganizationAPI {
  /** The original Settings owner has already committed registration/removal. Never rolls it back. */
  project(input: { projectId: string; command: ConversationOrganizationCommand }, signal?: AbortSignal): Promise<ConversationOrganizationProjectResult>;
  read(query?: ConversationOrganizationQuery, signal?: AbortSignal): Promise<ConversationOrganizationSnapshot>;
  command(input: ConversationOrganizationCommand, signal?: AbortSignal): Promise<ConversationOrganizationReceipt>;
  metadata(input: { key: string; items: ConversationOrganizationMetadataItem[] }, signal?: AbortSignal): Promise<{ items: ConversationOrganizationMetadataResult[] }>;
  observe(cursor: number, listener: (event: ConversationOrganizationEvent) => void, options: { signal: AbortSignal }): Promise<void>;
}

export function parseConversationOrganizationPlacement(value: unknown): ConversationOrganizationPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConversationOrganizationError('invalid_request', 'Organization placement must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'containerId') || !(input.containerId === null || typeof input.containerId === 'string' && input.containerId.trim().length > 0))
    throw new ConversationOrganizationError('invalid_request', 'Organization placement requires an explicit containerId or null');
  return { containerId: input.containerId as string | null };
}

/** Validate metadata at the product boundary before a shared store publishes a generation. */
export function parseConversationOrganizationSnapshot(value: unknown): ConversationOrganizationSnapshot {
  const invalid = (): never => { throw new ConversationOrganizationError('invalid_response', 'Invalid conversation directory response', 502); };
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
  const number = (v: unknown) => { if (!Number.isSafeInteger(v) || Number(v) < 0) invalid(); };
  const nullable = (v: unknown) => { if (v !== null && typeof v !== 'string') invalid(); };
  const reference = (v: unknown) => { const r = record(v); if (!['native', 'external'].includes(String(r.kind)) || typeof r.id !== 'string' || !r.id) invalid(); };
  const root = record(value);
  if (typeof root.initialized !== 'boolean' || !Array.isArray(root.containers) || !Array.isArray(root.conversations)) invalid();
  for (const field of ['revision', 'rootRevision', 'cursor']) number(root[field]); nullable(root.nextCursor);
  const containers = root.containers as unknown[], conversations = root.conversations as unknown[];
  for (const raw of containers) {
    const c = record(raw); if (typeof c.id !== 'string' || !c.id || !['group', 'project'].includes(String(c.kind))) invalid();
    for (const field of ['revision', 'childrenRevision', 'order']) number(c[field]);
    for (const field of ['parentId', 'name', 'icon', 'color', 'projectId']) nullable(c[field]);
  }
  for (const raw of conversations) {
    const c = record(raw); reference(c.conversation); number(c.revision);
    if (typeof c.title !== 'string' || typeof c.archived !== 'boolean' || typeof c.pinned !== 'boolean' || !Array.isArray(c.path) || c.path.some(id => typeof id !== 'string')) invalid();
    const position = record(c.position); reference(position.conversation); nullable(position.containerId);
    for (const field of ['revision', 'order']) number(position[field]);
    if (typeof position.explicit !== 'boolean') invalid(); if (position.inheritedFrom !== null) reference(position.inheritedFrom);
    const origin = record(c.origin); nullable(origin.botId); nullable(origin.directBotId); if (origin.conversation !== null) reference(origin.conversation);
  }
  return value as ConversationOrganizationSnapshot;
}
