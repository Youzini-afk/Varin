import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { parseHarnessAgentModelSettings, type HarnessAgentModelSettings } from "@varin/protocol";

const ENTRY_TYPE = "varin.agent-model-settings";

/** Pi's branch journal retains the admitted parameters across a worker restart. */
export function resolveAgentModelSettings(manager: SessionManager, launch?: HarnessAgentModelSettings | null): HarnessAgentModelSettings {
  const prior = manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE);
  const recorded = prior?.type === "custom" ? parseHarnessAgentModelSettings(prior.data) : {};
  if (launch === undefined) return recorded;
  const next = launch === null ? {} : parseHarnessAgentModelSettings(launch);
  if (JSON.stringify(recorded) !== JSON.stringify(next)) manager.appendCustomEntry(ENTRY_TYPE, next);
  return next;
}

/** Use the native stream seam; Pi continues to own provider dispatch and its loop. */
export function attachAgentModelSettings(session: AgentSession, settings: HarnessAgentModelSettings): void {
  if (settings.thinkingLevel !== undefined) session.setThinkingLevel(settings.thinkingLevel);
  const temperature = settings.temperature;
  if (temperature === undefined) return;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => stream(model, context, {
    ...options, temperature,
  });
}
