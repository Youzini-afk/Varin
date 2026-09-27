import type { FollowUpOccurrenceDelivery, ThreadMessagePeer } from "@varin/protocol";
import { deliverAuthorizedThreadRequest, type AuthorizedThreadRequestDeps } from "./thread-services.js";

/** Follow-up adapter over the exact already-authorized thread.send request core. */
export const createFollowUpThreadSender = (deps: AuthorizedThreadRequestDeps) => async (input: {
  scopeId: string;
  threadId: string;
  text: string;
  requestId: string;
  from: ThreadMessagePeer;
}): Promise<{ delivery: FollowUpOccurrenceDelivery; runId?: string }> => {
  try {
    const result = await deliverAuthorizedThreadRequest(deps, input);
    return {
      delivery: result.delivery === "scheduled" || result.delivery === "held"
        ? "parked"
        : result.route === "continued" ? "continued" : "active-inform",
      ...(result.runId ? { runId: result.runId } : {}),
    };
  } catch (error) {
    const code = (error as { harnessCode?: string }).harnessCode;
    if (code === "not-found" || code === "unavailable") return { delivery: "dropped" };
    throw error;
  }
};
