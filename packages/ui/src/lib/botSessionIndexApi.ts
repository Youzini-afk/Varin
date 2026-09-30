import { runtimeFetch } from '@varin/application-client';

export const listBotSessionIds = async (): Promise<string[]> => {
  const response = await runtimeFetch('/api/harness/bots/session-ids');
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : 'Unable to list Bot conversations');
  }
  const result = await response.json() as { sessionIds?: unknown };
  if (!Array.isArray(result.sessionIds) || !result.sessionIds.every((id) => typeof id === 'string')) {
    throw new Error('Invalid Bot conversation index');
  }
  return result.sessionIds;
};
