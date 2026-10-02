import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAuthPrompt } from '@varin/protocol';
import { discoverPiProviderModels, loginPiProvider } from './providers';

const connection = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./client', () => ({ getPiRuntimeConnection: connection.get }));

type Event = { event: string; data: Record<string, unknown> };
type Request = { method: string; params: Record<string, unknown> };

class AuthClient {
  listeners = new Set<(event: Event) => void>();
  requests: Request[] = [];
  operations = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();

  subscribe = (listener: (event: Event) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    this.requests.push({ method, params });
    if (method === 'provider.auth.respond') return Promise.resolve({ accepted: true });
    if (method === 'provider.auth.cancel') {
      const operation = this.operations.get(String(params.interactionId));
      operation?.reject(new DOMException('Authentication cancelled', 'AbortError'));
      return Promise.resolve({ cancelled: Boolean(operation) });
    }
    return new Promise((resolve, reject) => this.operations.set(String(params.interactionId), { resolve, reject }));
  };

  emit(event: string, interactionId: string, data: Record<string, unknown>) {
    for (const listener of this.listeners) listener({
      event,
      data: { providerId: 'shared-provider', sessionId: 'catalog-session', interactionId, ...data },
    });
  }

  prompt(interactionId: string, requestId: string, type: ProviderAuthPrompt['type'] = 'secret') {
    this.emit('provider.auth.prompt', interactionId, { prompt: { requestId, type, message: requestId } });
  }

  finish(interactionId: string, result: unknown = { authenticated: true }) {
    this.operations.get(interactionId)!.resolve(result);
  }

  get answers() {
    return this.requests.filter(({ method }) => method === 'provider.auth.respond').map(({ params }) => params.response);
  }
}

let client: AuthClient;
beforeEach(() => {
  client = new AuthClient();
  connection.get.mockResolvedValue({ client });
});

const loginOptions = { cwd: '/workspace', providerId: 'shared-provider', type: 'api_key' as const };

describe('native Pi authentication interactions', () => {
  it('passes the inference capability with its draft configuration through the existing auth interaction', async () => {
    const config = { id: 'shared-provider', capabilities: { embedding: {
      protocol: 'openai-compatible' as const, baseUrl: 'https://embedding.example/v1', credentialRef: 'embedding-key',
    } } };
    const operation = discoverPiProviderModels('/workspace', 'shared-provider', { capability: 'embedding', config });
    await vi.waitFor(() => expect(client.operations.size).toBe(1));
    const request = client.requests.find(entry => entry.method === 'provider.models.discover')!;
    expect(request.params).toMatchObject({ capability: 'embedding', config, cwd: '/workspace', providerId: 'shared-provider' });
    expect(request.params.requestCredential).toBeUndefined();
    client.finish(String(request.params.interactionId), { models: [{ id: 'embedding-model' }] });
    await expect(operation).resolves.toEqual({ models: [{ id: 'embedding-model' }] });
  });

  it('isolates two logins and model discovery for the same provider', async () => {
    const firstPrompt = vi.fn(async () => 'first-key');
    const secondPrompt = vi.fn(async () => 'second-key');
    const first = loginPiProvider({ ...loginOptions, onPrompt: firstPrompt });
    const second = loginPiProvider({ ...loginOptions, onPrompt: secondPrompt });
    const discovery = discoverPiProviderModels('/workspace', 'shared-provider', { apiKey: 'discovery-key' });
    await vi.waitFor(() => expect(client.operations.size).toBe(3));
    const [firstId, secondId, discoveryId] = [...client.operations.keys()];
    client.prompt(firstId!, 'login-one');
    client.prompt(secondId!, 'login-two');
    client.prompt(discoveryId!, 'discovery');
    await vi.waitFor(() => expect(client.answers).toHaveLength(3));
    expect(client.answers).toEqual(expect.arrayContaining([
      { requestId: 'login-one', value: 'first-key' },
      { requestId: 'login-two', value: 'second-key' },
      { requestId: 'discovery', value: 'discovery-key' },
    ]));
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    expect(secondPrompt).toHaveBeenCalledTimes(1);
    client.finish(firstId!);
    client.finish(secondId!);
    client.finish(discoveryId!, { models: [] });
    await Promise.all([first, second, discovery]);
    expect(client.listeners.size).toBe(0);
  });

  it('never repeats a discovery credential for a second field', async () => {
    const operation = discoverPiProviderModels('/workspace', 'shared-provider', { apiKey: 'discovery-key' });
    await vi.waitFor(() => expect(client.operations.size).toBe(1));
    const id = [...client.operations.keys()][0]!;
    client.prompt(id, 'key');
    await vi.waitFor(() => expect(client.answers).toHaveLength(1));
    client.prompt(id, 'unexpected-account', 'text');
    await vi.waitFor(() => expect(client.answers).toHaveLength(2));
    expect(client.answers[1]).toEqual({ requestId: 'unexpected-account', cancelled: true });
    client.finish(id, { models: [] });
    await operation;
  });

  it('dismisses manual code entry when native browser authentication completes', async () => {
    let questionSignal: AbortSignal | undefined;
    const onPrompt = vi.fn((_prompt: ProviderAuthPrompt, signal: AbortSignal) => {
      questionSignal = signal;
      return new Promise<string | undefined>(() => {});
    });
    const operation = loginPiProvider({ ...loginOptions, type: 'oauth', onPrompt });
    await vi.waitFor(() => expect(client.operations.size).toBe(1));
    const id = [...client.operations.keys()][0]!;
    client.prompt(id, 'manual-code', 'manual_code');
    await vi.waitFor(() => expect(onPrompt).toHaveBeenCalledOnce());
    client.emit('provider.auth.dismiss', id, { requestId: 'manual-code' });
    client.finish(id);
    await expect(operation).resolves.toEqual({ authenticated: true });
    expect(questionSignal?.aborted).toBe(true);
    expect(client.answers).toEqual([]);
    expect(client.listeners.size).toBe(0);
  });

  it('cancels a login waiting without a question and unsubscribes from late events', async () => {
    const controller = new AbortController();
    const onEvent = vi.fn();
    const onPrompt = vi.fn(async () => 'unused');
    const operation = loginPiProvider({ ...loginOptions, type: 'oauth', onPrompt, onEvent, signal: controller.signal });
    const cancelled = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(client.operations.size).toBe(1));
    const id = [...client.operations.keys()][0]!;
    client.emit('provider.auth.event', id, { event: { type: 'auth_url', url: 'https://auth.example/login' } });
    controller.abort();
    await cancelled;
    expect(client.requests).toContainEqual({ method: 'provider.auth.cancel', params: { cwd: '/workspace', interactionId: id } });
    client.prompt(id, 'late');
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onPrompt).not.toHaveBeenCalled();
    expect(client.listeners.size).toBe(0);
  });

  it('cancels the native operation and preserves the original prompt error', async () => {
    const failure = new Error('Unable to show credential input');
    const operation = loginPiProvider({ ...loginOptions, onPrompt: async () => { throw failure; } });
    const failed = expect(operation).rejects.toBe(failure);
    await vi.waitFor(() => expect(client.operations.size).toBe(1));
    const id = [...client.operations.keys()][0]!;
    client.prompt(id, 'key');
    await failed;
    expect(client.listeners.size).toBe(0);
    expect(client.requests.some(({ method }) => method === 'provider.auth.cancel')).toBe(true);
  });
});
