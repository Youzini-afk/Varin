import { expect, test } from 'vitest';
import { BrowserExecutionError, type BrowserEvent, type BrowserOwner, type BrowserPage } from '@varin/protocol';
import { BrowserResources } from './browser-resources.js';
import { ConnectedBrowserOwner } from './browser-connector.js';

const page = (pageId: string): BrowserPage => ({
  browserId: 'test', pageId, title: pageId, url: 'https://example.org', loading: false,
  canGoBack: false, canGoForward: false, retained: true,
});
function fixture() {
  const registry = new BrowserResources();
  let instanceId = 'initial';
  registry.register({
    browserId: 'test',
    resource: async () => ({ instanceId, state: 'online', capabilities: ['tabs', 'act', 'read'] }),
    subscribe: () => () => undefined,
    list: async () => [page('first'), page('second')],
  } as unknown as BrowserOwner, 'Browser', 'Device');
  return { registry, replace: () => { instanceId = 'replacement'; } };
}
const target = { browserId: 'test', instanceId: 'initial', pageId: 'first' };
test('page control is shared with the browser provider and can be resumed from either surface', async () => {
  const registry = new BrowserResources(), pauses: boolean[] = [];
  let publish!: (event: BrowserEvent) => void;
  const changed = (paused: boolean) => publish({ kind: 'page', page: { ...page('first'), instanceId: 'initial', agentPaused: paused } });
  registry.register({ browserId: 'test', resource: async () => ({ state: 'online', instanceId: 'initial', capabilities: ['tabs', 'act'] }),
    list: async () => [page('first')], subscribe: listener => { publish = listener; return () => {}; },
    pausePage: async (_pageId, paused) => { pauses.push(paused); changed(paused); },
  } as BrowserOwner, 'Browser', 'Device');
  await registry.use(target, {}, async () => undefined);
  changed(true);
  expect((await registry.control(target, 'resume')).controller).toBe('agent');
  expect(pauses).toEqual([false]);
  await registry.control(target, 'takeover'); expect(registry.usage(target).controller).toBe('human');
  changed(false); expect(registry.usage(target).controller).toBe('agent');
});
function latch() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test('selection never substitutes a replacement instance for the original page', async () => {
  const { registry, replace } = fixture();
  await expect(registry.use(target, { threadId: 'work' }, async (_owner, binding) => binding)).resolves.toEqual(target);
  replace();
  await expect(registry.use(target, {}, async () => null)).rejects.toThrow('original browser instance ended');
  await expect(registry.use({}, { threadId: 'work' }, async () => null)).rejects.toThrow('original browser instance ended');
  await expect(registry.use({ browserId: 'test' }, {}, async (_owner, binding) => binding.instanceId)).resolves.toBe('replacement');
});

test('takeover drains active input, rejects old waiters, and requires the task to observe after resume', async () => {
  const { registry } = fixture();
  const entered = latch(), finish = latch();
  const active = registry.use(target, { threadId: 'one' }, async () => { entered.release(); await finish.wait; }, { writes: true });
  await entered.wait;
  let dispatched = false;
  const queued = registry.use(target, { threadId: 'two' }, async () => { dispatched = true; }, { writes: true }).catch(error => error);
  await expect(registry.use({ ...target, pageId: 'second' }, { threadId: 'two' }, async () => 'parallel', { writes: true })).resolves.toBe('parallel');
  expect(registry.usage(target)).toEqual({ controller: 'agent', activeThreadId: 'one', waitingThreadIds: ['two'] });
  const takeover = registry.control(target, 'takeover');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(registry.usage(target).controller).toBe('human');
  await expect(registry.use(target, { threadId: 'three' }, async () => null, { writes: true })).rejects.toThrow('user is controlling');
  finish.release();
  await active;
  await takeover;
  expect(await queued).toBeInstanceOf(BrowserExecutionError);
  expect(dispatched).toBe(false);
  await registry.control(target, 'resume');
  await registry.use(target, {}, async () => null, { observes: true });
  await expect(registry.use(target, { threadId: 'one' }, async () => null, { writes: true })).rejects.toThrow('Read the current page');
  await registry.use(target, { threadId: 'one' }, async () => null, { observes: true });
  await expect(registry.use(target, { threadId: 'one' }, async () => 'resumed', { writes: true })).resolves.toBe('resumed');
});

test('connector does not replay a dispatched write across an instance change', async () => {
  const owner = new ConnectedBrowserOwner('paired');
  const input = { browserId: 'local', instanceId: 'initial', label: 'Chrome', capabilities: ['act:navigate'] };
  const abort = new AbortController();
  expect(await owner.exchange(input, abort.signal)).toEqual({ commands: [] });
  const poll = owner.exchange(input, abort.signal);
  const act = owner.act('page', { action: 'navigate', url: 'https://example.org' }).catch(error => error);
  expect((await poll).commands.map(command => command.method)).toEqual(['act']);
  const reconnect = new AbortController(); reconnect.abort();
  expect(await owner.exchange({ ...input, instanceId: 'replacement' }, reconnect.signal)).toEqual({ commands: [] });
  expect(await act).toMatchObject({ effect: 'unknown' });
  await expect(owner.exchange(input, reconnect.signal)).rejects.toThrow('already ended');
  await owner.dispose();
});

test('connector acknowledges a page event before waiting for the subsequent action receipt', async () => {
  const owner = new ConnectedBrowserOwner('paired');
  const input = { browserId: 'local', instanceId: 'initial', label: 'Chrome', capabilities: ['act:navigate'] };
  const controller = new AbortController();
  await owner.exchange(input, controller.signal);
  const poll = owner.exchange(input, controller.signal);
  const action = owner.act('first', { action: 'navigate', url: 'https://example.org' }).catch(error => error);
  const [command] = (await poll).commands;
  try {
    const event = owner.exchange({ ...input, events: [{ kind: 'page', page: page('first') }] }, controller.signal);
    expect(await Promise.race([event.then(() => 'acknowledged'), new Promise(resolve => setImmediate(() => resolve('still polling')))])).toBe('acknowledged');
    await owner.exchange({ ...input, results: [{ id: command!.id, ok: true, value: { page: page('first'), action: 'navigate' } }] }, controller.signal);
    expect(await action).toMatchObject({ action: 'navigate' });
  } finally { controller.abort(); await owner.dispose(); await action; }
});

test('a late terminal exchange cannot disconnect a replacement instance', async () => {
  const owner = new ConnectedBrowserOwner('paired');
  const input = { browserId: 'local', instanceId: 'initial', label: 'Chrome', capabilities: ['list'] };
  const signal = AbortSignal.abort();
  await owner.exchange(input, signal);
  await owner.exchange({ ...input, instanceId: 'replacement' }, signal);
  await expect(owner.exchange({ ...input, disconnected: true }, signal)).resolves.toEqual({ commands: [] });
  await expect(owner.resource()).resolves.toMatchObject({ state: 'online', instanceId: 'replacement' });
  await owner.exchange({ ...input, instanceId: 'replacement', disconnected: true }, signal);
  await expect(owner.resource()).resolves.toMatchObject({ state: 'ended', instanceId: 'replacement' });
  await owner.dispose();
});
