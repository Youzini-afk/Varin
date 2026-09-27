import type { HarnessServiceHost } from "./service-host.js";
import type { HarnessThreadRoutesOptions } from "./thread-routes.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import type { ThreadSendParams } from "@varin/protocol";
import { createThreadSendService } from "./thread-services.js";
import { isSessionScopeId } from "./owner-scope.js";

/**
 * Authenticated HTTP routes call this Host adapter. Worker-supplied `from`
 * fields never establish user identity. Kept out of the application bootstrap
 * so acceptance exercises the production adapter rather than a copied fixture.
 */
export function createUserThreadSendAdapter(
  getHost: () => HarnessServiceHost,
  runtime: Pick<ThreadRuntime, "scopeForSession">,
): NonNullable<HarnessThreadRoutesOptions["sendToThread"]> {
  return async (input) => {
    const { scopeId } = await runtime.scopeForSession(input.parentSessionId);
    // Session-owned scopes are not workspace identities for the actor; the
    // actor's workspace stays null for unbound chats while routing still uses
    // the durable scope.
    const workspaceId = isSessionScopeId(scopeId) ? null : scopeId;
    // Routes are registered before service-host assembly. Resolve lazily at
    // request time, after bootstrap has established the trusted authority.
    const service = createThreadSendService(getHost());
    return service.handle({
      threadId: input.threadId,
      message: input.message,
      from: "user",
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.capability === undefined ? {} : { capability: input.capability as NonNullable<ThreadSendParams["capability"]> }),
      ...(input.resources === undefined ? {} : { resources: input.resources as NonNullable<ThreadSendParams["resources"]> }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.wait === undefined ? {} : { wait: input.wait }),
    }, {
      actor: {
        authorityInstanceId: "ui-thread-routes",
        sessionId: input.parentSessionId,
        workerId: "ui-thread-routes",
        workerGeneration: 0,
        workspaceId,
        grantedCapabilities: [],
      },
      requestSource: "user",
      authorizedPaths: [],
      sessionId: input.parentSessionId,
      workspaceId,
      signal: input.signal,
    });
  };
}
