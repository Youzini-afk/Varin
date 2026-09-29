import { HarnessServiceError } from '../harness/service-error.js';

interface GuestConnection {
  id: string;
  label: string;
  apiUrl: string;
  clientToken: string;
}
type Document = Record<string, unknown>;
const hostsOf = (document: Document): GuestConnection[] => Array.isArray(document.desktopHosts)
  ? document.desktopHosts.filter((item): item is GuestConnection => typeof item === 'object' && item !== null
    && typeof item.id === 'string' && typeof item.apiUrl === 'string'
    && typeof item.clientToken === 'string') : [];

export function createVmGuestRegistration(options: {
  readSettings(): Promise<Document>;
  updateSettings(mutator: (current: Document) => Document): Promise<unknown>;
  fetch?: typeof fetch;
}) {
  const fetchImpl = options.fetch ?? fetch;
  const register = async (input: { connectionId: string; label: string; apiUrl: string; password: string;
    hostId: string }): Promise<void> => {
    const existing = hostsOf(await options.readSettings()).find((host) => host.id === input.connectionId);
    let token: string | undefined;
    if (existing?.clientToken) {
      const probe = await fetchImpl(`${input.apiUrl}/api/computers?local=1`, {
        headers: { Authorization: `Bearer ${existing.clientToken}`, 'X-Varin-Computer-Host': input.hostId },
        redirect: 'error',
      }).catch(() => null);
      if (probe?.ok && probe.headers.get('x-varin-computer-host') === input.hostId) token = existing.clientToken;
      await probe?.body?.cancel();
    }
    if (!token) {
      const login = await fetchImpl(`${input.apiUrl}/auth/session`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.password }) });
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
      if (!login.ok || !cookie?.startsWith('varin_ui_session=')) {
        throw new HarnessServiceError('unavailable', 'Guest Host rejected its saved bootstrap credential');
      }
      const created = await fetchImpl(`${input.apiUrl}/api/client-auth/clients`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ label: `VM ${input.label}`, clientKind: 'vm-coordinator',
          dedupeKey: input.connectionId, profile: 'full-control' }) });
      const body = await created.json().catch(() => null) as { token?: unknown } | null;
      if (!created.ok || typeof body?.token !== 'string' || !body.token.startsWith('varin_client_')) {
        throw new HarnessServiceError('unavailable', 'Guest Host did not issue a coordinator client token');
      }
      token = body.token;
    }
    await options.updateSettings((current) => {
      const other = (Array.isArray(current.desktopHosts) ? current.desktopHosts : [])
        .filter((item) => !(item && typeof item === 'object' && (item as { id?: unknown }).id === input.connectionId));
      return { ...current, desktopHosts: [...other,
        { id: input.connectionId, label: input.label, apiUrl: input.apiUrl, clientToken: token }] };
    });
  };
  const remove = (connectionId: string) => options.updateSettings((current) => ({ ...current,
    desktopHosts: (Array.isArray(current.desktopHosts) ? current.desktopHosts : [])
      .filter((item) => !(item && typeof item === 'object' && (item as { id?: unknown }).id === connectionId)),
  })).then(() => undefined);
  return { register, remove };
}
