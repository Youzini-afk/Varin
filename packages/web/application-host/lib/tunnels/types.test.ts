import { describe, expect, it } from 'vitest';

import {
  isPathWithinDirectory,
  resolveTunnelConfigPath,
  normalizeReverseProxyConfiguration,
  normalizeTunnelStartRequest,
} from './types.js';

describe('tunnel config path normalization', () => {
  it('allows Windows home paths with different drive casing', () => {
    expect(isPathWithinDirectory(
      'c:\\Users\\Bohdan\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(true);
  });

  it('does not allow Windows sibling home directories', () => {
    expect(isPathWithinDirectory(
      'C:\\Users\\Bohdan2\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(false);
  });

  it('resolves Windows tilde paths inside the provided home directory', () => {
    expect(resolveTunnelConfigPath('~\\.cloudflared\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toBe('C:\\Users\\Bohdan\\.cloudflared\\config.yml');
  });

  it('rejects Windows paths outside the provided home directory', () => {
    expect(() => resolveTunnelConfigPath('C:\\Temp\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toThrow(/Config path must be within the home directory/);
  });
});

describe('reverse proxy configuration', () => {
  it('keeps provider-specific configuration separate from Cloudflare modes', () => {
    expect(normalizeTunnelStartRequest({
      provider: 'reverse-proxy',
      reverseProxy: { publicOrigin: 'https://VARIN.example:443/', backend: { port: 3903 } },
    })).toMatchObject({
      provider: 'reverse-proxy', mode: 'reverse-proxy', intent: 'persistent-public',
      reverseProxy: { publicOrigin: 'https://varin.example', backend: { host: '127.0.0.1', port: 3903 } },
    });
  });

  it.each([
    'http://varin.example', 'https://user:secret@varin.example',
    'https://varin.example/workbench', 'https://varin.example/../',
    'https://varin.example?t=secret', 'https://varin.example#secret',
    'https://varin.example?', 'https://varin.example#',
    'https://varin.example\\other',
  ])('rejects a non-origin or insecure address without echoing it: %s', (publicOrigin) => {
    expect(() => normalizeReverseProxyConfiguration({ publicOrigin, backend: { port: 3903 } }))
      .toThrow('must be an HTTPS origin');
  });

  it.each([0, -1, 65536, 3903.5, '3903', undefined])('rejects unstable or invalid backend ports: %s', (port) => {
    expect(() => normalizeReverseProxyConfiguration({ publicOrigin: 'https://varin.example', backend: { port } }))
      .toThrow('backend port');
  });

  it('accepts an explicit private IPv6 bind and rejects URL-shaped bind hosts', () => {
    expect(normalizeReverseProxyConfiguration({
      publicOrigin: 'https://varin.example', backend: { host: '::1', port: 3903 },
    }).backend).toEqual({ host: '::1', port: 3903 });
    for (const host of ['localhost:3903', 'http://localhost', 'user@localhost', '']) {
      expect(() => normalizeReverseProxyConfiguration({ publicOrigin: 'https://varin.example', backend: { host, port: 3903 } }))
        .toThrow('backend host');
    }
  });

  it('rejects explicit unsupported provider and mode rather than starting another provider', () => {
    expect(() => normalizeTunnelStartRequest({ provider: 'frp' })).toThrow('Unsupported tunnel provider');
    expect(() => normalizeTunnelStartRequest({ mode: 'typo' })).toThrow('Unsupported tunnel mode');
    expect(normalizeTunnelStartRequest({})).toMatchObject({ provider: 'cloudflare', mode: 'quick' });
  });
});
