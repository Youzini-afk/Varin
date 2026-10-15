import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpOAuthCredentialStore, oauthProvider, signInMcpServer } from './auth.js';
vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  auth: async (provider: { redirectToAuthorization(url: URL): void }) => { provider.redirectToAuthorization(new URL('https://fixture/authorize')); return 'REDIRECT'; },
}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test('token rotation preserves account identity, while effective authorization scope changes its binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-mcp-oauth-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const owner = new McpOAuthCredentialStore(directory); await owner.prepare();
  const store = owner.forServer('fixture', 'https://fixture/mcp');
  const provider = oauthProvider({ store, settings: {}, redirectUrl: 'http://127.0.0.1/callback' });
  await provider.saveTokens({ access_token: 'one', token_type: 'Bearer', scope: 'read write', expires_in: 30 });
  const original = owner.binding('fixture', 'https://fixture/mcp');
  await provider.saveTokens({ access_token: 'two', token_type: 'Bearer', scope: 'write read', expires_in: 30 });
  expect(owner.binding('fixture', 'https://fixture/mcp')).toEqual(original);
  await provider.saveTokens({ access_token: 'three', token_type: 'Bearer', expires_in: 30 });
  expect(owner.binding('fixture', 'https://fixture/mcp')).toEqual(original);
  await provider.saveTokens({ access_token: 'four', token_type: 'Bearer', scope: 'read', expires_in: 30 });
  expect(owner.binding('fixture', 'https://fixture/mcp')).toMatchObject({ reference: original!.reference, scope: 'read' });
  expect(owner.binding('fixture', 'https://fixture/mcp')).not.toEqual(original);
});

test('cancelling a redirected sign-in closes its local callback even when the manual reply never settles', async () => {
  const controller = new AbortController();
  let shown!: () => void;
  const redirected = new Promise<void>(resolve => { shown = resolve; });
  let state: import('./auth.js').McpOAuthState | undefined;
  const work = signInMcpServer({ serverUrl: 'https://fixture/mcp', settings: {}, store: { load: () => state, save: async value => { state = value; } },
    prompt: { signal: controller.signal, showAuthorizationUrl: () => shown(), promptForRedirectUrl: () => new Promise(() => {}) } });
  await redirected;
  const rejected = expect(work).rejects.toThrow();
  controller.abort(); await rejected;
});
