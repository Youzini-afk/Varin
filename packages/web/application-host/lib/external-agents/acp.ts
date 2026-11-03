import { pathToFileURL } from 'node:url';
import {
  ExternalAgentError,
  type ExternalAgentCapabilities,
  type ExternalAgentProfile,
  type ExternalAuthentication,
  type ExternalItem,
} from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import {
  HarnessTransport,
  record,
  text,
  clientInfo,
  type RecordValue,
} from './transport.js';
import { AcpOptions } from './acp-options.js';
import { acpContent, acpToolItem } from './acp-content.js';
import {
  acpForm,
  acpPermission,
  grokInteraction,
  type AcpInteraction,
} from './acp-interactions.js';

export interface AcpConnectOptions {
  profile?: ExternalAgentProfile | undefined;
  authMethodId?: string | undefined;
}

function authentication(
  init: RecordValue,
  profile?: ExternalAgentProfile,
): ExternalAuthentication {
  return {
    methods: (Array.isArray(init.authMethods) ? init.authMethods : []).flatMap(
      (value) => {
        const method = record(value);
        if (!text(method.id) || !text(method.name)) return [];
        return [
          {
            id: text(method.id),
            name: text(method.name),
            type:
              method.type === 'terminal'
                ? ('terminal' as const)
                : ('agent' as const),
            ...(typeof method.description === 'string'
              ? { description: method.description }
              : {}),
            ...(typeof method.command === 'string'
              ? { command: method.command }
              : {}),
            ...(Array.isArray(method.args) &&
            method.args.every((arg) => typeof arg === 'string')
              ? { args: method.args as string[] }
              : {}),
          },
        ];
      },
    ),
    ...(profile?.authentication ? { guidance: profile.authentication } : {}),
  };
}

function authError(error: unknown, auth: ExternalAuthentication): unknown {
  if (
    record(error).code === -32000 ||
    (error instanceof Error &&
      /authentication required|not authenticated/i.test(error.message))
  )
    return new ExternalAgentError(
      'authentication_required',
      'Authenticate with this external Agent before opening the session.',
      401,
      { authentication: auth },
    );
  return error;
}

