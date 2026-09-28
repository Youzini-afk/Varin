import { describe, expect, it } from 'vitest';
import { createEgressRuntime } from './egress.js';
import {
  encodeOutboundProxyAuth, normalizeOutboundNetwork, OUTBOUND_PROXY_CREDENTIAL_REF,
  readEgressHostConfiguration, readOutboundProxyAuth,
} from './egress-settings.js';

describe('Host outbound settings and credential binding', () => {
  it('rejects credential-bearing proxy URLs and unsupported schemes before persistence', () => {
    expect(() => normalizeOutboundNetwork({ mode: 'proxy', proxyUrl: 'http://user:secret@proxy.test:8080' })).toThrow();
    expect(() => normalizeOutboundNetwork({ mode: 'proxy', proxyUrl: 'socks5://proxy.test:1080' })).toThrow();
  });

  it('keeps a credential bound to the exact endpoint and setting generation', async () => {
    const key = encodeOutboundProxyAuth('generation-a', 'http://proxy-a.test:8080', 'user', 'secret');
    const auth = { [OUTBOUND_PROXY_CREDENTIAL_REF]: { type: 'api_key', key } };
    const a = { outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy-a.test:8080', credentialRef: 'generation-a' } };
    const b = { outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy-b.test:8080', credentialRef: 'generation-b' } };
    const returned = { outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy-a.test:8080', credentialRef: 'generation-c' } };
    expect(readEgressHostConfiguration(a, auth)?.proxyAuth).toEqual({ username: 'user', password: 'secret' });
    expect(readEgressHostConfiguration(b, auth)?.proxyAuth).toBeUndefined();
    expect(readEgressHostConfiguration(returned, auth)?.proxyAuth).toBeUndefined();
    expect(readOutboundProxyAuth(auth, 'generation-b', 'http://proxy-b.test:8080')).toBeUndefined();
    const rt = createEgressRuntime({ env: {}, getHostConfiguration: async () => readEgressHostConfiguration(b, auth) });
    const diagnosis = await rt.diagnose('http://public.example/');
    expect(JSON.stringify(diagnosis)).not.toContain('secret');
    expect(JSON.stringify(diagnosis)).not.toContain(key);
    await rt.close();
  });
});
