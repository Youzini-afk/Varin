import type { PiSessionMessageEntry, PiUserMessage } from '@varin/protocol';
import type { PiRuntimeBroker, PiRuntimeBrokerEvent } from '@varin/runtime-broker';
import type { generateSmallModelText } from '../small-model/index.js';

export const SESSION_TITLE_SYSTEM_PROMPT = [
  "Generate a short, specific conversation title from the user's message.",
  "Use the user's language. Return only the title on one line.",
].join('\n');

interface TitleSession {
  workerId: string;
  named: boolean;
  attemptedUserId?: string;
  controller?: AbortController;
}

/** Naming is a Host utility request; it never enters the agent's conversation. */
export const createPiSessionTitleRuntime = ({ broker, getSmallModelService }: {
  broker: Pick<PiRuntimeBroker, 'requestForSession'>;
  getSmallModelService: () => Promise<{ generateSmallModelText: typeof generateSmallModelText }>;
}) => {
  const sessions = new Map<string, TitleSession>();
  let stopped = false;

  const generate = async (sessionId: string, state: TitleSession, signal: AbortSignal): Promise<void> => {
    const snapshot = await broker.requestForSession(sessionId, 'session.snapshot', { sessionId });
    if (signal.aborted || snapshot.name?.trim()) return;
    const { entries } = await broker.requestForSession(sessionId, 'session.entries', { scope: 'branch', sessionId });
    if (signal.aborted) return;
    const users = entries.filter((entry): entry is PiSessionMessageEntry & { message: PiUserMessage } => (
      entry.type === 'message' && entry.message.role === 'user'
    ));
    const latestUserId = users.at(-1)?.id;
    if (!latestUserId || state.attemptedUserId === latestUserId) return;
    const firstText = users.map(({ message }) => typeof message.content === 'string'
      ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
      .find(text => text.trim());
    if (!firstText) return;
    // Duplicate user/settled events must not repeat paid requests. A failed
    // attempt may be retried when another user message arrives.
    state.attemptedUserId = latestUserId;
    const service = await getSmallModelService();
    if (signal.aborted) return;
    const result = await service.generateSmallModelText({
      directory: snapshot.cwd,
      preferredModelID: snapshot.model?.id,
      preferredProviderID: snapshot.model?.provider,
      restrictToPreferredProvider: true,
      prompt: firstText,
      system: SESSION_TITLE_SYSTEM_PROMPT,
      signal,
    });
    if (signal.aborted || stopped) return;
    const name = result.text.trim().replace(/^["“](.*)["”]$/u, '$1').trim();
    if (!name || /[\r\n]/u.test(name)) throw new Error('The model did not return a single-line title');
    // The worker checks this condition at the write itself, so a manual rename
    // made while the model was responding always wins.
    await broker.requestForSession(sessionId, 'session.rename', { name, onlyIfUnnamed: true, sessionId });
  };

  const start = (sessionId: string, state: TitleSession): void => {
    if (state.named || state.controller) return;
    const controller = new AbortController();
    state.controller = controller;
    void generate(sessionId, state, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.warn('[pi-session-title] generation failed:', error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (state.controller === controller) delete state.controller;
    });
  };

  const processBrokerEvent = (event: PiRuntimeBrokerEvent): void => {
    if (stopped || event.role !== 'session' || event.kind === 'diagnostic' || !event.sessionId) return;
    const sessionId = event.sessionId;
    let state = sessions.get(sessionId);
    if (event.kind === 'worker.exit' || event.envelope.event === 'session.closed') {
      if (state?.workerId === event.workerId) {
        state.controller?.abort();
        sessions.delete(sessionId);
      }
      return;
    }
    if (!state || state.workerId !== event.workerId) {
      state?.controller?.abort();
      state = { named: false, workerId: event.workerId };
      sessions.set(sessionId, state);
    }
    const { envelope } = event;
    if (envelope.event === 'session.snapshot') {
      state.named = Boolean(envelope.data.name?.trim());
      if (state.named) state.controller?.abort();
      return;
    }
    if (envelope.event !== 'agent.event') return;
    const agentEvent = envelope.data.event;
    if (agentEvent.type === 'session_info_changed') {
      state.named = Boolean(agentEvent.name?.trim());
      state.controller?.abort();
    } else if ((agentEvent.type === 'message_end' && agentEvent.message.role === 'user')
      || (agentEvent.type === 'entry_appended' && agentEvent.entry.type === 'message' && agentEvent.entry.message.role === 'user')
      || agentEvent.type === 'agent_settled') {
      start(sessionId, state);
    }
  };

  const stop = (): void => {
    stopped = true;
    for (const state of sessions.values()) state.controller?.abort();
    sessions.clear();
  };

  return { processBrokerEvent, stop };
};
