import { randomUUID } from 'node:crypto';
import type { ExternalAgentCapabilities } from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import { dedicatedOptions } from './dedicated-options.js';
import { PiContent } from './pi-content.js';
import { requirePiRpcVersion } from './pi-version.js';
import {
  HarnessProtocolError,
  HarnessTransport,
  record,
  text,
  type RecordValue,
} from './transport.js';

export async function connectPi(
  peer: HarnessTransport,
  existing?: string,
  options: { version?: string } = {},
): Promise<HarnessConnection> {
  const version = requirePiRpcVersion(options.version);
  const state = await peer.request('get_state');
  const sessionId = text(state.sessionFile) || text(state.sessionId);
  if (!sessionId || (existing && existing !== sessionId))
    throw new Error('Pi did not restore the selected session');
  let modelsError: string | undefined;
  const available: RecordValue = await peer.request('get_available_models').catch((error) => {
    modelsError = String(error);
    return {};
  });
  if (!Array.isArray(available.models) && !modelsError)
    modelsError = 'Pi did not supply a model catalog';
  const commands: RecordValue = await peer.request('get_commands').catch(() => ({}));
  const models = (available: RecordValue) =>
    (Array.isArray(available.models) ? available.models : [])
      .map((value) => {
        const model = record(value);
        return {
          id: `${text(model.provider)}/${text(model.id)}`,
          name: text(model.name) || text(model.id),
        };
      })
      .filter((model) => model.id.split('/').every(Boolean));
  const capabilities: ExternalAgentCapabilities = {
    resume: true,
    images: true,
    steering: false,
    modelsError,
    modelsRefresh: true,
    protocol: { name: 'pi-rpc', agentVersion: version },
    current: {},
    models: models(available),
    commands: (Array.isArray(commands.commands) ? commands.commands : [])
      .map((value) => {
        const command = record(value);
        return { name: text(command.name), description: text(command.description) };
      })
      .filter((command) => command.name),
  };
  let lifecycleRevision = 0;
  let sessionBusy =
    state.isStreaming === true ||
    state.isCompacting === true ||
    Number(state.pendingMessageCount) > 0;
  const changed = new Set<() => void>(),
    failures = new Set<(error: Error) => void>();
  const notify = () => {
    for (const listener of changed) listener();
  };
  const applyState = (value: RecordValue) => {
    const model = record(value.model);
    capabilities.current = {
      ...(text(model.provider) && text(model.id)
        ? { model: `${text(model.provider)}/${text(model.id)}` }
        : {}),
      ...(text(value.thinkingLevel) ? { thinking: text(value.thinkingLevel) } : {}),
    };
    notify();
  };
  applyState(state);
  const refresh = async () => {
    const before = lifecycleRevision,
      current = await peer.request('get_state');
    if ((text(current.sessionFile) || text(current.sessionId)) !== sessionId) {
      const error = new Error(
        'Pi changed the selected native session identity; reconnect and review before sending input',
      );
      markFailed(error);
      throw error;
    }
    if (before === lifecycleRevision)
      sessionBusy =
        current.isStreaming === true ||
        current.isCompacting === true ||
        Number(current.pendingMessageCount) > 0;
    applyState(current);
    const response = await peer.request('get_available_thinking_levels');
    const levels = (Array.isArray(response.levels) ? response.levels : []).filter(
      (value): value is string => typeof value === 'string',
    );
    for (const model of capabilities.models)
      if (model.id === capabilities.current?.model) model.thinkingLevels = levels;
    notify();
  };
  let failure: Error | undefined;
  let sink: HarnessSink | undefined, content: PiContent | undefined;
  let finish: ((result: Awaited<ReturnType<HarnessConnection['prompt']>>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let stopped = false,
    dispatched = false,
    runStarted = false,
    settled = false;
  let admission = '';
  let interactions = new AbortController();
  const pending = new Set<string>();
  const markFailed = (error: Error) => {
    if (failure) return;
    failure = error;
    interactions.abort(error);
    fail?.(error);
    for (const listener of failures) listener(error);
  };
  const respond = async (event: RecordValue, owner: HarnessSink, signal: AbortSignal) => {
    const id = text(event.id),
      method = text(event.method);
    if (!id || pending.has(id)) return;
    pending.add(id);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    // This is the native dialog's own expiry, not a guessed model/run deadline.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (typeof event.timeout === 'number' && event.timeout >= 0 && Number.isFinite(event.timeout)) {
      const expires = performance.now() + event.timeout;
      const expire = () => {
        const remaining = expires - performance.now();
        if (remaining <= 0) controller.abort(new Error('Pi dialog expired'));
        // Node's timer ceiling is a scheduling chunk, not a dialog time limit.
        else timeout = setTimeout(expire, Math.min(remaining, 0x7fffffff));
      };
      expire();
    }
    try {
      const answer = await owner.interaction(
        {
          id: JSON.stringify([sessionId, admission, id]),
          kind: 'question',
          title: text(event.title) || 'Pi',
          detail: text(event.message),
          ...(method === 'input' || method === 'editor'
            ? {
                fields: [
                  {
                    id: 'value',
                    label: text(event.title) || 'Response',
                    type: 'text' as const,
                    defaultValue: text(event.prefill),
                  },
                ],
              }
            : {}),
          options:
            method === 'confirm'
              ? [
                  { id: 'yes', label: 'Yes' },
                  { id: 'no', label: 'No' },
                ]
              : (Array.isArray(event.options) ? event.options : []).map((value) => ({
                  id: String(value),
                  label: String(value),
                })),
        },
        combined,
      );
      if (answer.cancelled || combined.aborted || sink !== owner || settled)
        await peer.send({ type: 'extension_ui_response', id, cancelled: true });
      else
        await peer.send({
          type: 'extension_ui_response',
          id,
          ...(method === 'confirm'
            ? { confirmed: answer.optionId === 'yes' }
            : { value: answer.optionId ?? answer.values?.value ?? answer.text ?? '' }),
        });
    } catch (error) {
      if (combined.aborted) await peer.send({ type: 'extension_ui_response', id, cancelled: true });
      else throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      pending.delete(id);
    }
  };
  peer.onMessage((event) => {
    if (event.type === 'agent_start') {
      sessionBusy = true;
      lifecycleRevision++;
    }
    if (event.type === 'agent_settled') {
      sessionBusy = false;
      lifecycleRevision++;
    }
    if (event.type === 'thinking_level_changed') {
      capabilities.current = { ...capabilities.current, thinking: text(event.level) };
      notify();
    }
    if (event.type === 'extension_ui_request') {
      const method = text(event.method),
        id = text(event.id);
      if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(method)) {
        if (sink && dispatched && !settled && (method === 'notify' || method === 'setStatus'))
          sink.item({
            id: `${admission}:notice:${id}`,
            kind: 'notice',
            text: text(event.message ?? event.statusText ?? event.text),
          });
        return;
      }
      if (
        !sink ||
        !dispatched ||
        settled ||
        !['select', 'confirm', 'input', 'editor'].includes(method)
      ) {
        if (id)
          void peer.send({ type: 'extension_ui_response', id, cancelled: true }).catch(markFailed);
        return;
      }
      void respond(event, sink, interactions.signal).catch(markFailed);
      return;
    }
    if (!sink || !dispatched || settled) return;
    if (event.type === 'agent_start') runStarted = true;
    // Pi has no native run ID. Its ordered session lifecycle is the ownership
    // boundary; never attribute idle/pre-start/previous-settlement frames.
    if (!runStarted) return;
    content?.receive(event);
    if (event.type === 'agent_settled') {
      settled = true;
      const last = content?.lastAssistant;
      finish?.({
        status:
          event.aborted === true || last?.stopReason === 'aborted'
            ? 'cancelled'
            : last?.stopReason === 'error'
              ? 'failed'
              : 'completed',
        ...(last?.stopReason === 'error'
          ? { error: text(last.errorMessage) || 'Pi assistant failed' }
          : {}),
      });
      interactions.abort(new Error('The Pi turn settled'));
    }
  });
  const settledMetadata = async () => {
    try {
      await refresh();
    } catch {
      delete capabilities.current;
      notify();
    }
  };
  peer.onExit(markFailed);
  await refresh();
  return {
    sessionId,
    capabilities,
    get failure() {
      return failure;
    },
    onFailure(listener) {
      failures.add(listener);
      if (failure) queueMicrotask(() => listener(failure!));
      return () => {
        failures.delete(listener);
      };
    },
    onCapabilities(listener) {
      changed.add(listener);
      return () => {
        changed.delete(listener);
      };
    },
    async refreshCapabilities() {
      if (failure) throw failure;
      try {
        const available = await peer.request('get_available_models');
        if (!Array.isArray(available.models))
          throw new Error('Pi returned an invalid model catalog');
        capabilities.models = models(available);
        capabilities.modelsError = undefined;
      } catch (error) {
        capabilities.modelsError = String(error);
      }
      await refresh();
    },
    async prompt(input, next) {
      if (failure) throw failure;
      if (sink) throw new Error('Pi is already running');
      if (sessionBusy)
        throw new Error(
          'Pi session still has independent native work; wait for session settlement before sending another prompt',
        );
      const selected = dedicatedOptions(input, 'Pi');
      sink = next;
      stopped = false;
      dispatched = false;
      runStarted = false;
      settled = false;
      admission = randomUUID();
      interactions = new AbortController();
      content = new PiContent(
        `${sessionId}:${admission}`,
        (item) => next.item(item),
        (usage) => next.usage(usage),
      );
      try {
        if (selected.model) {
          const slash = selected.model.indexOf('/');
          if (slash < 1 || slash === selected.model.length - 1)
            throw new Error('Pi model must include its provider');
          await peer.request('set_model', {
            provider: selected.model.slice(0, slash),
            modelId: selected.model.slice(slash + 1),
          });
        }
        if (selected.thinking)
          await peer.request('set_thinking_level', { level: selected.thinking });
        await refresh();
        if (failure) throw failure;
        if (sessionBusy)
          throw new Error(
            'Pi session started independent native work while configuring; no input was sent',
          );
        if (stopped) return { status: 'cancelled' };
        const completion = new Promise<Awaited<ReturnType<HarnessConnection['prompt']>>>(
          (resolve, reject) => {
            finish = resolve;
            fail = reject;
          },
        );
        void completion.catch(() => {});
        await next.beforeDispatch?.();
        if (failure) throw failure;
        if (stopped) return { status: 'cancelled' };
        dispatched = true;
        let accepted: RecordValue;
        try {
          accepted = await peer.request('prompt', {
            message: input.text,
            ...(input.images?.length
              ? {
                  images: input.images.map((image) => ({
                    type: 'image',
                    data: image.data,
                    mimeType: image.mimeType,
                  })),
                }
              : {}),
          });
        } catch (error) {
          // Pi >=1.5 explicitly defines a negative prompt response as rejection
          // before acceptance. A timeout, lost pipe, or observed native run is
          // not that receipt and must retain uncertain-delivery handling.
          if (
            !runStarted &&
            error instanceof HarnessProtocolError &&
            error.method === 'prompt' &&
            error.code !== 'request_timeout'
          ) {
            settled = true;
            return { status: 'failed', error: error.message };
          }
          throw error;
        }
        if (accepted.disposition === 'handled') {
          await settledMetadata();
          return { status: 'completed' };
        }
        if (accepted.disposition !== 'started') {
          const error = new Error(
            `Pi returned an unsupported prompt disposition: ${text(accepted.disposition) || 'missing'}. The input may have been accepted; reconnect and review native history before retrying.`,
          );
          markFailed(error);
          throw error;
        }
        if (stopped && !settled) await peer.request('abort');
        const result = await completion;
        await settledMetadata();
        return result;
      } finally {
        interactions.abort(new Error('The Pi admission ended'));
        sink = undefined;
        content = undefined;
        finish = undefined;
        fail = undefined;
        dispatched = false;
      }
    },
    async stop() {
      stopped = true;
      interactions.abort(new Error('The Pi interaction was cancelled'));
      if (failure) throw failure;
      if (dispatched && !settled) await peer.request('abort');
    },
    close: () => peer.close(),
  };
}
