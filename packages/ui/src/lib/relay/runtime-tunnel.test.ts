import { expect, test } from 'vitest';
import { activateRelayTunnel, deactivateRelayTunnel } from '@varin/application-client';
import { getActiveRelayDescriptor } from './runtime-tunnel';
import { registerRelayTransport } from './register-transport';

test('the registered UI relay lifecycle exposes a detached public descriptor, never its one-time grant', () => {
  const descriptor = {
    relayUrl: 'wss://relay.example.com', serverId: 'server-registered',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' }, grant: 'one-time-secret',
  };
  registerRelayTransport();
  try {
    activateRelayTunnel(descriptor);
    const publicDescriptor = {
      relayUrl: descriptor.relayUrl, serverId: descriptor.serverId, hostEncPubJwk: descriptor.hostEncPubJwk,
    };
    expect(getActiveRelayDescriptor()).toEqual(publicDescriptor);
    const exposed = getActiveRelayDescriptor()!;
    exposed.hostEncPubJwk.x = 'changed-by-consumer';
    expect(getActiveRelayDescriptor()).toEqual(publicDescriptor);
  } finally {
    deactivateRelayTunnel();
  }
  expect(getActiveRelayDescriptor()).toBeNull();
});
