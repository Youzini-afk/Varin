import type { ExternalAgentCapabilities, ExternalInput, ExternalItem } from '@varin/application-client';
import type { HarnessConnection, HarnessSink } from './adapter.js';
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
  const models: RecordValue = await peer.request('model/list').catch((error) => {
    modelsError = String(error);
    return {};
  });
  const capabilities: ExternalAgentCapabilities = {
    resume: true,
    images: true,
    steering: false,
    modelsError,
    models: (Array.isArray(models.data) ? models.data : [])
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
      .filter((value) => value.id),
  };
  let sink: HarnessSink | undefined;
  let turnId: string | undefined;
  let finish: ((result: Awaited<ReturnType<HarnessConnection['prompt']>>) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const items = new Map<string, Omit<ExternalItem, 'turnId'>>();
  type Counters = { input: number; output: number; cachedInput: number; cacheCreated: number };
  let cumulative: Counters | undefined = existing
    ? undefined
    : { input: 0, output: 0, cachedInput: 0, cacheCreated: 0 };
  let baseline: Counters | undefined;
  const publish = (id: string, patch: Partial<Omit<ExternalItem, 'turnId'>>) => {
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
  peer.onMessage((message) => {
    if (!sink) return;
    const params = record(message.params);
    if (params.threadId !== sessionId) return;
    if (turnId && typeof params.turnId === 'string' && params.turnId !== turnId) return;
    const method = text(message.method);
    if (method === 'turn/started') {
      turnId = text(record(params.turn).id);
      if (turnId) sink.started?.(turnId);
    }
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
          (Object.keys(cumulative) as Array<keyof Counters>).every((key) => cumulative![key] >= base[key]);
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
          turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'cancelled' : 'failed',
        nativeId: text(turn.id),
        error: text(record(turn.error).message) || undefined,
      });
    }
  });
  peer.onExit((error) => reject?.(error));
  peer.onRequest(async (message) => {
    const params = record(message.params);
    if (!sink || params.threadId !== sessionId)
      throw new Error('Codex interaction has no active conversation');
    const method = text(message.method);
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
      const answer = await sink.interaction({
        id: String(message.id),
        kind: 'question',
        title: 'Codex',
        questions,
        options: [],
      });
      return {
        answers: Object.fromEntries(
          Object.entries(answer.answers ?? {}).map(([id, answers]) => [id, { answers }]),
        ),
      };
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const allowed = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter((v): v is string => typeof v === 'string')
        : ['accept', 'acceptForSession', 'decline', 'cancel'];
      const answer = await sink.interaction({
        id: String(message.id),
        kind: 'permission',
        title: text(params.reason) || text(params.command) || 'Codex requests permission',
        detail: text(params.cwd),
        options: allowed.map((id) => ({ id, label: id })),
      });
      if (!allowed.includes(answer.optionId ?? '')) throw new Error('Unsupported Codex approval response');
      return { decision: answer.optionId };
    }
    throw new Error(`Codex callback is not supported: ${method}`);
  });
  return {
    sessionId,
    capabilities,
    async prompt(input: ExternalInput, next: HarnessSink) {
      if (sink) throw new Error('Codex turn already active');
      sink = next;
      items.clear();
      baseline = cumulative;
      stopRequested = false;
      try {
        let settled = false;
        const completion = new Promise<Awaited<ReturnType<HarnessConnection['prompt']>>>((resolve, fail) => {
          finish = (value) => {
            settled = true;
            resolve(value);
          };
          reject = fail;
        });
        void completion.catch(() => {});
        const result = await peer.request('turn/start', {
          threadId: sessionId,
          input: [
            { type: 'text', text: input.text },
            ...(input.images ?? []).map((image) => ({
              type: 'image',
              url: `data:${image.mimeType};base64,${image.data}`,
            })),
          ],
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { effort: input.thinking } : {}),
        });
        turnId = text(record(result.turn).id) || turnId;
        if (turnId) next.started?.(turnId);
        if (stopRequested && turnId && !settled)
          await peer.request('turn/interrupt', { threadId: sessionId, turnId });
        return await completion;
      } finally {
        sink = undefined;
        finish = undefined;
        reject = undefined;
        turnId = undefined;
      }
    },
    async stop() {
      stopRequested = true;
      if (turnId) await peer.request('turn/interrupt', { threadId: sessionId, turnId });
    },
    close: () => peer.close(),
  };
}
