import type { ThreadIdentity } from '@varin/application-client';
import type { DeepLinkIntent } from './deepLinks';

type ThreadIntent = Extract<DeepLinkIntent, { type: 'thread' }>;
interface ThreadDeepLinkRuntime {
  currentHostKey(): string;
  currentRuntimeKey(): string;
  endpointGeneration(): number;
  isCurrent(): boolean;
  connectHost(hostKey: string): Promise<boolean>;
  loadCatalog(): Promise<unknown>;
  openThread(target: { threadId: string; branchId: string; directory: string | null }): Promise<ThreadIdentity>;
  openInstances(): void;
}
/** A notification may switch transports, but never resolve its IDs against another Host. */
export async function followThreadDeepLink(intent: ThreadIntent, runtime: ThreadDeepLinkRuntime): Promise<void> {
  if (intent.hostKey !== runtime.currentHostKey() && !await runtime.connectHost(intent.hostKey)) {
    if (runtime.isCurrent()) runtime.openInstances();
    return;
  }
  if (!runtime.isCurrent()) return;
  const generation = runtime.endpointGeneration();
  const host: unknown = JSON.parse(intent.hostKey);
  if (!Array.isArray(host) || host[1] !== runtime.currentRuntimeKey()) return;
  await runtime.loadCatalog();
  if (!runtime.isCurrent() || generation !== runtime.endpointGeneration() || host[1] !== runtime.currentRuntimeKey()) return;
  await runtime.openThread({ threadId: intent.threadId, branchId: intent.branchId, directory: intent.directory ?? null });
}
