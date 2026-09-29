import { expect, it } from 'vitest';
import { createVmGuestRegistration } from './vm-guest-register.js';

it('registers a scoped guest client once and reuses its token on retry', async () => {
  let settings: Record<string, unknown> = { desktopHosts: [{ id: 'other', apiUrl: 'http://other' }] };
  let issued = 0;
  const registration = createVmGuestRegistration({
    readSettings: async () => settings,
    updateSettings: async (mutator) => { settings = mutator(settings); },
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/session')) {
        expect(JSON.parse(String(init?.body)).password).toBe('secret');
        return Response.json({ authenticated: true }, { headers: { 'Set-Cookie': 'varin_ui_session=good; Path=/; HttpOnly' } });
      }
      if (url.endsWith('/api/client-auth/clients')) {
        expect(new Headers(init?.headers).get('Cookie')).toBe('varin_ui_session=good');
        issued++;
        return Response.json({ token: 'varin_client_1' }, { status: 201 });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer varin_client_1');
      return Response.json({ desktops: [] }, { headers: { 'X-Varin-Computer-Host': 'guest-h' } });
    }) as typeof fetch,
  });
  const input = { connectionId: 'vm:uuid', label: 'Office', apiUrl: 'http://192.168.122.2:8765',
    password: 'secret', hostId: 'guest-h', version: '0.9.21' };
  await registration.register(input);
  await registration.register(input);
  expect(issued).toBe(1);
  expect((settings.desktopHosts as Array<{ id: string }>).map((host) => host.id)).toEqual(['other', 'vm:uuid']);
  await registration.remove(input.connectionId);
  expect((settings.desktopHosts as Array<{ id: string }>).map((host) => host.id)).toEqual(['other']);
});
