import { runtimeFetch } from '@varin/application-client';
import type { LocalSemanticStatus } from '@varin/protocol';

const LOCAL_SEMANTIC_ENDPOINT = '/api/harness/local-semantic';

const isStatus = (value: unknown): value is LocalSemanticStatus['status'] => (
  value === 'not-installed' || value === 'installing' || value === 'ready' || value === 'failed'
);

/** Validate the small host response before it reaches the settings view. */
export function parseLocalSemanticStatus(value: unknown): LocalSemanticStatus {
  if (!value || typeof value !== 'object' || !isStatus((value as { status?: unknown }).status)) {
    throw new Error('Invalid local semantic status');
  }
  return value as LocalSemanticStatus;
}

async function responseError(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json() as unknown;
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      const message = (body as { error: string }).error.trim();
      if (message) return message;
    }
  } catch {
    // Some host failures have no JSON body; use the status below.
  }
  return null;
}

async function checkResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const message = await responseError(response);
    throw new Error(message ?? `Local semantic request failed (${response.status})`);
  }
}

export async function getLocalSemanticStatus(signal?: AbortSignal): Promise<LocalSemanticStatus> {
  const response = await runtimeFetch(LOCAL_SEMANTIC_ENDPOINT, { cache: 'no-store', signal });
  await checkResponse(response);
  return parseLocalSemanticStatus(await response.json());
}

export async function installLocalSemantic(): Promise<void> {
  await checkResponse(await runtimeFetch(`${LOCAL_SEMANTIC_ENDPOINT}/install`, { method: 'POST' }));
}

export async function importLocalSemantic(file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  await checkResponse(await runtimeFetch(`${LOCAL_SEMANTIC_ENDPOINT}/import`, { method: 'POST', body: form }));
}

export async function cancelLocalSemantic(): Promise<void> {
  await checkResponse(await runtimeFetch(`${LOCAL_SEMANTIC_ENDPOINT}/cancel`, { method: 'POST' }));
}
