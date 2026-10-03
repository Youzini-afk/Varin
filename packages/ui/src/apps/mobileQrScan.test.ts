import { afterEach, describe, expect, test, vi } from 'vitest';

import { encodePairingConnectionPayload, buildPairingConnectionPayload } from '@/lib/connectionPayload';

import { parseConnectionPayload, scanConnectionQr } from './mobileQrScan';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;

describe('parseConnectionPayload', () => {
  test('parses bare http(s) URLs', () => {
    expect(parseConnectionPayload('https://oc.example')).toEqual({ url: 'https://oc.example' });
    expect(parseConnectionPayload('  http://192.168.1.10:2606 ')).toEqual({ url: 'http://192.168.1.10:2606' });
  });

  test('parses a v2 pairing link with direct + relay candidates', () => {
    const url = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'pair_abc',
      secret: 'one-time',
      label: 'My Desktop',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_1', hostEncPubJwk, priority: 30 },
      ],
    }));
    const payload = parseConnectionPayload(url);
    if (!payload || !('pairing' in payload)) throw new Error('expected a pairing payload');
    expect(payload.pairing.pairingId).toBe('pair_abc');
    expect(payload.pairing.secret).toBe('one-time');
    expect(payload.pairing.candidates.map((c) => c.type)).toEqual(['lan', 'relay']);
  });

  test('accepts a pairing link through the Android string fallback', () => {
    const url = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'pair_android',
      secret: 'one-time',
      candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 }],
    })).replace('varin://connect', 'Varin://CONNECT');
    const payload = parseConnectionPayload(url);
    expect(payload && 'pairing' in payload ? payload.pairing.pairingId : null).toBe('pair_android');
  });

  test('rejects non-connection and legacy/relay-offer payloads', () => {
    expect(parseConnectionPayload('')).toBeNull();
    expect(parseConnectionPayload('hello world')).toBeNull();
    expect(parseConnectionPayload('varin://connect')).toBeNull();
    expect(parseConnectionPayload('varin://session/abc')).toBeNull();
    // Legacy v1 direct links are no longer accepted.
    expect(parseConnectionPayload('varin://connect?v=1&server=http%3A%2F%2F192.168.1.10%3A2606&token=tok')).toBeNull();
    // Legacy relay-offer format (mode=relay + fragment) is no longer accepted.
    expect(parseConnectionPayload('varin://connect?v=1&mode=relay#offer=eyJ2IjoxfQ')).toBeNull();
  });
});

describe('scanConnectionQr on Android', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  test('uses the bundled scanner and cleans up after a result', async () => {
    const listeners = new Map<string, (event: { barcodes?: Array<{ rawValue?: string }> }) => void>();
    let removeCalls = 0;
    let stopCalls = 0;
    let oneShotScanCalls = 0;
    const remove = () => { removeCalls += 1; };
    const stopScan = async () => { stopCalls += 1; };
    const scan = async () => { oneShotScanCalls += 1; return { barcodes: [] }; };
    const plugin = {
      requestPermissions: vi.fn(async () => ({ camera: 'granted' })),
      scan,
      stopScan,
      startScan: vi.fn(async () => {
        listeners.get('barcodesScanned')?.({ barcodes: [{ rawValue: 'https://varin.example' }] });
      }),
      addListener: vi.fn((event: string, callback: (info: { barcodes?: Array<{ rawValue?: string }> }) => void) => {
        listeners.set(event, callback);
        return Promise.resolve({ remove });
      }),
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { Capacitor: { getPlatform: () => 'android', Plugins: { BarcodeScanner: plugin } } },
    });

    expect(await scanConnectionQr()).toEqual({ status: 'ok', url: 'https://varin.example' });
    expect(oneShotScanCalls).toBe(0);
    expect(stopCalls).toBe(1);
    expect(removeCalls).toBe(2);
  });

  test('stops the native scanner when cancelled', async () => {
    let stopCalls = 0;
    const stopScan = async () => { stopCalls += 1; };
    const plugin = {
      requestPermissions: vi.fn(async () => ({ camera: 'granted' })),
      startScan: vi.fn(async () => undefined),
      stopScan,
      addListener: vi.fn(async () => ({ remove: vi.fn(() => undefined) })),
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { Capacitor: { getPlatform: () => 'android', Plugins: { BarcodeScanner: plugin } } },
    });
    const controller = new AbortController();
    const result = scanConnectionQr({ signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    expect(await result).toEqual({ status: 'cancelled' });
    expect(stopCalls).toBe(1);
  });
});
