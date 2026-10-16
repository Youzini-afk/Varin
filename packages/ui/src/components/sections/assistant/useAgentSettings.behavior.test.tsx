import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), fetch: vi.fn() }));
vi.mock('@varin/application-client', () => ({ runtimeFetch: fixture.fetch, getRuntimeEndpointGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
import { useAgentSettings } from './agentSettings';

let root: Root, container: HTMLDivElement, current: ReturnType<typeof useAgentSettings>;
const catalog = (revision = fixture.generation) => ({ revision, memories: [], prompts: {} });
function Harness() { current = useAgentSettings(); return <output>{current.catalog?.revision ?? 'loading'}</output>; }
beforeEach(() => {
  vi.clearAllMocks(); fixture.generation += 1;
  fixture.fetch.mockImplementation(async () => Response.json(catalog()));
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<Harness />));
const switchHost = () => act(async () => { fixture.generation += 1; for (const listener of fixture.listeners) listener(); });

it('retires a late catalog read on any endpoint generation change', async () => {
  let complete!: (value: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render(); const oldUpdate = current.update;
  await switchHost();
  await act(async () => complete(Response.json(catalog(-1))));
  expect(current.catalog?.revision).toBe(fixture.generation);
  const before = fixture.fetch.mock.calls.length;
  expect(await oldUpdate('memory', { content: 'stale' })).toBe(false);
  expect(fixture.fetch).toHaveBeenCalledTimes(before);
});

it('does not acknowledge an old save after its refresh crosses to a new Host', async () => {
  await render();
  let refresh!: (value: Response) => void;
  fixture.fetch.mockImplementationOnce(async () => Response.json({ ok: true }))
    .mockImplementationOnce(() => new Promise(resolve => { refresh = resolve; }));
  let saving!: Promise<boolean>;
  await act(async () => { saving = current.update('memory', { content: 'original-host' }); });
  await switchHost();
  await act(async () => refresh(Response.json(catalog(-1))));
  expect(await saving).toBe(false); expect(current.catalog?.revision).toBe(fixture.generation); expect(current.busy).toBe(false);
});

it('does not replay a write when two handlers run before React publishes busy', async () => {
  await render();
  let complete!: (value: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  let first!: Promise<boolean>;
  await act(async () => { first = current.update('memory', { content: 'once' }); expect(await current.update('memory', { content: 'twice' })).toBe(false); });
  expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
  await act(async () => { complete(Response.json({ ok: true })); expect(await first).toBe(true); });
});
