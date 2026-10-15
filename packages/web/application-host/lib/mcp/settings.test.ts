import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpConfigurationSnapshot } from '@varin/application-client';
import { McpAuthority, type McpAuthorityScope } from './authority.js';
import { createMcpSettings } from './settings.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function createSettings(directory: string) {
  const authority = new McpAuthority(); cleanup.push(() => authority.close());
  const scope: McpAuthorityScope = { resourceOwner: { kind: 'local' }, agentDir: directory, configCwd: directory, executionCwd: directory, environmentId: 'test', executionScope: 'global', projectTrusted: false, sessionId: 'settings' };
  const settings = createMcpSettings({ authority, resolveScope: async () => scope, changed() {} }); cleanup.push(() => settings.close());
  return { authority, settings };
}
function fixture() {
  const result = createSettings('/unused');
  const unwatch = vi.fn(); vi.spyOn(result.authority, 'subscribe').mockResolvedValue(unwatch);
  return { ...result, unwatch };
}
async function configuredFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-mcp-settings-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { test: { url: 'http://localhost:1234/mcp' } } }));
  return createSettings(directory);
}

test('a failed initial settings snapshot releases the undisclosed view and its watcher', async () => {
  const { authority, settings, unwatch } = fixture();
  vi.spyOn(authority, 'directory').mockRejectedValue(new Error('configuration unavailable'));
  await expect(settings.invoke('open', {})).rejects.toThrow('configuration unavailable');
  expect(unwatch).toHaveBeenCalledOnce();
  settings.close(); expect(unwatch).toHaveBeenCalledOnce();
});

test('cancelling settings preparation closes its view even while the independent directory read is pending', async () => {
  const { authority, settings, unwatch } = fixture();
  const started = deferred<void>(), pending = deferred<Awaited<ReturnType<McpAuthority['directory']>>>();
  vi.spyOn(authority, 'directory').mockImplementation(() => { started.resolve(); return pending.promise; });
  const controller = new AbortController();
  const opening = settings.invoke('open', {}, controller.signal);
  const rejected = expect(opening).rejects.toThrow();
  await started.promise; controller.abort();
  expect(unwatch).toHaveBeenCalledOnce();
  pending.resolve([]);
  await rejected;
  settings.close(); expect(unwatch).toHaveBeenCalledOnce();
});


test('closing settings during its initial directory read never publishes a closed view', async () => {
  const { authority, settings } = await configuredFixture();
  const started = deferred<void>(), resume = deferred<void>();
  const readDirectory = authority.directory.bind(authority);
  vi.spyOn(authority, 'directory').mockImplementationOnce(async (...args) => {
    const result = await readDirectory(...args); started.resolve(); await resume.promise; return result;
  });
  const inspect = vi.spyOn(authority, 'inspect');
  const opening = settings.invoke('open', {});
  const rejected = expect(opening).rejects.toMatchObject({ code: 'mcp-view-unavailable' });
  await started.promise; settings.close(); resume.resolve();
  await rejected;
  expect(inspect).not.toHaveBeenCalled();
});

test('closing a view while connection scope preparation is pending prevents connecting and releases that scope', async () => {
  const { authority, settings } = await configuredFixture();
  const view = await settings.invoke('open', {}) as McpConfigurationSnapshot;
  const started = deferred<string>(), resume = deferred<void>();
  const openScope = authority.open.bind(authority);
  vi.spyOn(authority, 'open').mockImplementationOnce(async input => {
    const opened = await openScope(input); started.resolve(opened.scope); await resume.promise; return opened;
  });
  const closeScope = vi.spyOn(authority, 'closeScope');
  const connect = vi.spyOn(authority, 'connect').mockRejectedValue(new Error('closed view must not connect'));
  const connecting = settings.invoke('command', { view: view.view, name: 'test', command: 'connect' });
  const rejected = expect(connecting).rejects.toMatchObject({ code: 'mcp-view-unavailable' });
  const scope = await started.promise;
  await settings.invoke('close', { view: view.view }); resume.resolve();
  await rejected;
  expect(connect).not.toHaveBeenCalled();
  expect(closeScope).toHaveBeenCalledExactlyOnceWith(scope);
});
