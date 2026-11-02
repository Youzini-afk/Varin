import type {
  ExternalAgentCapabilities,
  ExternalInput,
  ExternalItem,
  ExternalInteractionResponse,
} from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
import { formInteraction } from './interaction-form.js';
import { dedicatedOptions } from './dedicated-options.js';
import { HarnessTransport, record, text, clientInfo, type RecordValue } from './transport.js';

export async function connectCodex(
  peer: HarnessTransport,
  cwd: string,
  existing?: string,
): Promise<HarnessConnection> {
  await peer.request('initialize', { clientInfo });
  await peer.send({ jsonrpc: '2.0', method: 'initialized' });
  const opened = await peer.request(
    existing ? 'thread/resume' : 'thread/start',
    existing ? { threadId: existing, cwd } : { cwd },
  );
  const sessionId = text(record(opened.thread).id);
  if (!sessionId || (existing && existing !== sessionId))
    throw new Error('Codex did not return the original thread identity');
  let modelsError: string | undefined;
  let stopRequested = false;
  let modelData: unknown[] = [];
  const loadModels = async () => {
    const data: unknown[] = [];
    modelsError = undefined;
    try {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await peer.request('model/list', cursor ? { cursor } : {});
        if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid model catalog');
        data.push(...page.data);
        cursor = text(page.nextCursor) || undefined;
        if (cursor && cursors.has(cursor))
          throw new Error('Codex repeated its model catalog cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch (error) {
      modelsError = String(error);
    }
    if (!modelsError || !modelData.length) modelData = data;
  };
  await loadModels();

  const models = () =>
    modelData
      .map((value) => {
        const model = record(value);
        return {
          id: text(model.model ?? model.id),
          name: text(model.displayName ?? model.model ?? model.id),
          thinkingLevels: (Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
            : []
          )
            .map((value) => text(record(value).reasoningEffort))
            .filter(Boolean),
        };
      })
      .filter((value) => value.id);
  const capabilities: ExternalAgentCapabilities = {
    resume: true,
    images: true,
    steering: false,
    modelsError,
    modelsRefresh: true,
    protocol: {
      name: 'codex-app-server',
      ...(text(record(opened.thread).cliVersion)
        ? { agentVersion: text(record(opened.thread).cliVersion) }
        : {}),
    },
    current: {
      ...(text(opened.model) ? { model: text(opened.model) } : {}),
      ...(text(opened.reasoningEffort) ? { thinking: text(opened.reasoningEffort) } : {}),
    },
    models: models(),
  };
  let sink: HarnessSink | undefined;
  let turnId: string | undefined;
  let dispatched = false;
  let settled = false;
  let identity: Promise<string | undefined> = Promise.resolve(undefined);
  let identify: ((id: string | undefined) => void) | undefined;
  let interactions = new AbortController();
  let buffered: RecordValue[] = [];
  const pendingInteractions = new Map<string, AbortController>();
  let finish: ((result: Awaited<ReturnType<HarnessConnection['prompt']>>) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let failure: Error | undefined;
  const failures = new Set<(error: Error) => void>();
  const changed = new Set<() => void>();
  const markFailed = (error: Error) => {
    if (failure) return;
    failure = error;
    interactions.abort(error);
    identify?.(undefined);
    reject?.(error);
    for (const listener of failures) listener(error);
  };
  const items = new Map<string, Omit<ExternalItem, 'turnId'>>();
  type Counters = { input: number; output: number; cachedInput: number; cacheCreated: number };
  let cumulative: Counters | undefined = existing
    ? undefined
    : { input: 0, output: 0, cachedInput: 0, cacheCreated: 0 };
  let baseline: Counters | undefined;
  const publish = (id: string, patch: Partial<Omit<ExternalItem, 'turnId'>>) => {
    if (!id) return;
    const item = { id, kind: 'assistant' as const, text: '', ...items.get(id), ...patch };
    items.set(id, item);
    sink?.item(item);
  };
  const translate = (raw: RecordValue, complete: boolean) => {
    const id = text(raw.id);
    if (!id) return;
    const type = text(raw.type);
    if (type === 'agentMessage')
      publish(id, {
        kind: 'assistant',
        complete,
        text: typeof raw.text === 'string' ? raw.text : (items.get(id)?.text ?? ''),
      });
    else if (type === 'reasoning')
      publish(id, {
        kind: 'reasoning',
        complete,
        text:
          (Array.isArray(raw.summary) ? raw.summary : [])
            .map((value) => (typeof value === 'string' ? value : text(record(value).text)))
            .join('\n') ||
          items.get(id)?.text ||
          '',
      });
    else if (type !== 'userMessage')
      publish(id, {
        kind: 'tool',
        text: '',
        tool: {
          name: type,
          input: raw,
          output: raw.aggregatedOutput ?? raw.result ?? raw.changes,
          command: text(raw.command) || undefined,
          status:
            raw.status === 'failed' || raw.status === 'declined'
              ? 'failed'
              : complete
                ? 'completed'
                : 'running',
        },
      });
  };
  const receive = (message: RecordValue) => {
    if (!sink || !dispatched || settled) return;
    const params = record(message.params);
    if (params.threadId !== sessionId) return;
    if (message.method === 'serverRequest/resolved') {
      pendingInteractions
        .get(String(params.requestId))
        ?.abort(new Error('Codex withdrew the native request'));
      return;
    }
    // Only the response to our turn/start establishes ownership. Notifications and
    // callbacks can arrive before that response, including delayed previous turns.
    if (!turnId) {
      buffered.push(message);
      return;
    }
    const nestedId = text(record(params.turn).id);
    const eventTurn = text(params.turnId) || nestedId;
    if (eventTurn !== turnId || (nestedId && nestedId !== turnId)) return;
    const method = text(message.method);
    if (method === 'turn/plan/updated')
      sink.item({
        id: 'plan',
        kind: 'plan',
        complete: true,
        text: (Array.isArray(params.plan) ? params.plan : [])
          .map((value) => {
            const step = record(value);
            return `- [${step.status === 'completed' ? 'x' : step.status === 'inProgress' || step.status === 'in_progress' ? '/' : ' '}] ${text(step.step)}`;
          })
          .join('\n'),
      });
    if (method === 'item/started' || method === 'item/completed')
      translate(record(params.item), method === 'item/completed');
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      const id = text(params.itemId);
      publish(id, {
        kind: method === 'item/agentMessage/delta' ? 'assistant' : 'reasoning',
        text: (items.get(id)?.text ?? '') + text(params.delta),
      });
    }
    if (method === 'item/commandExecution/outputDelta') {
      const id = text(params.itemId);
      const tool = items.get(id)?.tool;
      if (tool) publish(id, { tool: { ...tool, output: text(tool.output) + text(params.delta) } });
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = record(record(params.tokenUsage).total);
      if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
        cumulative = {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cachedInput: Number(usage.cachedInputTokens ?? 0),
          cacheCreated: Number(usage.cacheWriteInputTokens ?? 0),
        };
        const base = baseline;
        const difference =
          base &&
          (Object.keys(cumulative) as Array<keyof Counters>).every(
            (key) => cumulative![key] >= base[key],
          );
        sink.usage({
          ...Object.fromEntries(
            Object.entries(cumulative).map(([key, value]) => [
              key,
              difference ? value - base![key as keyof Counters] : value,
            ]),
          ),
          inputIncludesCache: true,
          scope: difference ? 'turn' : 'conversation',
        });
      }
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      finish?.({
        status:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'interrupted'
              ? 'cancelled'
              : 'failed',
        nativeId: text(turn.id),
        error: text(record(turn.error).message) || undefined,
      });
    }
  };
  peer.onMessage(receive);
  peer.onExit(markFailed);
  peer.onRequest(async (message) => {
    const params = record(message.params);
    const owner = sink;
    const controller = new AbortController();
    const signal = AbortSignal.any([interactions.signal, controller.signal]);
    if (!owner || !dispatched || settled || params.threadId !== sessionId)
      throw new Error('Codex interaction has no active conversation');
    const requestId = String(message.id);
    if (pendingInteractions.has(requestId))
      throw new Error('Codex repeated an active request identity');
    pendingInteractions.set(requestId, controller);
    try {
      const method = text(message.method);
      const nativeTurn = await identity;
      if (
        !nativeTurn ||
        params.turnId !== nativeTurn ||
        sink !== owner ||
        settled ||
        signal.aborted
      ) {
        if (method === 'mcpServer/elicitation/request')
          return { action: 'cancel', content: null, _meta: null };
        throw new Error('Codex interaction belongs to an inactive turn');
      }
      if (method === 'mcpServer/elicitation/request') {
        const form = ['form', 'openai/form', 'openaiForm'].includes(text(params.mode))
          ? formInteraction(JSON.stringify([sessionId, nativeTurn, requestId]), {
              ...params,
              mode: 'form',
            })
          : undefined;
        if (!form) return { action: 'decline', content: null, _meta: null };
        const answer = await owner
          .interaction(
            { ...form.request, title: text(params.serverName) || form.request.title },
            signal,
          )
          .catch((error) => {
            if (signal.aborted) return { cancelled: true } as ExternalInteractionResponse;
            throw error;
          });
        const response = form.reply(
          signal.aborted || sink !== owner || settled ? { cancelled: true } : answer,
        );
        return {
          ...response,
          content: 'content' in response ? response.content : null,
          _meta: null,
        };
      }
      if (method === 'item/tool/requestUserInput') {
        const questions = (Array.isArray(params.questions) ? params.questions : []).map((value) => {
          const q = record(value);
          return {
            id: text(q.id),
            question: text(q.question),
            options: (Array.isArray(q.options) ? q.options : []).map((value) => ({
              label: text(record(value).label),
              description: text(record(value).description),
            })),
          };
        });
        const answer = await owner
          .interaction(
            {
              id: JSON.stringify([sessionId, nativeTurn, String(message.id)]),
              kind: 'question',
              title: 'Codex',
              questions,
              options: [],
            },
            signal,
          )
          .catch((error) => {
            if (signal.aborted) return { cancelled: true } as ExternalInteractionResponse;
            throw error;
          });
        if (answer.cancelled || signal.aborted || sink !== owner || settled) return { answers: {} };
        return {
          answers: Object.fromEntries(
            Object.entries(answer.answers ?? {}).map(([id, answers]) => [id, { answers }]),
          ),
        };
      }
      if (method === 'item/permissions/requestApproval') {
        // Grant only the exact native overlay displayed to the user, for this
        // turn. Empty permissions is the typed denial (not a command decision).
        const requested = record(params.permissions);
        if (Object.keys(requested).some((key) => key !== 'network' && key !== 'fileSystem'))
          return { permissions: {}, scope: 'turn', strictAutoReview: true };
        const permissions: { network?: RecordValue; fileSystem?: RecordValue } = {};
        for (const key of ['network', 'fileSystem'] as const) {
          if (requested[key] == null) continue;
          const value = record(requested[key]);
          if (!Object.keys(value).length)
            return { permissions: {}, scope: 'turn', strictAutoReview: true };
          permissions[key] = value;
        }
        const answer = await owner
          .interaction(
            {
              id: JSON.stringify([sessionId, nativeTurn, requestId]),
              kind: 'permission',
              title: text(params.reason) || 'Codex requests additional permissions for this turn',
              detail: JSON.stringify({ cwd: params.cwd, permissions }, null, 2),
              options: [
                { id: 'grant', label: 'Grant the displayed permissions for this turn' },
                { id: 'deny', label: 'Deny' },
              ],
            },
            signal,
          )
          .catch((error) => {
            if (signal.aborted) return { cancelled: true } as ExternalInteractionResponse;
            throw error;
          });
        return {
          permissions:
            !answer.cancelled &&
            !signal.aborted &&
            sink === owner &&
            !settled &&
            answer.optionId === 'grant'
              ? permissions
              : {},
          scope: 'turn',
          strictAutoReview: true,
        };
      }
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
        const allowed: unknown[] = Array.isArray(params.availableDecisions)
          ? params.availableDecisions
          : ['accept', 'acceptForSession', 'decline', 'cancel'];
        const decisions = allowed.map((decision, index) => ({
          id: typeof decision === 'string' ? decision : `decision:${index}`,
          label: typeof decision === 'string' ? decision : JSON.stringify(decision),
          decision,
        }));
        if (!decisions.length) throw new Error('Codex supplied no approval decisions');
        const answer = await owner
          .interaction(
            {
              id: JSON.stringify([sessionId, nativeTurn, String(message.id)]),
              kind: 'permission',
              title: text(params.reason) || text(params.command) || 'Codex requests permission',
              detail: JSON.stringify(
                {
                  cwd: params.cwd,
                  command: params.command,
                  commandActions: params.commandActions,
                  additionalPermissions: params.additionalPermissions,
                  networkApprovalContext: params.networkApprovalContext,
                  proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
                  proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
                },
                null,
                2,
              ),
              options: decisions.map(({ id, label }) => ({ id, label })),
            },
            signal,
          )
          .catch((error) => {
            if (signal.aborted) return { cancelled: true } as ExternalInteractionResponse;
            throw error;
          });
        if (answer.cancelled || signal.aborted || sink !== owner || settled)
          return { decision: 'cancel' };
        const selected = decisions.find((value) => value.id === answer.optionId);
        if (!selected) throw new Error('Unsupported Codex approval response');
        return { decision: selected.decision };
      }
      throw new Error(`Codex callback is not supported: ${method}`);
    } finally {
      if (pendingInteractions.get(requestId) === controller) pendingInteractions.delete(requestId);
    }
  });
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
      await loadModels();
      capabilities.models = models();
      capabilities.modelsError = modelsError;
      for (const listener of changed) listener();
    },
    async prompt(input: ExternalInput, next: HarnessSink) {
      if (failure) throw failure;
      if (sink) throw new Error('Codex turn already active');
      const selected = dedicatedOptions(input, 'Codex');
      sink = next;
      items.clear();
      baseline = cumulative;
      stopRequested = false;
      dispatched = false;
      settled = false;
      buffered = [];
      interactions = new AbortController();
      identity = new Promise((resolve) => {
        identify = resolve;
      });
      try {
        const completion = new Promise<Awaited<ReturnType<HarnessConnection['prompt']>>>(
          (resolve, fail) => {
            finish = (value) => {
              settled = true;
              interactions.abort(new Error('The Codex turn settled'));
              resolve(value);
            };
            reject = fail;
          },
        );
        void completion.catch(() => {});
        await next.beforeDispatch?.();
        if (failure) throw failure;
        if (stopRequested) return { status: 'cancelled' };
        dispatched = true;
        const result = await peer.request('turn/start', {
          threadId: sessionId,
          input: [
            { type: 'text', text: input.text },
            ...(input.images ?? []).map((image) => ({
              type: 'image',
              url: `data:${image.mimeType};base64,${image.data}`,
            })),
          ],
          ...(selected.model ? { model: selected.model } : {}),
          ...(selected.thinking ? { effort: selected.thinking } : {}),
        });
        turnId = text(record(result.turn).id);
        if (!turnId) {
          const error = new Error(
            'Codex did not identify the accepted turn; review native history before retrying',
          );
          markFailed(error);
          throw error;
        }
        const current = { ...capabilities.current };
        // turn/start acceptance is not an effective-option receipt. Preserve
        // unchanged observations, but do not relabel requests/aliases as facts.
        if (selected.model && selected.model !== current.model) {
          delete current.model;
          delete current.thinking;
        }
        if (selected.thinking && selected.thinking !== current.thinking) delete current.thinking;
        if (text(result.model)) current.model = text(result.model);
        if (text(result.reasoningEffort)) current.thinking = text(result.reasoningEffort);
        capabilities.current = current;
        for (const listener of changed) listener();
        next.started?.(turnId);
        identify?.(turnId);
        for (const message of buffered) receive(message);
        buffered = [];
        if (stopRequested && turnId && !settled)
          await peer.request('turn/interrupt', { threadId: sessionId, turnId });
        return await completion;
      } finally {
        identify?.(undefined);
        identify = undefined;
        interactions.abort(new Error('The Codex turn ended'));
        buffered = [];
        dispatched = false;
        sink = undefined;
        finish = undefined;
        reject = undefined;
        turnId = undefined;
      }
    },
    async stop() {
      stopRequested = true;
      interactions.abort(new Error('The Codex interaction was cancelled'));
      if (failure) throw failure;
      if (turnId && !settled) await peer.request('turn/interrupt', { threadId: sessionId, turnId });
    },
    close: () => peer.close(),
  };
}