export async function connectAcp(
  peer: HarnessTransport,
  cwd: string,
  existing?: string,
  options: AcpConnectOptions = {},
): Promise<HarnessConnection> {
  let sessionId = existing ?? '';
  let sink: HarnessSink | undefined;
  let dispatched = false;
  let stopped = false;
  let closed = false;
  let failure: Error | undefined;
  let segment = 0,
    lastKind = '';
  const items = new Map<string, Omit<ExternalItem, 'turnId'>>();
  const requests = new Map<string, AbortController>();
  const capabilityListeners = new Set<() => void>();
  const failureListeners = new Set<(error: Error) => void>();
  const capabilities: ExternalAgentCapabilities = {
    resume: false,
    images: false,
    files: 'resource_links',
    steering: false,
    models: [],
  };
  const state = new AcpOptions(
    capabilities,
    () => {
      for (const listener of capabilityListeners) listener();
    },
    options.profile?.id === 'grok' ? 'grok' : undefined,
  );
  let opening = true;
  const early = new Map<string, RecordValue>();
  const withdraw = () => {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  };
  const failed = (error: Error) => {
    if (failure) return;
    failure = error;
    withdraw();
    for (const listener of failureListeners) listener(error);
  };
  const removeExit = peer.onExit(failed);
  const removeMessage = peer.onMessage((message) => {
    const params = record(message.params);
    if (
      options.profile?.id === 'grok' &&
      message.method === '_x.ai/models/update'
    ) {
      state.catalog(params);
      return;
    }
    if (message.method === '$/cancel_request') {
      requests.get(String(params.requestId ?? params.id))?.abort();
      return;
    }
    if (message.method !== 'session/update') return;
    const update = record(params.update),
      kind = text(update.sessionUpdate);
    if (opening) {
      if (
        [
          'config_option_update',
          'current_mode_update',
          'available_commands_update',
        ].includes(kind)
      )
        early.set(`${text(params.sessionId)}:${kind}`, params);
      return;
    }
    if (params.sessionId !== sessionId) return;
    state.update(update);
    if (!sink || !dispatched) return;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      if (lastKind !== kind) segment++;
      lastKind = kind;
      const id = `message:${segment}`,
        content = acpContent(update.content),
        previous = items.get(id);
      if (!content.text && !content.images?.length) return;
      const images = [...(previous?.images ?? []), ...(content.images ?? [])];
      const item = {
        id,
        kind:
          kind === 'agent_message_chunk'
            ? ('assistant' as const)
            : ('reasoning' as const),
        text: (previous?.text ?? '') + content.text,
        ...(images.length ? { images } : {}),
      };
      items.set(id, item);
      sink.item(item);
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      lastKind = kind;
      const item = acpToolItem(update, items.get(text(update.toolCallId)));
      if (item) {
        items.set(item.id, item);
        sink.item(item);
      }
    } else if (kind === 'plan') {
      sink.item({
        id: 'plan',
        kind: 'plan',
        complete: true,
        text: (Array.isArray(update.entries) ? update.entries : [])
          .map(
            (entry) =>
              `${record(entry).status === 'completed' ? '- [x]' : record(entry).status === 'in_progress' ? '- [/]' : '- [ ]'} ${text(record(entry).content)}`,
          )
          .join('\n'),
      });
    }
    // usage_update.used/size is context occupancy, not billable input/output tokens.
  });

  async function answer(
    id: string,
    interaction: AcpInteraction,
  ): Promise<unknown> {
    const owner = sink;
    if (!owner || !dispatched || stopped || closed || failure)
      return interaction.cancelled;
    if (requests.has(id)) throw new Error('Duplicate ACP interaction identity');
    const controller = new AbortController();
    requests.set(id, controller);
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      const response = await Promise.race([
        owner.interaction(interaction.request, controller.signal),
        cancelled,
      ]);
      return response && !controller.signal.aborted
        ? interaction.reply(response)
        : interaction.cancelled;
    } catch {
      return interaction.cancelled;
    } finally {
      if (abort) controller.signal.removeEventListener('abort', abort);
      controller.abort();
      if (requests.get(id) === controller) requests.delete(id);
    }
  }
  peer.onRequest(async (message) => {
    const params = record(message.params),
      method = text(message.method),
      id = String(message.id);
    const matches =
      !opening &&
      (params.sessionId === sessionId ||
        (method === 'elicitation/create' && params.sessionId === undefined));
    if (method === 'session/request_permission') {
      const interaction = matches ? acpPermission(id, params) : undefined;
      return interaction
        ? answer(id, interaction)
        : { outcome: { outcome: 'cancelled' } };
    }
    if (method === 'elicitation/create') {
      const interaction = matches ? acpForm(id, params) : undefined;
      return interaction ? answer(id, interaction) : { action: 'decline' };
    }
    if (options.profile?.id === 'grok' && matches) {
      const interaction = grokInteraction(id, method.replace(/^_/, ''), params);
      if (interaction) return answer(id, interaction);
    }
    throw new Error(`Unsupported ACP callback: ${method}`);
  });

  try {
    const init = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: { form: {} },
        session: { configOptions: { boolean: {} } },
      },
      clientInfo,
    });
    if (init.protocolVersion !== undefined && init.protocolVersion !== 1)
      throw new Error('The ACP Agent selected an unsupported protocol version');
    const auth = authentication(init, options.profile);
    capabilities.authentication = auth;
    const caps = record(init.agentCapabilities),
      sessionCaps = record(caps.sessionCapabilities);
    capabilities.resumeMethods = [
      ...(sessionCaps.resume && typeof sessionCaps.resume === 'object'
        ? ['resume' as const]
        : []),
      ...(caps.loadSession === true ? ['load' as const] : []),
    ];
    capabilities.resume = capabilities.resumeMethods.length > 0;
    capabilities.images = record(caps.promptCapabilities).image === true;
    capabilities.protocol = {
      name: 'ACP',
      version: String(init.protocolVersion ?? 1),
      ...(text(record(init.agentInfo).version)
        ? { agentVersion: text(record(init.agentInfo).version) }
        : {}),
    };
    state.catalog(record(init._meta).modelState);
    if (existing && !capabilities.resume)
      throw new ExternalAgentError(
        'resume_unsupported',
        'This ACP Agent cannot restore the saved session. Start a separate conversation to use it without recovery.',
        409,
      );
    if (options.authMethodId !== undefined) {
      const method = auth.methods.find(
        (method) => method.id === options.authMethodId,
      );
      if (!method)
        throw new ExternalAgentError(
          'authentication_method_unavailable',
          'The ACP Agent no longer offers that authentication method.',
          409,
          { authentication: auth },
        );
      if (method.type === 'terminal')
        throw new ExternalAgentError(
          'authentication_required',
          'Complete this authentication method in a terminal on the execution Host, then reconnect.',
          401,
          { authentication: auth },
        );
      await peer
        .request('authenticate', { methodId: method.id })
        .catch((error) => {
          throw authError(error, auth);
        });
    }
    const method = !existing
      ? 'session/new'
      : capabilities.resumeMethods.includes('resume')
        ? 'session/resume'
        : 'session/load';
    const opened = await peer
      .request(method, {
        cwd,
        mcpServers: [],
        ...(existing ? { sessionId: existing } : {}),
      })
      .catch((error) => {
        throw authError(error, auth);
      });
    if (
      existing &&
      typeof opened.sessionId === 'string' &&
      opened.sessionId !== existing
    )
      throw new Error(
        'ACP Agent changed the saved session identity during recovery',
      );
    sessionId = existing ?? text(opened.sessionId);
    if (!sessionId)
      throw new Error('ACP Agent did not return a session identity');
    state.adopt(opened);
    opening = false;
    for (const params of early.values())
      if (params.sessionId === sessionId) state.update(record(params.update));
    early.clear();
    if (failure) throw failure;
  } catch (error) {
    closed = true;
    withdraw();
    removeExit();
    removeMessage();
    throw error;
  }

  return {
    sessionId,
    capabilities,
    get failure() {
      return failure;
    },
    onFailure(listener) {
      failureListeners.add(listener);
      if (failure) listener(failure);
      return () => failureListeners.delete(listener);
    },
    onCapabilities(listener) {
      capabilityListeners.add(listener);
      return () => capabilityListeners.delete(listener);
    },
    async prompt(input, next) {
      if (failure) throw failure;
      if (closed) throw new Error('ACP connection is closed');
      if (sink) throw new Error('ACP Agent is already running');
      if (input.images?.length && !capabilities.images)
        throw new Error(
          'This ACP Agent does not advertise image input support',
        );
      sink = next;
      items.clear();
      segment = 0;
      lastKind = '';
      stopped = false;
      dispatched = false;
      try {
        await state.apply(
          input,
          (method, params) => peer.request(method, params),
          sessionId,
          () => stopped || closed || Boolean(failure),
        );
        if (stopped) return { status: 'cancelled' };
        if (failure) throw failure;
        if (closed) throw new Error('ACP connection is closed');
        await next.beforeDispatch?.();
        if (stopped) return { status: 'cancelled' };
        if (failure) throw failure;
        if (closed) throw new Error('ACP connection is closed');
        dispatched = true;
        const response = await peer.request('session/prompt', {
          sessionId,
          prompt: [
            { type: 'text', text: input.files?.some(file => file.attachment.mimeType.startsWith('image/')) ? `${input.text}\nImages linked as files were not supplied as direct visual input.` : input.text },
            ...(input.files ?? []).map(({ attachment, path }) => ({
              type: 'resource_link', uri: pathToFileURL(path).href,
              name: attachment.filename, mimeType: attachment.mimeType, size: attachment.byteLength,
            })),
            ...(input.images ?? []).map((image) => ({
              type: 'image',
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
        });
        // ACP implementations disagree about prompt usage scope and cache inclusion.
        // Do not book unknown adapter counters as per-turn billable usage.
        for (const item of items.values())
          if (!item.complete && item.kind !== 'tool')
            next.item({ ...item, complete: true });
        const reason = text(response.stopReason);
        return reason === 'end_turn'
          ? { status: 'completed' }
          : reason === 'cancelled'
            ? { status: 'cancelled' }
            : {
                status: 'failed',
                error: `ACP turn ended: ${reason || 'missing stop reason'}`,
              };
      } finally {
        withdraw();
        dispatched = false;
        sink = undefined;
      }
    },
    async stop() {
      stopped = true;
      withdraw();
      if (dispatched && !peer.disconnected)
        await peer.send({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId },
        });
    },
    async close() {
      closed = true;
      withdraw();
      await peer.close();
      removeExit();
      removeMessage();
      capabilityListeners.clear();
      failureListeners.clear();
    },
  };
}
