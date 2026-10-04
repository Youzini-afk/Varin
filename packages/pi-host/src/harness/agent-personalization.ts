import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { personalizeAgentSystemPrompt, renderAgentSystemPrompt, splitAgentSystemPrompt,
  type AgentSystemPromptSnapshot, type AgentPersonalizationContext } from '@varin/protocol';
import type { HostServicesBridge } from './host-services-bridge.js';
import type { ContextModelRequest } from './context-request-boundary.js';

export function createAgentPromptRuntime(bridge: HostServicesBridge, available: () => boolean = () => true) {
  let lastRequest: AgentSystemPromptSnapshot['lastRequest'];
  let latest: AgentPersonalizationContext | undefined;
  const preferences = async (sessionId: string, signal?: AbortSignal): Promise<AgentPersonalizationContext> => {
    if (!available()) return { mode: 'agent', sessionId, profiles: [], memories: [] };
    const result = await bridge.request('session.instructions', {}, signal ? { signal } : {});
    latest = result.personalization ?? { mode: 'agent', sessionId, profiles: [], memories: [] };
    return latest;
  };
  return {
    preferences,
    async inspect(session: AgentSession): Promise<AgentSystemPromptSnapshot> {
      const personalization = latest ?? { mode: 'agent' as const, sessionId: session.sessionId, profiles: [], memories: [] };
      const original = splitAgentSystemPrompt(session.systemPrompt);
      const sections = personalizeAgentSystemPrompt(original, personalization);
      return { sessionId: session.sessionId, mode: personalization.mode, original, sections,
        content: renderAgentSystemPrompt(sections), personalization, ...(lastRequest ? { lastRequest } : {}) };
    },
    async inject(request: ContextModelRequest, session: AgentSession): Promise<ContextModelRequest> {
      if (!available()) return request;
      const personalization = await preferences(session.sessionId, request.options.signal);
      if (personalization.mode === 'bot') return request;
      const context = normalizeContext(request.context);
      const current = getCurrentSystemMessage(context.messages);
      const original = splitAgentSystemPrompt(getCurrentSystemPrompt(context.messages) || session.systemPrompt);
      const sections = personalizeAgentSystemPrompt(original, personalization);
      return { ...request, context: { ...context, messages: [{ role: 'system', content: '',
        sections: Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, renderAgentSystemPrompt({ [name]: value })])),
        toolsAdded: getCurrentTools(context.messages), timestamp: current?.timestamp ?? Date.now() },
        ...context.messages.filter(message => message.role !== 'system')] } };
    },
    sent(request: ContextModelRequest) {
      lastRequest = { content: getCurrentSystemPrompt(normalizeContext(request.context).messages), timestamp: Date.now() };
    },
  };
}
