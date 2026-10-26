import type { ExternalAgentCapabilities, ExternalItem } from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import { HarnessTransport, record, text, clientInfo } from './transport.js';

export async function connectAcp(
  peer: HarnessTransport,
  cwd: string,
  existing?: string,
): Promise<HarnessConnection> {
  const init = await peer.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo,
  });
  const caps = record(init.agentCapabilities);
  if (existing && caps.loadSession !== true)
    throw new Error('This ACP Agent does not support restoring a saved session');
  const opened = await peer.request(existing ? 'session/load' : 'session/new', {
    cwd,
    mcpServers: [],
    ...(existing ? { sessionId: existing } : {}),
  });
  const sessionId = existing ?? text(opened.sessionId);
  if (!sessionId) throw new Error('ACP Agent did not return a session identity');
  const config = Array.isArray(opened.configOptions) ? opened.configOptions.map(record) : [];
  const modelConfig = config.find((value) => value.category === 'model');
  const choices =
    modelConfig && Array.isArray(modelConfig.options)
      ? modelConfig.options.flatMap((value) => {
          const v = record(value);
          return Array.isArray(v.options) ? v.options : [v];
        })
      : [];
  const models = choices.length
    ? choices.map((value) => ({ id: text(record(value).value), name: text(record(value).name) }))
    : (Array.isArray(record(opened.models).availableModels)
        ? (record(opened.models).availableModels as unknown[])
        : []
      ).map((value) => ({ id: text(record(value).modelId), name: text(record(value).name) }));
  const capabilities: ExternalAgentCapabilities = {
    resume: caps.loadSession === true,
    images: record(caps.promptCapabilities).image === true,
    steering: false,
    models,
    modes: (Array.isArray(record(opened.modes).availableModes)
      ? (record(opened.modes).availableModes as unknown[])
      : []
    ).map((value) => ({ id: text(record(value).id), name: text(record(value).name) })),
  };
  let sink: HarnessSink | undefined;
  let stopped = false;
  let segment = 0;
  let lastKind = '';
  const items = new Map<string, Omit<ExternalItem, 'turnId'>>();
  peer.onMessage((message) => {
    const p = record(message.params);
    if (!sink || message.method !== 'session/update' || p.sessionId !== sessionId) return;
    const u = record(p.update),
      kind = text(u.sessionUpdate);
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      if (lastKind !== kind) segment++;
      lastKind = kind;
      const id = `message:${segment}`,
        content = record(u.content);
      if (content.type !== 'text') return;
      const item = {
        id,
        kind: kind === 'agent_message_chunk' ? ('assistant' as const) : ('reasoning' as const),
        text: (items.get(id)?.text ?? '') + text(content.text),
      };
      items.set(id, item);
      sink.item(item);
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      lastKind = kind;
      const id = text(u.toolCallId),
        previous = items.get(id);
      const item: Omit<ExternalItem, 'turnId'> = {
        id,
        kind: 'tool',
        text: '',
        tool: {
          name: text(u.title) || previous?.tool?.name || text(u.kind) || 'Tool',
          input: u.rawInput ?? previous?.tool?.input,
          output: u.rawOutput ?? u.content ?? previous?.tool?.output,
          status:
            u.status === 'completed'
              ? 'completed'
              : u.status === 'failed'
                ? 'failed'
                : (previous?.tool?.status ?? 'running'),
        },
      };
      items.set(id, item);
      sink.item(item);
    } else if (kind === 'plan')
      sink.item({
        id: 'plan',
        kind: 'plan',
        complete: true,
        text: (Array.isArray(u.entries) ? u.entries : [])
          .map(
            (value) =>
              `${record(value).status === 'completed' ? '- [x]' : record(value).status === 'in_progress' ? '- [/]' : '- [ ]'} ${text(record(value).content)}`,
          )
          .join('\n'),
      });
  });
  peer.onRequest(async (message) => {
    const p = record(message.params);
    if (message.method !== 'session/request_permission' || p.sessionId !== sessionId || !sink)
      throw new Error('Unsupported ACP callback');
    const options = (Array.isArray(p.options) ? p.options : []).map((value) => ({
      id: text(record(value).optionId),
      label: text(record(value).name),
    }));
    const response = await sink.interaction({
      id: String(message.id),
      kind: 'permission',
      title: text(record(p.toolCall).title) || 'Permission requested',
      options,
    });
    return options.some((value) => value.id === response.optionId)
      ? { outcome: { outcome: 'selected', optionId: response.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  });
  return {
    sessionId,
    capabilities,
    async prompt(input, next) {
      if (sink) throw new Error('ACP Agent is already running');
      sink = next;
      items.clear();
      segment = 0;
      lastKind = '';
      stopped = false;
      try {
        if (input.model)
          await peer.request(modelConfig ? 'session/set_config_option' : 'session/set_model', {
            sessionId,
            ...(modelConfig ? { configId: modelConfig.id, value: input.model } : { modelId: input.model }),
          });
        if (input.mode) await peer.request('session/set_mode', { sessionId, modeId: input.mode });
        if (stopped) return { status: 'cancelled' };
        const response = await peer.request('session/prompt', {
          sessionId,
          prompt: [
            { type: 'text', text: input.text },
            ...(input.images ?? []).map((image) => ({
              type: 'image',
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
        });
        return {
          status:
            response.stopReason === 'cancelled'
              ? 'cancelled'
              : response.stopReason === 'end_turn'
                ? 'completed'
                : 'failed',
          error:
            response.stopReason !== 'end_turn' && response.stopReason !== 'cancelled'
              ? `ACP turn ended: ${text(response.stopReason)}`
              : undefined,
        };
      } finally {
        sink = undefined;
      }
    },
    stop: () => {
      stopped = true;
      return peer.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    },
    close: () => peer.close(),
  };
}
