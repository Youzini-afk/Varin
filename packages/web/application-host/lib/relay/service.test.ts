import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { RelayUnavailableError, resolveRelayEndpoint, type RelayEndpoint } from './endpoint.js';
import { createRelayService } from './service.js';

type Settings = Record<string, unknown>;

const createService = (initial: Settings, endpoint: RelayEndpoint, demand = false) => {
  let settings: Settings = structuredClone(initial);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = createRelayService({
    crypto,
    getLocalPort: () => 3000,
    hasRelayDemand: async () => demand,
    logger,
    readSettingsFromDisk: async () => structuredClone(settings),
    resolveEndpoint: () => endpoint,
    updateSettingsOnDisk: async (mutator) => {
      settings = mutator(structuredClone(settings));
      return structuredClone(settings);
    },
  });
  const app = express();
  service.registerRoutes(app);
  return { service, app, logger, settings: () => settings };
};

describe('relay endpoint', () => {
  it('comes only from VARIN_RELAY_URL and keeps missing and invalid apart', () => {
    expect(resolveRelayEndpoint({})).toEqual({ state: 'missing' });
    expect(resolveRelayEndpoint({ VARIN_RELAY_URL: '   ' })).toEqual({ state: 'missing' });
    expect(resolveRelayEndpoint({ VARIN_RELAY_URL: 'https://relay.example.net/ws' })).toEqual({ state: 'invalid' });
    expect(resolveRelayEndpoint({ VARIN_RELAY_URL: 'not a url' })).toEqual({ state: 'invalid' });
    expect(resolveRelayEndpoint({ VARIN_RELAY_URL: ' wss://relay.example.net/ws ' }))
      .toEqual({ state: 'configured', url: 'wss://relay.example.net/ws' });
  });
});

describe('relay service without an endpoint', () => {
  it('refuses Anywhere pairing and leaves the relay off', async () => {
    const { service, settings } = createService({}, { state: 'missing' });

    const failure = await service.ensureEnabledForPairing().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayUnavailableError);
    expect((failure as RelayUnavailableError).code).toBe('relay_unconfigured');
    expect(settings().privateRelay).toBeUndefined();
    expect(await service.getPairingCandidate()).toBeNull();
  });

  it('ignores a relay URL kept in settings and drops it on the next write', async () => {
    const { service, settings } = createService(
      { privateRelay: { enabled: true, relayUrl: 'wss://relay.example.net/ws' } },
      { state: 'missing' },
    );

    expect(await service.getPairingCandidate()).toBeNull();
    const status = await service.getStatus();
    expect(status).toMatchObject({ enabled: true, state: 'unavailable', endpoint: 'missing', relayUrl: null });
    expect(status.lastError).toContain('VARIN_RELAY_URL');

    await service.reconcile();
    expect(settings().privateRelay).toEqual({ enabled: false });
  });

  it('reports demand it cannot serve once, without dialing anywhere', async () => {
    const { service, settings, logger } = createService({}, { state: 'invalid' }, true);

    await service.reconcile();
    await service.reconcile();

    expect(settings().privateRelay).toEqual({ enabled: true });
    expect(await service.getStatus()).toMatchObject({ state: 'unavailable', endpoint: 'invalid', relayUrl: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain('not a ws:// or wss:// URL');
    service.stop();
  });

  it('answers the management routes with the reason', async () => {
    const { app, settings } = createService({}, { state: 'missing' });

    const enable = await request(app).post('/api/varin/relay/enable').send({}).expect(409);
    expect(enable.body).toEqual({ error: expect.stringContaining('VARIN_RELAY_URL'), code: 'relay_unconfigured' });

    await request(app).post('/api/varin/relay/enable').send({ relayUrl: 'wss://relay.example.net/ws' }).expect(400);
    expect(settings().privateRelay).toBeUndefined();

    const status = await request(app).get('/api/varin/relay/status').expect(200);
    expect(status.body).toMatchObject({ enabled: false, state: 'disabled', endpoint: 'missing', relayUrl: null });
  });
});

describe('relay service with an endpoint', () => {
  it('advertises the configured relay once the relay is enabled', async () => {
    const endpoint = { state: 'configured', url: 'wss://relay.example.net/ws' } as const;
    const off = createService({}, endpoint);
    expect(await off.service.getPairingCandidate()).toBeNull();

    const on = createService({ privateRelay: { enabled: true } }, endpoint);
    const candidate = await on.service.getPairingCandidate();
    expect(candidate).toMatchObject({ type: 'relay', relayUrl: 'wss://relay.example.net/ws', priority: 30 });
    expect(candidate?.serverId).toBe(await on.service.getServerId());
    expect(await on.service.getStatus()).toMatchObject({ endpoint: 'configured', relayUrl: 'wss://relay.example.net/ws' });
  });
});
