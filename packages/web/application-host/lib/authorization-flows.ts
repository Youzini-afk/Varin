/** User-owned sign-in interactions; the authentication owner retains the actual token work. */
import { randomUUID } from 'node:crypto';
import type { AuthorizationState } from '@varin/application-client';
export interface AuthorizationPrompt {
  signal: AbortSignal;
  showAuthorizationUrl(url: URL): void;
  showDeviceCode?(url: URL, code: string): void;
  promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}
interface Flow { state: AuthorizationState; controller: AbortController; reply?: (value: string | undefined) => void }
export class AuthorizationFlows {
  readonly #flows = new Map<string, Flow>();
  constructor(readonly changed: () => void = () => {}) {}
  start(action: (prompt: AuthorizationPrompt) => Promise<void>): AuthorizationState {
    const id = randomUUID(), flow: Flow = { state: { id, status: 'pending' }, controller: new AbortController() };
    this.#flows.set(id, flow);
    const prompt: AuthorizationPrompt = { signal: flow.controller.signal,
      showAuthorizationUrl: url => { if (!flow.controller.signal.aborted) { flow.state.authorizationUrl = url.href; this.changed(); } },
      showDeviceCode: (url, code) => { if (!flow.controller.signal.aborted) { flow.state.authorizationUrl = url.href; flow.state.deviceCode = code; this.changed(); } },
      promptForRedirectUrl: signal => new Promise(resolve => {
        const combined = AbortSignal.any([signal, flow.controller.signal]);
        const finish = (value: string | undefined) => { combined.removeEventListener('abort', abort); delete flow.reply; resolve(value); };
        const abort = () => finish(undefined);
        flow.reply = finish; combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort();
      }),
    };
    void Promise.resolve().then(() => action(prompt)).then(() => { if (!flow.controller.signal.aborted) flow.state = { id, status: 'completed' }; }, () => {
      if (!flow.controller.signal.aborted) flow.state = { id, status: 'failed', message: 'Sign-in failed. Check the account and server configuration.' };
    }).finally(() => { flow.controller.abort(); flow.reply?.(undefined); this.changed(); });
    return structuredClone(flow.state);
  }
  read(id: string) { const flow = this.#flows.get(id); if (!flow) throw new Error('Authorization flow is unavailable'); return structuredClone(flow.state); }
  reply(id: string, redirect: string) { const flow = this.#flows.get(id); if (!flow?.reply) throw new Error('Authorization callback is not pending'); flow.reply(redirect); }
  cancel(id: string) {
    const flow = this.#flows.get(id); if (!flow || flow.state.status !== 'pending') return;
    flow.state = { id, status: 'cancelled' }; flow.controller.abort(); flow.reply?.(undefined); this.changed();
  }
  close() { for (const id of this.#flows.keys()) this.cancel(id); this.#flows.clear(); }
}
