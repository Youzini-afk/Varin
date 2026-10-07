import { runtimeFetch } from '@varin/application-client';
import type { FollowUpDefinitionView, FollowUpRegisterParams, FollowUpRegisterResult, FollowUpSource } from '@varin/protocol';

export async function saveFollowUp(
  sessionId: string,
  input: Pick<FollowUpRegisterParams, 'instruction'> & { source?: FollowUpSource },
  existing?: Pick<FollowUpDefinitionView, 'id' | 'revision'>,
): Promise<{ followUp: FollowUpDefinitionView; firedImmediately?: boolean }> {
  const base = `/api/harness/sessions/${encodeURIComponent(sessionId)}/follow-ups`;
  const response = await runtimeFetch(existing ? `${base}/${encodeURIComponent(existing.id)}/update` : base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, ...(existing ? { expectedRevision: existing.revision } : { pause: false }) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Follow-up save failed (${response.status})`);
  if (!body?.followUp?.id) throw new Error('Invalid follow-up save response');
  return body as FollowUpRegisterResult;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isFollowUp = (entry: unknown): entry is FollowUpDefinitionView => (
  isRecord(entry) && typeof entry.id === 'string' && typeof entry.sessionId === 'string'
  && typeof entry.status === 'string' && ['waiting', 'triggered', 'delivered', 'cancelled', 'superseded', 'unavailable'].includes(entry.status)
  && typeof entry.revision === 'string'
  && typeof entry.waitingSummary === 'string' && typeof entry.instruction === 'string'
);

export async function fetchFollowUps(options: { sessionId?: string; includeInactive?: boolean; signal?: AbortSignal } = {}): Promise<FollowUpDefinitionView[] | null> {
  const path = options.sessionId
    ? `/api/harness/sessions/${encodeURIComponent(options.sessionId)}/follow-ups`
    : '/api/harness/follow-ups';
  const response = await runtimeFetch(`${path}${options.includeInactive ? '?includeInactive=true' : ''}`, {
    cache: 'no-store', signal: options.signal,
  });
  if (response.status === 404 && options.sessionId) return null;
  if (!response.ok) throw new Error(`Follow-up list failed (${response.status})`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.followUps) || !body.followUps.every(isFollowUp)) throw new Error('Invalid follow-up list response');
  return body.followUps as FollowUpDefinitionView[];
}

export async function postFollowUpAction(
  sessionId: string,
  id: string,
  action: 'cancel' | 'check' | 'fire',
  expectedRevision?: string,
): Promise<FollowUpDefinitionView> {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(id)}/${action}`,
    {
      method: 'POST', cache: 'no-store',
      ...(expectedRevision === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision }),
      }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : `${action} failed (${response.status})`);
  }
  if (!isRecord(body) || !isFollowUp(body.followUp) || body.followUp.id !== id) throw new Error('Invalid follow-up action response');
  return body.followUp;
}
