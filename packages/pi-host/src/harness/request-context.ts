import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { Zone2AssembleResult, Zone2StatusResult } from "@varin/protocol";
import type { ContextRequestBoundaryOptions } from "./context-request-boundary.js";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { retainedContextState } from "./retained-context.js";

const observation = (text: string): Message => ({
  role: "user", content: [{ type: "text", text }], timestamp: Date.now(),
});

/** One request preparation: durable environment deltas, then a transient complete roster. */
export function createRequestContextInjector(bridge: HostServicesBridge): NonNullable<ContextRequestBoundaryOptions["inject"]> {
  return async (request, session) => {
    // This is a transient request fact. It is rebuilt after compaction and
    // branch navigation without changing Pi's historical system message.
    const branch = session.sessionManager.getBranch();
    const retained = retainedContextState(branch);
    const raw = buildSessionContext(branch).messages;
    let eventCursor: number | undefined;
    for (const message of raw) {
      if (message.role !== "custom" || message.customType !== "varin-context") continue;
      const details = message.details as Record<string, unknown> | undefined;
      if (typeof details?.eventCursor === "number") eventCursor = details.eventCursor;
    }
    const userMessages = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
    const latest = userMessages.at(-1);
    const userContent = latest?.type === "message" && latest.message.role === "user" ? latest.message.content : "";
    const query = typeof userContent === "string" ? userContent
      : userContent.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const signal = request.options.signal;
    const [environment, status] = await Promise.allSettled([
      bridge.request<"zone2.assemble">("zone2.assemble", {
        sinceTurn: Math.max(0, userMessages.length - 1),
        branchEntryIds: branch.map((entry) => entry.id),
        knownMaterial: retained.knownMaterial,
        retainedObservationRefs: retained.observationRefs,
        observedShellExecutions: retained.shellCompletions,
        ...(eventCursor === undefined ? {} : { afterEventId: eventCursor }),
        ...(query.trim() ? { query } : {}),
      }, signal ? { signal } : {}),
      bridge.request<"zone2.status">("zone2.status", {}, signal ? { signal } : {}),
    ]);
    signal?.throwIfAborted();
    const material: Zone2AssembleResult | undefined = environment.status === "fulfilled" ? environment.value : undefined;
    const roster: Zone2StatusResult | undefined = status.status === "fulfilled" ? status.value : undefined;
    const environmentContent = material?.content
      ? `Environment observations (retained in session history):\n${material.content}`
      : undefined;
    const additions: Message[] = [];
    if (environmentContent) additions.push(observation(environmentContent));
    else if (environment.status === "rejected") {
      additions.push(observation('<varin-context status="unavailable">Current environment observations could not be read. Previously observed facts may be stale.</varin-context>'));
    }
    additions.push(observation(roster?.content
      ? `Current teammates (request snapshot; progress excerpts):\n${roster.content}`
      : (roster?.status === "empty"
      ? '<varin-status status="empty">No teammates in the current authorized scope.</varin-status>'
      : '<varin-status status="unavailable">Current teammate status could not be read. This does not mean there are no teammates.</varin-status>')));
    return {
      request: { ...request, context: { ...request.context, messages: [...request.context.messages, ...additions] } },
      ...(material?.content && environmentContent ? {
        retained: {
          content: environmentContent,
          details: {
            deliveryId: material.deliveryId,
            eventCursor: material.eventCursor,
            observationRefs: material.observationRefs ?? [],
            shellCompletions: material.shellCompletions ?? [],
            materialRevisions: material.materialRevisions ?? {},
            gitObserved: material.content.includes("<git>"),
          },
        },
        confirm: async () => {
          if (material.deliveryId) {
            // Native history is the durable receipt if this acknowledgement is lost.
            await bridge.request<"zone2.delivered">("zone2.delivered", { deliveryId: material.deliveryId }).catch(() => undefined);
          }
        },
      } : {}),
    };
  };
}
