import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { mountGmailSettings, type GmailSettings } from './settings.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test('settings suppress repeated connect and cancel authorization arriving after navigation', async () => {
  const { document } = parseHTML('<html><body><main></main></body></html>');
  const container = document.querySelector('main')!;
  let finish!: (value: Awaited<ReturnType<GmailSettings['connect']>>) => void, starts = 0;
  const cancellations: string[][] = [];
  const service: GmailSettings = { list: async () => [], connect: async () => { starts++; return new Promise(resolve => { finish = resolve; }); },
    cancel: async (connectionId, id) => { cancellations.push([connectionId, id]); return { connectionId, id, status: 'cancelled' }; },
    readAttempt: async () => { throw new Error('unexpected poll'); }, reply: async () => { throw new Error('unexpected reply'); }, disconnect: async () => ({ revocation: 'not-requested' }) };
  const signal = new AbortController();
  mountGmailSettings(container as unknown as HTMLElement, { signal: signal.signal }, service);
  await settle();
  const connect = [...container.querySelectorAll('button')].find(button => button.textContent === 'Connect Gmail')!;
  connect.click(); connect.click(); assert.equal(starts, 1);
  signal.abort(); finish({ id: 'attempt', connectionId: 'one', status: 'pending', authorizationUrl: 'https://accounts.google.com/' });
  await settle(); assert.deepEqual(cancellations, [['one', 'attempt']]); assert.equal(container.children.length, 0);
});
test('settings expose remote callback completion and preserve accounts when cancellation succeeds', async () => {
  const { document } = parseHTML('<html><body><main></main></body></html>'); const container = document.querySelector('main')!;
  let cancelled = 0;
  const service: GmailSettings = { list: async () => [{ connectionId: 'old', account: 'identity', accountId: 'me@example.test' }],
    connect: async () => ({ connectionId: 'new', id: 'attempt', status: 'pending', authorizationUrl: 'https://accounts.google.com/' }),
    cancel: async (connectionId, id) => { cancelled++; return { connectionId, id, status: 'cancelled' }; }, readAttempt: async () => { throw new Error('unexpected poll'); },
    reply: async () => ({ id: 'attempt', status: 'pending' }), disconnect: async () => ({ revocation: 'not-requested' }) };
  const close = mountGmailSettings(container as unknown as HTMLElement, { signal: new AbortController().signal }, service);
  await settle(); const button = (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent === name)!;
  button('Connect Gmail').click(); await settle(); assert.equal(button('Complete sign-in').disabled, false);
  button('Cancel sign-in').click(); await settle(); assert.equal(cancelled, 1); assert.equal(container.querySelectorAll('option').length, 1);
  close(); assert.equal(cancelled, 1);
});
