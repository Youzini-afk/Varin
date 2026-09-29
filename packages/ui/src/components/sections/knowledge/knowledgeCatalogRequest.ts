import { runtimeFetch } from '@varin/application-client';
import type { MemorySourceExcerpt } from '@varin/protocol';

export type KnowledgeCatalogScope = 'workspace' | 'user' | 'bot';
export type KnowledgeCatalogStatus = 'suggested' | 'accepted' | 'dismissed';
export type KnowledgeCatalogNature = 'experience' | 'decision' | 'preference' | 'judgment' | 'instruction';
const KNOWLEDGE_NATURES: readonly KnowledgeCatalogNature[] = ['experience', 'decision', 'preference', 'judgment', 'instruction'];

export interface KnowledgeCatalogSource {
  kind: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  entryId?: string;
}

export interface KnowledgeCatalogItem {
  id: number;
  scope: KnowledgeCatalogScope;
  status: KnowledgeCatalogStatus;
  content: string;
  trigger: string;
  nature?: KnowledgeCatalogNature;
  createdAt: number;
  invalidAt?: number;
  recallCount: number;
  recalledAt?: number;
  source?: KnowledgeCatalogSource;
}

export interface KnowledgeCatalogChain {
  current: KnowledgeCatalogItem;
  predecessors: KnowledgeCatalogItem[];
  successors: KnowledgeCatalogItem[];
  chain: KnowledgeCatalogItem[];
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const scopeOf = (value: unknown): KnowledgeCatalogScope | null => (
  value === 'workspace' || value === 'user' || value === 'bot' ? value : null
);

const statusOf = (value: unknown): KnowledgeCatalogStatus | null => (
  value === 'suggested' || value === 'accepted' || value === 'dismissed' ? value : null
);

export const parseKnowledgeCatalogItem = (value: unknown): KnowledgeCatalogItem => {
  const item = recordOf(value);
  const scope = scopeOf(item?.scope);
  const status = statusOf(item?.status);
  const source = recordOf(item?.source);
  if (
    !item
    || !scope
    || !status
    || !Number.isSafeInteger(item.id)
    || Number(item.id) <= 0
    || typeof item.content !== 'string'
    || typeof item.trigger !== 'string'
    || typeof item.createdAt !== 'number'
    || !Number.isFinite(item.createdAt)
    || typeof item.recallCount !== 'number'
    || (item.invalidAt !== undefined && (typeof item.invalidAt !== 'number' || !Number.isFinite(item.invalidAt)))
    || (item.recalledAt !== undefined && (typeof item.recalledAt !== 'number' || !Number.isFinite(item.recalledAt)))
    || (source !== null && typeof source.kind !== 'string')
  ) throw new Error('Malformed knowledge catalog item');
  const nature = typeof item.nature === 'string' && (KNOWLEDGE_NATURES as readonly string[]).includes(item.nature)
    ? item.nature as KnowledgeCatalogNature
    : undefined;
  const pickSourceField = (key: string) => typeof source?.[key] === 'string' && source[key] ? source[key] as string : undefined;
  return {
    id: Number(item.id),
    scope,
    status,
    content: item.content,
    trigger: item.trigger,
    ...(nature ? { nature } : {}),
    createdAt: item.createdAt,
    recallCount: item.recallCount,
    ...(typeof item.invalidAt === 'number' ? { invalidAt: item.invalidAt } : {}),
    ...(typeof item.recalledAt === 'number' ? { recalledAt: item.recalledAt } : {}),
    ...(source ? {
      source: {
        kind: source.kind as string,
        ...(pickSourceField('sessionId') ? { sessionId: pickSourceField('sessionId')! } : {}),
        ...(pickSourceField('threadId') ? { threadId: pickSourceField('threadId')! } : {}),
        ...(pickSourceField('runId') ? { runId: pickSourceField('runId')! } : {}),
        ...(pickSourceField('entryId') ? { entryId: pickSourceField('entryId')! } : {}),
      },
    } : {}),
  };
};

export const parseKnowledgeCatalogList = (value: unknown): KnowledgeCatalogItem[] => {
  const response = recordOf(value);
  if (!response || !Array.isArray(response.items)) throw new Error('Malformed knowledge catalog list');
  return response.items.map(parseKnowledgeCatalogItem);
};

export const parseKnowledgeCatalogChain = (value: unknown): KnowledgeCatalogChain => {
  const response = recordOf(value);
  const chain = recordOf(response?.chain) ?? response;
  if (
    !chain
    || !Array.isArray(chain.predecessors)
    || !Array.isArray(chain.successors)
    || !Array.isArray(chain.chain)
  ) throw new Error('Malformed knowledge supersede chain');
  return {
    current: parseKnowledgeCatalogItem(chain.current),
    predecessors: chain.predecessors.map(parseKnowledgeCatalogItem),
    successors: chain.successors.map(parseKnowledgeCatalogItem),
    chain: chain.chain.map(parseKnowledgeCatalogItem),
  };
};

const workspaceQuery = (scope: KnowledgeCatalogScope, workspaceId?: string): string => {
  const params = new URLSearchParams({ scope });
  // workspaceId carries the owner address for scoped stores: the workspace id
  // for `workspace`, and `bot:<id>` for `bot`.
  if ((scope === 'workspace' || scope === 'bot') && workspaceId) params.set('workspaceId', workspaceId);
  return params.toString();
};

const workspaceBody = (scope: KnowledgeCatalogScope, workspaceId?: string): Record<string, string> => (
  (scope === 'workspace' || scope === 'bot') && workspaceId ? { workspaceId } : {}
);

const readError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    /* keep status text */
  }
  return `Knowledge request failed (${response.status})`;
};

