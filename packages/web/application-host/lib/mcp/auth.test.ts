import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpOAuthCredentialStore, oauthProvider, signInMcpServer } from './auth.js';
vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  auth: async (provider: { redirectUrl: string; state(): string; redirectToAuthorization(url: URL): void }, options: { authorizationCode?: string }) => {
    if (options.authorizationCode) return 'AUTHORIZED';
    const url = new URL('https://fixture/authorize');
    url.searchParams.set('redirect_uri', provider.redirectUrl); url.searchParams.set('state', provider.state());
    provider.redirectToAuthorization(url); return 'REDIRECT';
  },
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

test('a state-bound OAuth denial ends sign-in and closes its callback without exposing remote error text', async () => {
  const controller = new AbortController();
  let shown!: (url: URL) => void;
  const redirected = new Promise<URL>(resolve => { shown = resolve; });
  let state: import('./auth.js').McpOAuthState | undefined;
  const work = signInMcpServer({ serverUrl: 'https://fixture/mcp', settings: {}, store: { load: () => state, save: async value => { state = value; } },
    prompt: { signal: controller.signal, showAuthorizationUrl: shown, promptForRedirectUrl: () => new Promise(() => {}) } });
  let settled: unknown;
  const observed = work.then(() => { settled = 'success'; }, error => { settled = error; });
  const authorization = await redirected;
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', 'wrong-state'); callback.searchParams.set('error', 'access_denied');
  try {
    expect((await fetch(callback)).status).toBe(400); expect(settled).toBeUndefined();
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('error_description', 'synthetic-private-remote-text');
    const reply = await fetch(callback); await reply.text();
    await expect.poll(() => settled, { timeout: 300 }).toBeInstanceOf(Error);
    await observed;
    expect((settled as Error).message).toBe('MCP sign-in was not authorized');
    await expect(fetch(callback)).rejects.toThrow();
  } finally { controller.abort(); await observed; }
});
