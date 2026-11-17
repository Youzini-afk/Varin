import { describe, expect, test } from 'vitest';
import { nativeHostRequestInit, sanitizeRuntimeRequestHeaders } from './runtime-request-headers.js';

describe('sanitizeRuntimeRequestHeaders', () => {
  test('preserves safe custom headers', () => {
    expect(sanitizeRuntimeRequestHeaders({
      ' CF-Access-Client-Id ': ' client-id ',
      'X-Custom-Header': 'value',
    })).toEqual({
      'CF-Access-Client-Id': 'client-id',
      'X-Custom-Header': 'value',
    });
  });

  test('drops invalid and reserved headers', () => {
    expect(sanitizeRuntimeRequestHeaders({
      Authorization: 'Bearer proxy-token',
      'authorization': 'Bearer lower-token',
      'Bad:Name': 'value',
      'Bad\nName': 'value',
      'Bad-Value': 'line\nbreak',
      Empty: '',
      Good: 'ok',
    })).toEqual({ Good: 'ok' });
  });
});


describe('native Host authentication requests', () => {
  test('uses only the configured HTTPS origin and keeps bearer and access headers', () => {
    const init = nativeHostRequestInit('https://work.example.test:8443/api/client-auth/pairing/redeem', {
      method: 'POST', redirect: 'follow', body: 'one-time-pairing-payload',
      headers: { Origin: 'https://stale.example.test', Authorization: 'Bearer native-device', 'CF-Access-Client-Id': 'configured-access' },
    });
    const headers = new Headers(init.headers);
    expect(headers.get('Origin')).toBe('https://work.example.test:8443');
    expect(headers.get('Authorization')).toBe('Bearer native-device');
    expect(headers.get('CF-Access-Client-Id')).toBe('configured-access');
    expect(init.redirect).toBe('error');
    expect(init.body).toBe('one-time-pairing-payload');
  });

  test('does not rewrite Origin for original HTTP or SSH loopback connections', () => {
    const init = nativeHostRequestInit('http://127.0.0.1:3902/auth/session', { headers: { Accept: 'application/json' } });
    expect(new Headers(init.headers).has('Origin')).toBe(false);
  });

  test('does not forward pairing bodies or access credentials to a redirected Host', async () => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    let redirected = 0;
    const destination = createServer((_request, response) => { redirected++; response.end('must not receive credentials'); });
    destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
    const destinationUrl = `http://127.0.0.1:${(destination.address() as import('node:net').AddressInfo).port}`;
    const source = createServer((_request, response) => { response.writeHead(307, { Location: destinationUrl }); response.end(); });
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    const url = `http://127.0.0.1:${(source.address() as import('node:net').AddressInfo).port}`;
    try {
      await expect(fetch(url, nativeHostRequestInit(url, { method: 'POST', body: 'one-time-secret',
        headers: { 'CF-Access-Client-Secret': 'configured-access-secret' } }))).rejects.toThrow();
      expect(redirected).toBe(0);
    } finally {
      await Promise.all([source, destination].map(server => new Promise<void>(resolve => {
        server.closeAllConnections(); server.close(() => resolve());
      })));
    }
  });
});
