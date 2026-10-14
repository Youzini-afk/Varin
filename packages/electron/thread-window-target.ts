export interface ThreadWindowIdentity { threadId: string; branchId: string; directory: string | null }
export interface ThreadWindowHost { apiBaseUrl?: string | undefined; relayHostId?: string | undefined }
const endpoint = (value?: string) => {
  if (!value) return '';
  try { const url = new URL(value); url.hash = ''; return url.toString().replace(/\/$/, ''); } catch { return value; }
};
export const runtimeTargetKey = (host: ThreadWindowHost): string => JSON.stringify([endpoint(host.apiBaseUrl), host.relayHostId ?? '']);
export const threadWindowKey = (host: ThreadWindowHost, target: Pick<ThreadWindowIdentity, 'threadId' | 'branchId'>): string =>
  JSON.stringify([runtimeTargetKey(host), target.threadId, target.branchId]);
export const threadMiniChatUrl = (base: string, target: { mode: 'draft' | 'thread'; threadId?: string | undefined; branchId?: string | undefined; directory?: string | undefined; projectId?: string | undefined }): string => {
  if (target.mode === 'thread' && (!target.threadId || !target.branchId)) throw new Error('Thread and branch ids are required');
  const url = new URL(base); url.searchParams.set('mode', target.mode);
  for (const name of ['threadId', 'branchId', 'directory', 'projectId'] as const) if (target[name]) url.searchParams.set(name, target[name]);
  return url.toString();
};

/** Queue before a Host switch: the new renderer cannot receive events until it is ready. */
export async function routeThreadWindow<Window, Host extends ThreadWindowHost>(target: ThreadWindowIdentity, host: Host, owner: {
  current(): Window | null; host(window: Window): Host; loading(window: Window): boolean;
  activate(host: Host): Promise<unknown>; focus(window: Window): void;
  queue(target: ThreadWindowIdentity, host: Host): void; emit(window: Window, target: ThreadWindowIdentity, host: Host): void;
}): Promise<void> {
  if (!target.threadId || !target.branchId) throw new Error('Thread and branch ids are required');
  const window = owner.current();
  if (!window || runtimeTargetKey(owner.host(window)) !== runtimeTargetKey(host)) {
    owner.queue(target, host);
    await owner.activate(host);
    return;
  }
  owner.focus(window);
  if (owner.loading(window)) owner.queue(target, host); else owner.emit(window, target, host);
}
