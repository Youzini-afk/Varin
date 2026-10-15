import { expect, test } from 'vitest';
import { validateMcpServerConfig } from './configuration.js';

test('connection validation rejects mismatched transport, OAuth and lifecycle fields per server', () => {
  for (const config of [
    { url: 'https://fixture/mcp', type: 'sse' },
    { command: 'fixture', type: 'http' },
    { url: 'https://fixture/mcp', env: { TOKEN: 'credential' } },
    { command: 'fixture', headers: { authorization: 'credential' } },
    { url: 'https://fixture/mcp', auth: { provider: '' } },
    { url: 'https://fixture/mcp', oauth: { callbackPort: -1 } },
    { url: 'https://fixture/mcp', oauth: { clientSecret: 3 } },
    { url: 'https://fixture/mcp', oauth: { callbackUrl: 'https://external/callback' } },
    { url: 'https://fixture/mcp', isolation: 'url' },
    { url: 'https://fixture/mcp', lifecycle: { keepAlive: true, idleTimeoutSeconds: 10 } },
    { url: 'https://fixture/mcp', lifecycle: { idleTimeoutSeconds: -1 } },
  ]) expect(typeof validateMcpServerConfig('fixture', config)).toBe('string');
  const valid = { url: 'https://fixture/mcp', type: 'http', oauth: { callbackPort: 0, callbackUrl: 'http://127.0.0.1/callback' }, isolation: 'session', lifecycle: { idleTimeoutSeconds: 0 } };
  expect(validateMcpServerConfig('fixture', valid)).toEqual(valid);
});
