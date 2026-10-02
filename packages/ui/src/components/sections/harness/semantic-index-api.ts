import { runtimeFetch } from '@varin/application-client';

const endpoint = '/api/harness/semantic-index';

export interface SemanticIndexConfig {
  storageDirectory: string | null;
  concurrentRequests: number;
  requestIntervalMs: number;
  includeIgnoredDirectories?: string[];
}

export interface SemanticIndexStatus {
  directories: {
    revision: string;
    entries: Array<{ path: string; workspaceId: string; state: 'active' | 'paused' | 'deleting';
      project: boolean; manual: boolean; lastCheckedAt?: number; error?: string; checking: boolean; busy: boolean; cacheOnly?: boolean }>;
  };
  config: SemanticIndexConfig;
  activeConfig: SemanticIndexConfig;
  revision: string;
  activeDirectory: string;
  configuredDirectory: string;
  restartRequired: boolean;
  configError?: string;
  bytes: number;
  retained: Array<{ directory: string; bytes: number; active: boolean }>;
  roots: Array<{
    workspaceId: string;
    root: string | null;
    binding: string;
    indexingEnabled: boolean;
    status: { status: string; coverage: string; lifecycle: string };
    progress: { phase: string; processedFiles: number; totalFiles: number; publishedDocuments: number; error?: string;
      coverageStats?: { visibleFiles: number; candidateFiles: number; structurallySupportedFiles: number; textFallbackFiles: number; unsupportedFiles: number;
        inventories: Array<{ root: string; strategy: 'git-visible' | 'directory'; gitRoot?: string; selectedRootIgnored?: boolean }> };
    } | null;
  }>;
}

async function check(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  throw new Error(typeof body?.error === 'string' ? body.error : `Index settings request failed (${response.status})`);
}

export async function manageIndexDirectory(action: 'add' | 'pause' | 'resume' | 'check' | 'remove', directory: string, revision: string): Promise<void> {
  await check(await runtimeFetch(`${endpoint}/directories`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, directory, revision }) }));
}

export async function readSemanticIndexStatus(signal?: AbortSignal): Promise<SemanticIndexStatus> {
  const response = await runtimeFetch(endpoint, { cache: 'no-store', signal });
  await check(response);
  const body = await response.json() as SemanticIndexStatus;
  if (!body || !body.config || !Array.isArray(body.roots) || !Array.isArray(body.retained) || typeof body.revision !== 'string'
    || typeof body.activeDirectory !== 'string' || !Number.isFinite(body.bytes)) {
    throw new Error('Invalid index status response');
  }
  return body;
}

export async function saveSemanticIndexConfig(config: SemanticIndexConfig, revision: string): Promise<void> {
  await check(await runtimeFetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, revision }),
  }));
}

export async function removeRetainedSemanticIndex(directory: string, revision: string): Promise<void> {
  await check(await runtimeFetch(`${endpoint}/cache`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, revision }),
  }));
}
