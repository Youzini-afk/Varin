import type {
  ProviderAuthEvent,
  ProviderAuthPrompt,
  ProviderAuthType,
  ProviderConfigDeleteScope,
  ProviderConfigInput,
  ProviderConfigScope,
  ProviderInferenceCapability,
} from '@varin/protocol';
import { getPiRuntimeConnection } from './client';

export const listPiProviders = async (cwd: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.list', { cwd });
};

export const listPiModels = async (cwd: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('model.list', { cwd });
};

export const getPiProviderConfig = async (cwd: string, providerId: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.config.get', { cwd, providerId });
};

export const upsertPiProviderConfig = async (
  cwd: string,
  scope: ProviderConfigScope,
  config: ProviderConfigInput,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.config.upsert', { config, cwd, scope });
};

export const deletePiProviderConfig = async (
  cwd: string,
  providerId: string,
  scope: ProviderConfigDeleteScope,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.config.delete', { cwd, providerId, scope });
};

export interface PiProviderDiscoveryOptions {
  capability?: ProviderInferenceCapability;
  apiKey?: string;
  config?: ProviderConfigInput;
  signal?: AbortSignal;
}

export const discoverPiProviderModels = async (
  cwd: string,
  providerId: string,
  options: PiProviderDiscoveryOptions = {},
) => {
  const apiKey = options.apiKey?.trim();
  let credentialProvided = false;
  return runProviderInteraction({
    cwd,
    providerId,
    signal: options.signal,
    // Discovery owns one explicit credential question. Never reuse that value
    // for an unrelated field or for a different login on this provider.
    onPrompt: async (prompt) => {
      if (!apiKey || credentialProvided || prompt.type !== 'secret') return undefined;
      credentialProvided = true;
      return apiKey;
    },
  }, (client, interactionId) => client.request('provider.models.discover', {
      ...(options.capability === undefined ? {} : { capability: options.capability }),
      ...(options.config === undefined ? {} : { config: options.config }),
      cwd,
      interactionId,
      providerId,
      ...(apiKey ? { requestCredential: true } : {}),
    }, null));
};

interface PiProviderInteractionOptions {
  cwd: string;
  onEvent?(event: ProviderAuthEvent): void;
  onPrompt(prompt: ProviderAuthPrompt, signal: AbortSignal): Promise<string | undefined>;
  providerId: string;
  signal?: AbortSignal;
}

export interface PiProviderLoginOptions extends PiProviderInteractionOptions {
  type: ProviderAuthType;
}

type ProviderClient = Awaited<ReturnType<typeof getPiRuntimeConnection>>['client'];

/**
 * Own exactly one native authentication interaction, including questions that
 * Pi withdraws when a browser login wins the race with manual code entry.
 * Provider identity alone cannot correlate concurrent login/discovery calls.
 */
const runProviderInteraction = async <T>(
  options: PiProviderInteractionOptions,
  start: (client: ProviderClient, interactionId: string) => Promise<T>,
): Promise<T> => {
  options.signal?.throwIfAborted();
  const { client } = await getPiRuntimeConnection();
  options.signal?.throwIfAborted();
  const interactionId = crypto.randomUUID();
  const pendingResponses = new Set<Promise<void>>();
  const prompts = new Map<string, AbortController>();
  let promptFailure: unknown;
  let finished = false;
  let cancelRequest: Promise<unknown> | undefined;

  const cancelRemote = () => {
    if (finished || cancelRequest) return;
    cancelRequest = client.request('provider.auth.cancel', {
      cwd: options.cwd,
      interactionId,
    }, null).catch((error: unknown) => {
      promptFailure ??= error;
    });
  };

  const dismissPrompts = () => {
    for (const controller of prompts.values()) controller.abort();
  };
  const abort = () => {
    dismissPrompts();
    cancelRemote();
  };

  const unsubscribe = client.subscribe((envelope) => {
    if (finished) return;
    if (envelope.event !== 'provider.auth.event'
      && envelope.event !== 'provider.auth.prompt'
      && envelope.event !== 'provider.auth.dismiss') return;
    if (envelope.data.providerId !== options.providerId || envelope.data.interactionId !== interactionId) return;
    if (options.signal?.aborted) { abort(); return; }
    if (envelope.event === 'provider.auth.dismiss') {
      prompts.get(envelope.data.requestId)?.abort();
      return;
    }
    if (envelope.event === 'provider.auth.event') {
      try { options.onEvent?.(envelope.data.event); }
      catch (error) { promptFailure ??= error; cancelRemote(); }
      return;
    }

    const { prompt, sessionId } = envelope.data;
    if (prompts.has(prompt.requestId)) return;
    const controller = new AbortController();
    prompts.set(prompt.requestId, controller);
    const response = (async () => {
      // Resolve the wait even if a dismissed UI prompt never produces a value.
      // The UI receives the same signal so it can remove that obsolete field.
      const value = await new Promise<string | undefined>((resolve, reject) => {
        const dismiss = () => resolve(undefined);
        controller.signal.addEventListener('abort', dismiss, { once: true });
        void Promise.resolve().then(() => {
          if (controller.signal.aborted) return undefined;
          return options.onPrompt(prompt, controller.signal);
        }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', dismiss));
      });
      if (!finished && !controller.signal.aborted && !options.signal?.aborted) {
        const result = await client.request('provider.auth.respond', {
          response: {
            ...(value === undefined ? { cancelled: true } : { value }),
            requestId: prompt.requestId,
          },
          sessionId,
        }, null);
        if (!result.accepted) controller.abort();
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted && !options.signal?.aborted) {
        promptFailure ??= error;
        cancelRemote();
      }
    }).finally(() => {
      prompts.delete(prompt.requestId);
      pendingResponses.delete(response);
    });
    pendingResponses.add(response);
  });

  try {
    const resultPromise = start(client, interactionId);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const result = await resultPromise;
    finished = true;
    dismissPrompts();
    await Promise.all(pendingResponses);
    options.signal?.throwIfAborted();
    if (promptFailure !== undefined) throw promptFailure;
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw promptFailure ?? error;
  } finally {
    finished = true;
    options.signal?.removeEventListener('abort', abort);
    dismissPrompts();
    unsubscribe();
  }
};

/** Credentials stay in the Pi auth flow, never in provider config or renderer persistence. */
export const loginPiProvider = (options: PiProviderLoginOptions) => runProviderInteraction(
  options,
  (client, interactionId) => client.request('provider.login', {
    cwd: options.cwd,
    interactionId,
    providerId: options.providerId,
    type: options.type,
  }, null),
);