export async function loadKnowledgeCatalog(
  scope: KnowledgeCatalogScope,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<KnowledgeCatalogItem[]> {
  const response = await runtimeFetch(`/api/harness/knowledge?${workspaceQuery(scope, workspaceId)}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseKnowledgeCatalogList(await response.json());
}

export async function loadKnowledgeChain(
  scope: KnowledgeCatalogScope,
  id: number,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<KnowledgeCatalogChain> {
  const query = workspaceQuery(scope, workspaceId);
  const response = await runtimeFetch(`/api/harness/knowledge/${scope}/${id}/chain?${query}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseKnowledgeCatalogChain(await response.json());
}

export async function loadKnowledgeSources(scope: KnowledgeCatalogScope, id: number, workspaceId?: string, signal?: AbortSignal): Promise<MemorySourceExcerpt[]> {
  const response = await runtimeFetch(`/api/harness/knowledge/${scope}/${id}/sources?${workspaceQuery(scope, workspaceId)}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { sources?: MemorySourceExcerpt[] };
  if (!Array.isArray(body.sources)) throw new Error('Malformed memory source response');
  return body.sources;
}

export async function saveKnowledgeCatalogItem(
  item: KnowledgeCatalogItem,
  draft: { content: string; trigger: string },
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await runtimeFetch(`/api/harness/knowledge/${item.scope}/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workspaceBody(item.scope, workspaceId),
      content: draft.content,
      trigger: draft.trigger,
      expectedContent: item.content,
      expectedTrigger: item.trigger,
      expectedStatus: item.status,
      expectedInvalidAt: item.invalidAt ?? null,
    }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 409) throw Object.assign(new Error('conflict'), { code: 'conflict' });
  if (!response.ok) throw new Error(await readError(response));
}

export async function retireKnowledgeCatalogItem(
  item: KnowledgeCatalogItem,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await runtimeFetch(`/api/harness/knowledge/${item.scope}/${item.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workspaceBody(item.scope, workspaceId),
      expectedContent: item.content,
      expectedTrigger: item.trigger,
      expectedStatus: item.status,
      expectedInvalidAt: item.invalidAt ?? null,
    }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 409) throw Object.assign(new Error('conflict'), { code: 'conflict' });
  if (!response.ok) throw new Error(await readError(response));
}

export async function reviewKnowledgeCatalogItem(
  item: KnowledgeCatalogItem,
  action: 'accept' | 'dismiss',
  workspaceId?: string,
  supersedes: number[] = [],
  signal?: AbortSignal,
): Promise<void> {
  const response = await runtimeFetch(`/api/harness/knowledge/${item.scope}/${item.id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workspaceBody(item.scope, workspaceId),
      supersedes,
      expectedContent: item.content,
      expectedTrigger: item.trigger,
      expectedStatus: item.status,
      expectedInvalidAt: item.invalidAt ?? null,
    }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 409) throw Object.assign(new Error('conflict'), { code: 'conflict' });
  if (!response.ok) throw new Error(await readError(response));
}

// ── Background organizer status (BC2) ──────────────────────────────

export type OrganizerProgressStatus = 'pending' | 'processing' | 'prepared' | 'formed' | 'reviewed-empty' | 'failed';

export interface OrganizerProgressRow {
  key: string;
  status: OrganizerProgressStatus;
  produced?: number[];
  updatedAt: number;
  lastError?: string;
}

export interface OrganizerStatus {
  enabled: boolean;
  model: { providerId: string; modelId: string } | null;
  rows: OrganizerProgressRow[];
}

const ORGANIZER_STATUSES: readonly OrganizerProgressStatus[] = [
  'pending', 'processing', 'prepared', 'formed', 'reviewed-empty', 'failed',
];

export const parseOrganizerStatus = (value: unknown): OrganizerStatus => {
  const response = recordOf(value);
  if (!response || typeof response.enabled !== 'boolean' || !Array.isArray(response.rows)) {
    throw new Error('Malformed organizer status');
  }
  const model = recordOf(response.model);
  return {
    enabled: response.enabled,
    model: model && typeof model.providerId === 'string' && typeof model.modelId === 'string'
      ? { providerId: model.providerId, modelId: model.modelId }
      : null,
    rows: response.rows.flatMap((raw) => {
      const row = recordOf(raw);
      const status = ORGANIZER_STATUSES.find((candidate) => candidate === row?.status);
      if (!row || typeof row.key !== 'string' || !status || typeof row.updatedAt !== 'number') return [];
      return [{
        key: row.key,
        status,
        ...(Array.isArray(row.produced) ? { produced: row.produced.filter(Number.isSafeInteger) as number[] } : {}),
        updatedAt: row.updatedAt,
        ...(typeof row.lastError === 'string' ? { lastError: row.lastError } : {}),
      }];
    }),
  };
};

export async function loadOrganizerStatus(
  scope: KnowledgeCatalogScope,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<OrganizerStatus> {
  const response = await runtimeFetch(`/api/harness/knowledge/organizer?${workspaceQuery(scope, workspaceId)}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseOrganizerStatus(await response.json());
}

export async function retryOrganizerScope(
  scope: KnowledgeCatalogScope,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await runtimeFetch('/api/harness/knowledge/organizer/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ...workspaceBody(scope, workspaceId) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
}
