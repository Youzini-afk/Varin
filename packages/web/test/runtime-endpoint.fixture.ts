import { getRuntimeEndpointGeneration, refreshRuntimeUrlAuthToken } from '@varin/application-client';
import { afterEach, beforeEach, vi } from 'vitest';

/** Keep endpoint-switch auth work separate from the API response under test. */
export function installRuntimeEndpointFetchFixture() {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  let generation: number;

  beforeEach(() => {
    generation = getRuntimeEndpointGeneration();
    fetchMock.mockReset().mockImplementation(async () => {
      throw new Error('Unexpected request outside an active fetch fixture');
    });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (init.method === 'POST' && new URL(url, 'http://fixture.invalid').pathname === '/auth/url-token') {
        return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
      }
      return fetchMock(url, init);
    });
  });

  afterEach(async () => {
    try {
      if (getRuntimeEndpointGeneration() !== generation) {
        // Join the switch's shared mint before restoring native fetch. Its
        // credential lookup and response read both continue asynchronously.
        await refreshRuntimeUrlAuthToken();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  return fetchMock;
}
