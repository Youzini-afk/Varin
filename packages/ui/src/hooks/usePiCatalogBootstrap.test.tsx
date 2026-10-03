import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiRuntimeManagerStatus, PiRuntimeSnapshot } from '@varin/protocol';
import type { PiRuntimeManagementAPI } from '@varin/application-client';
import { usePiCatalogBootstrap } from './usePiCatalogBootstrap';

const fixture = vi.hoisted(() => ({ state: {
  catalogLoaded: false, catalogLoading: false, lastError: null as string | null,
  loadCatalog: vi.fn<() => Promise<unknown[]>>(),
} }));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: { getState: () => fixture.state } }));

let root: Root;
let status: PiRuntimeManagerStatus | null;
let releaseEarlyRequest: () => void;
let api: Pick<PiRuntimeManagementAPI, 'getSnapshot' | 'subscribe'>;
let listeners: Set<(snapshot: PiRuntimeSnapshot) => void>;
let revision: number;
let lastSnapshot: PiRuntimeSnapshot | null;
const snapshot = (state: PiRuntimeManagerStatus): PiRuntimeSnapshot => ({ installations: [], revision: ++revision, status: state });
const Probe = ({ desktop, epoch }: { desktop: boolean; epoch: number }) => {
  lastSnapshot = usePiCatalogBootstrap({ isDesktopRuntime: desktop, piRuntime: api, runtimeEndpointEpoch: epoch });
  return null;
};
const render = async (runtimeStatus: PiRuntimeManagerStatus | null, desktop = true, epoch = 0) => {
  status = runtimeStatus;
  await act(async () => {
    if (runtimeStatus) { const next = snapshot(runtimeStatus); for (const listener of listeners) listener(next); }
    root.render(<Probe desktop={desktop} epoch={epoch} />);
  });
};

beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
  fixture.state.catalogLoaded = false;
  fixture.state.catalogLoading = false;
  fixture.state.lastError = null;
  fixture.state.loadCatalog.mockReset();
  status = null;
  revision = 0;
  lastSnapshot = null;
  listeners = new Set();
  api = { getSnapshot: async () => snapshot(status ?? 'probing'),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  releaseEarlyRequest = () => undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(async () => { releaseEarlyRequest(); root.unmount(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pi catalog startup', () => {
  it('opens a cold desktop without manual retry when an early rejected connection would settle after readiness', async () => {
    const earlyFailure = new Promise<void>(resolve => { releaseEarlyRequest = resolve; });
    const requestedStatuses: Array<PiRuntimeManagerStatus | null> = [];
    fixture.state.loadCatalog.mockImplementation(async () => {
      const acceptedStatus = status;
      requestedStatuses.push(acceptedStatus);
      fixture.state.catalogLoading = true;
      try {
        if (acceptedStatus !== 'ready') { await earlyFailure; throw new Error('Pi runtime is not ready'); }
        fixture.state.catalogLoaded = true;
        return [];
      } catch (error) {
        fixture.state.lastError = (error as Error).message;
        throw error;
      } finally { fixture.state.catalogLoading = false; }
    });
    await render(null);
    await render('probing');
    await render('ready');
    await act(async () => releaseEarlyRequest());
    await render('ready');
    expect(fixture.state.catalogLoaded).toBe(true);
    expect(fixture.state.lastError).toBeNull();
    expect(requestedStatuses).toEqual(['ready']);
  });

  it('keeps a real catalog failure available for explicit retry and waits through an endpoint switch', async () => {
    fixture.state.loadCatalog.mockImplementation(async () => {
      fixture.state.lastError = 'Malformed session catalog';
      throw new Error('Malformed session catalog');
    });
    await render('probing');
    expect(fixture.state.loadCatalog).not.toHaveBeenCalled();
    await render('ready');
    await render('ready');
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
    expect(fixture.state.lastError).toBe('Malformed session catalog');
    fixture.state.loadCatalog.mockResolvedValue([]);
    await render('probing', true, 1);
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
    await render('ready', true, 1);
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(2);
  });

  it('loads the web catalog without waiting for desktop runtime discovery', async () => {
    fixture.state.loadCatalog.mockResolvedValue([]);
    await render(null, false);
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a prior endpoint ready snapshot or accept its late response', async () => {
    fixture.state.loadCatalog.mockImplementation(async () => { fixture.state.catalogLoaded = true; return []; });
    let resolveOld!: (value: PiRuntimeSnapshot) => void;
    api = { ...api, getSnapshot: () => new Promise(resolve => { resolveOld = resolve; }) };
    await render('probing');
    await render('ready');
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
    fixture.state.catalogLoaded = false;
    // An endpoint switch is rendered while the previous endpoint still said ready.
    // The new snapshot request stays pending; it must not borrow that readiness.
    let resolveNew!: (value: PiRuntimeSnapshot) => void;
    api = { ...api, getSnapshot: () => new Promise(resolve => { resolveNew = resolve; }) };
    await act(async () => root.render(<Probe desktop epoch={1} />));
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
    expect(lastSnapshot).toBeNull();
    await act(async () => resolveOld({ installations: [], revision: 100, status: 'ready' }));
    expect(lastSnapshot).toBeNull();
    await act(async () => resolveNew({ installations: [], revision: 1, status: 'probing' }));
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
    await render('ready', true, 1);
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(2);
  });

  it('retains subscribed readiness when the initial status request fails later', async () => {
    fixture.state.loadCatalog.mockImplementation(async () => { fixture.state.catalogLoaded = true; return []; });
    let rejectStatus!: (error: Error) => void;
    api = { ...api, getSnapshot: () => new Promise((_resolve, reject) => { rejectStatus = reject; }) };
    await render(null);
    await render('ready');
    await act(async () => rejectStatus(new Error('Initial status request disconnected')));
    expect(lastSnapshot?.status).toBe('ready');
    expect(fixture.state.loadCatalog).toHaveBeenCalledTimes(1);
  });
});
