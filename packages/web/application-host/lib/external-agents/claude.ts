import { randomUUID } from 'node:crypto';
import type { ExternalAgentCapabilities } from '@varin/application-client';
import { fileInputText } from './attachments.js';
import { dedicatedOptions } from './dedicated-options.js';
import { ClaudeContent } from './claude-content.js';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import { HarnessTransport, record, text } from './transport.js';

const claudeModels = (models: unknown): ExternalAgentCapabilities['models'] =>
  (Array.isArray(models) ? models : [])
    .map((value) => ({
      id: text(record(value).value),
      name: text(record(value).displayName) || text(record(value).value),
      thinkingLevels: Array.isArray(record(value).supportedEffortLevels)
        ? (record(value).supportedEffortLevels as string[])
        : undefined,
    }))
    .filter((model) => model.id);

export async function connectClaude(
  peer: HarnessTransport,
  launcher: { command: string; args: string[] },
  cwd: string,
  existing?: string,
): Promise<HarnessConnection> {
  let sink: HarnessSink | undefined;
  let finish: ((result: Awaited<ReturnType<HarnessConnection['prompt']>>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let stopped = false;
  let content: ClaudeContent | undefined;
  let sessionId = '';
  let failure: Error | undefined;
  let active = false;
  let turnId: string | undefined;
  let settled = false;
  let started = false;
  const capabilities: ExternalAgentCapabilities = {
    resume: true,
    images: true,
    files: 'paths',
    steering: false,
    models: [],
  };
  const changes = new Set<() => void>();
  const permissions = new Map<string, AbortController>();
  let callbacks = new AbortController();
  const failures = new Set<(error: Error) => void>();
  const markFailed = (error: Error) => {
    if (failure) return;
    failure = error;
    callbacks.abort(error);
    fail?.(error);
    for (const listener of failures) listener(error);
  };
  peer.onMessage((frame) => {
    const params = record(frame.params);
    const message = record(params.message);
    if (frame.method === 'failure') {
      markFailed(new Error(text(params.message) || 'Claude SDK session ended'));
      return;
    }
    if (frame.method === 'notice') {
      if (sink && active && !settled && params.sessionId === sessionId && params.turnId === turnId)
        sink.item({
          id: `bridge-notice:${turnId}`,
          kind: 'notice',
          text: text(params.message),
          complete: true,
        });
      return;
    }
    if (frame.method === 'admission_cancelled') {
      if (!sink || !active || settled || params.sessionId !== sessionId || params.turnId !== turnId)
        return;
      settled = true;
      callbacks.abort(new Error('Claude input was withdrawn before native delivery'));
      finish?.({ status: 'cancelled' });
      return;
    }
    if (frame.method === 'permission_cancelled') {
      if (params.sessionId !== sessionId || params.turnId !== turnId) return;
      const controller = permissions.get(text(params.id));
      controller?.abort(new Error('Claude withdrew the permission request'));
      return;
    }
    if (frame.method === 'capabilities' && params.sessionId === sessionId && capabilities) {
      if (params.current) capabilities.current = record(params.current);
      if (text(params.agentVersion))
        capabilities.protocol = {
          ...capabilities.protocol!,
          agentVersion: text(params.agentVersion),
        };
      if (Array.isArray(params.commands))
        capabilities.commands = params.commands.map((value) => ({
          name: text(record(value).name),
          description: text(record(value).description),
          ...(text(record(value).argumentHint)
            ? { inputHint: text(record(value).argumentHint) }
            : {}),
        }));
      for (const listener of changes) listener();
      return;
    }
    if (!sink || !active || settled || frame.method !== 'message') return;
    if (
      params.sessionId !== sessionId ||
      params.turnId !== turnId ||
      message.session_id !== sessionId
    )
      return;
    if (!started && ['assistant', 'stream_event', 'result'].includes(text(message.type))) {
      started = true;
      sink.started?.(turnId!);
    }
    content?.receive(message);
    if (message.type === 'result') {
      const usage = record(message.usage);
      sink.usage({
        input: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        output: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        cachedInput:
          typeof usage.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : undefined,
        cacheCreated:
          typeof usage.cache_creation_input_tokens === 'number'
            ? usage.cache_creation_input_tokens
            : undefined,
        inputIncludesCache: false,
        scope: 'turn',
      });
      settled = true;
      callbacks.abort(new Error('The Claude turn settled'));
      finish?.({
        nativeId: turnId,
        status:
          message.terminal_reason === 'aborted_streaming' ||
          message.terminal_reason === 'aborted_tools'
            ? 'cancelled'
            : message.is_error ||
                (typeof message.subtype === 'string' && message.subtype.startsWith('error_'))
              ? 'failed'
              : 'completed',
        error: message.is_error
          ? Array.isArray(message.errors)
            ? message.errors.join('\n')
            : text(message.result)
          : undefined,
      });
    }
  });
  peer.onExit(markFailed);
  peer.onRequest(async (message) => {
    const p = record(message.params);
    if (
      !sink ||
      !active ||
      settled ||
      failure ||
      p.sessionId !== sessionId ||
      p.turnId !== turnId ||
      message.method !== 'permission'
    )
      throw new Error('Claude interaction has no active turn');
    const owner = sink;
    const controller = new AbortController();
    permissions.set(String(message.id), controller);
    const signal = AbortSignal.any([callbacks.signal, controller.signal]);
    const interaction: HarnessSink['interaction'] = async (request) => {
      try {
        const response = await owner.interaction(
          { ...request, id: JSON.stringify([sessionId, turnId, request.id]) },
          signal,
        );
        return signal.aborted || sink !== owner || settled ? { cancelled: true } : response;
      } catch (error) {
        if (signal.aborted) return { cancelled: true };
        throw error;
      }
    };
    try {
      const input = record(p.input);
      if (p.name === 'AskUserQuestion') {
        const questions = (Array.isArray(input.questions) ? input.questions : []).map(
          (value, index) => {
            const q = record(value);
            return {
              id: String(index),
              question: text(q.question),
              multiple: q.multiSelect === true,
              options: (Array.isArray(q.options) ? q.options : []).map((value) => ({
                label: text(record(value).label),
                description: text(record(value).description),
              })),
            };
          },
        );
        const response = await interaction({
          id: String(message.id),
          kind: 'question',
          title: 'Claude Code',
          questions,
          options: [],
        });
        if (response.cancelled)
          return { behavior: 'deny', message: 'The interaction was cancelled' };
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: Object.fromEntries(
              questions.map((q) => [q.question, (response.answers?.[q.id] ?? []).join(', ')]),
            ),
          },
        };
      }
      const suggestions = Array.isArray(p.suggestions) ? p.suggestions : [];
      const options = [
        { id: 'allow', label: 'Allow once' },
        ...(suggestions.length
          ? [{ id: 'rule', label: 'Allow with the proposed permission rule' }]
          : []),
        { id: 'deny', label: 'Deny' },
      ];
      const response = await interaction({
        id: String(message.id),
        kind: 'permission',
        title: text(p.name),
        detail: JSON.stringify(
          suggestions.length ? { input, proposedPermissionRules: suggestions } : input,
          null,
          2,
        ),
        options,
      });
      if (!response.cancelled && (response.optionId === 'allow' || response.optionId === 'rule'))
        return {
          behavior: 'allow',
          updatedInput: input,
          ...(response.optionId === 'rule' ? { updatedPermissions: suggestions } : {}),
        };
      return { behavior: 'deny', message: 'User declined this operation' };
    } finally {
      permissions.delete(String(message.id));
    }
  });
  const initialized = await peer.request('initialize', {
    launcher,
    cwd,
    ...(existing ? { sessionId: existing } : {}),
  });
  sessionId = text(initialized.sessionId);
  if (!sessionId || (existing && existing !== sessionId))
    throw new Error('Claude did not restore the selected session');
  if (failure) throw failure;
  if (initialized.bridgeProtocol !== 2)
    throw new Error('Claude bridge protocol mismatch; restart the Application Host');
  Object.assign(capabilities, {
    resume: true,
    images: true,
    steering: false,
    protocol: {
      name: 'claude-agent-sdk',
      version: '0.3.316',
      ...(text(initialized.agentVersion) ? { agentVersion: text(initialized.agentVersion) } : {}),
    },
    current: record(initialized.current),
    commands: (Array.isArray(initialized.commands) ? initialized.commands : []).map((value) => ({
      name: text(record(value).name),
      description: text(record(value).description),
      ...(text(record(value).argumentHint) ? { inputHint: text(record(value).argumentHint) } : {}),
    })),
    models: claudeModels(initialized.models),
    modelsError: Array.isArray(initialized.models)
      ? undefined
      : 'Claude did not supply a model catalog; reconnect to obtain native session metadata',
  });
  return {
    sessionId,
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
    capabilities,
    onCapabilities(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    async prompt(input, next) {
      if (failure) throw failure;
      if (sink) throw new Error('Claude is already running');
      const selected = dedicatedOptions(input, 'Claude');
      if (
        input.images?.some(
          (image) =>
            !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType),
        )
      )
        throw new Error('Unsupported Claude image type');
      sink = next;
      turnId = randomUUID();
      settled = false;
      started = false;
      stopped = false;
      active = false;
      callbacks = new AbortController();
      content = new ClaudeContent((item) => next.item(item));
      try {
        const completion = new Promise<Awaited<ReturnType<HarnessConnection['prompt']>>>(
          (resolve, reject) => {
            finish = resolve;
            fail = reject;
          },
        );
        void completion.catch(() => {});
        const configured = await peer.request('configure', selected);
        if (configured.current) capabilities.current = record(configured.current);
        for (const listener of changes) listener();
        if (failure) throw failure;
        if (stopped) return { status: 'cancelled' };
        await next.beforeDispatch?.();
        if (failure) throw failure;
        if (stopped) return { status: 'cancelled' };
        active = true;
        const accepted = await peer.request('prompt', {
          text: fileInputText(input),
          images: input.images,
          uuid: turnId,
        });
        if (accepted.cancelled) return { status: 'cancelled' };
        if (accepted.accepted !== true || accepted.turnId !== turnId) {
          const error = new Error(
            'Claude did not confirm the accepted input identity; review native history before retrying',
          );
          markFailed(error);
          throw error;
        }
        return await completion;
      } finally {
        active = false;
        callbacks.abort(new Error('The Claude turn ended'));
        content = undefined;
        sink = undefined;
        finish = undefined;
        fail = undefined;
        turnId = undefined;
      }
    },
    async stop() {
      stopped = true;
      callbacks.abort(new Error('The Claude interaction was cancelled'));
      if (failure) throw failure;
      if (active) await peer.request('interrupt');
    },
    close: () => peer.close(),
  };
}
