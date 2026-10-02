import { readHistoryPage } from "@varin/protocol";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_HARNESS_SETTINGS,
  formatRetrievalEvidenceText,
  HARNESS_MAX_REQUEST_TIMEOUT_MS,
  isAttachedRootPurpose,
  mergeHarnessSettings,
  resolvePresets,
  isPresetId,
  resolveHarnessModelSlot,
  type ExecutionPreset,
  normalizeFrozenHarnessPermissions,
  sliceUtf8ByBytes,
  type RetrievalArtifactRef,
  type RetrievalEvidence,
  type Thread,
  type ThreadMessagePeer,
  type ThreadMessageRecord,
  type ThreadParent,
  type ThreadReadWhat,
  type ThreadRun,
  type ThreadViewCursor,
} from "@varin/protocol";
import { validateRetrievalEvidence } from "./retrieval-evidence.js";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { validateEnvironment } from "./environment-services.js";
import { EXECUTION_PRESETS } from "./presets.js";
import { RESEARCH_CAPABILITY_DEFINITIONS, isResearchCapability, type ResearchResourceManifest } from "@varin/protocol";
import { resolveNestedThreadScope, type ThreadControlToolName } from "./thread-nesting.js";
import { sessionScopeId } from "./owner-scope.js";
import { sameFrozenRunConfig, ThreadAdmissionError, ThreadRegistryError, type ThreadRegistry } from "./thread-registry.js";
import { DISCUSSION_TOOLS, ThreadRuntimeError } from "./thread-runtime.js";

interface ThreadSnapshot {
  thread: Thread;
  activeRun: ThreadRun | null;
}

type ExecutingThread = Thread & { execution: NonNullable<ThreadRun["frozen"]> };

const parentFor = (ctx: HarnessServiceContext): ThreadParent => ({ kind: "session", id: ctx.sessionId });

const parentEquals = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

/**
 * BC0: a replaced Bot entry session produces a fresh `bot-root` Thread in the
 * same owner scope. The new root manages the whole family's direct children —
 * threads dispatched under an earlier root stay visible and reachable instead
 * of becoming orphans the Bot can no longer read, message, or wait on.
 */
const botRootFamily = async (
  registry: NonNullable<HarnessServiceHost["threadRegistry"]>,
  scopeId: string,
): Promise<Set<string>> => {
  const snapshots = await registry.listWorkspaceThreadSnapshots(scopeId);
  return new Set(snapshots
    .filter(({ thread }) => thread.purpose === "bot-root")
    .map(({ thread }) => thread.id));
};

interface OwningContext {
  workspaceId: string;
  parent: ThreadParent;
  owner: ExecutingThread | null;
  /** Non-null only for a `bot-root` owner: ids of every bot-root in this scope. */
  family: Set<string> | null;
}

/** The parents whose direct children the caller may see and control. */
const parentVisible = (owning: OwningContext, candidate: ThreadParent): boolean => (
  owning.family
    ? (candidate.kind === "thread" && owning.family.has(candidate.id))
      || (owning.owner !== null && parentEquals(candidate, owning.owner.parent))
    : parentEquals(candidate, owning.parent)
);

const resolveOwningContext = async (
  host: HarnessServiceHost,
  ctx: HarnessServiceContext,
): Promise<OwningContext> => {
  const registry = host.threadRegistry;
  let binding = null;
  try {
    binding = registry && typeof registry.getSessionBinding === "function"
      ? await registry.getSessionBinding(ctx.sessionId)
      : null;
  } catch (error) {
    if (error instanceof ThreadRegistryError && error.code === "stale-binding") {
      throw new HarnessServiceError("denied", error.message);
    }
    throw error;
  }
  if (binding) {
    const owner = typeof registry!.getThreadById === "function"
      ? await registry!.getThreadById(binding.owningScopeId, binding.threadId)
      : null;
    if (!owner) {
      throw new HarnessServiceError("denied", "Thread session binding does not match a catalog Thread");
    }
    const run = await registry!.getActiveRun(binding.owningScopeId, binding.threadId);
    if (!run?.frozen || run.id !== binding.runId || run.sessionId !== ctx.sessionId) {
      throw new HarnessServiceError("denied", "The caller no longer owns this frozen Thread Run");
    }
    return {
      workspaceId: binding.owningScopeId,
      parent: { kind: "thread", id: binding.threadId },
      owner: { ...owner, execution: run.frozen },
      family: owner.purpose === "bot-root"
        ? await botRootFamily(registry!, binding.owningScopeId)
        : null,
    };
  }
  // HR0: an unbound chat is its own durable owner scope; Thread operations do
  // not require a directory classification.
  return { workspaceId: ctx.workspaceId ?? sessionScopeId(ctx.sessionId), parent: parentFor(ctx), owner: null, family: null };
};

const assertOwnerTool = (owner: ExecutingThread | null, tool: ThreadControlToolName): void => {
  if (!owner) return;
  if (!owner.execution.tools.includes(tool)) {
    throw new HarnessServiceError("denied", `Thread tool is not authorized: ${tool}`);
  }
};

const threadState = ({ thread, activeRun }: ThreadSnapshot): string => {
  if (thread.lifecycle === "archived") return "archived";
  if (thread.integration === "merged") return "merged";
  if (thread.integration === "conflict") return "conflict";
  if (thread.lifecycle === "queued") return "queued";
  if (thread.attention === "user" || thread.attention === "permission" || thread.attention === "thread") return "waiting-for-input";
  if (thread.attention === "stalled" || thread.attention === "looping") return thread.attention;
  if (thread.lifecycle === "settled") {
    if (thread.integration === "merge-ready" && activeRun?.outcome === "success") return "merge-ready";
    if (activeRun?.outcome === "success") return "done";
    return activeRun?.outcome ?? "settled";
  }
  if (activeRun?.workerState === "lost") return "worker-lost";
  if (activeRun?.workerState === "starting" || activeRun?.workerState === "running") return activeRun.workerState;
  return "idle";
};

const cursorChanged = ({ thread, activeRun }: ThreadSnapshot, cursor: ThreadViewCursor | null): boolean => (
  !cursor
  || cursor.eventSeq !== thread.eventSeq
  || cursor.lifecycle !== thread.lifecycle
  || cursor.attention !== thread.attention
  || cursor.integration !== thread.integration
  || cursor.activeRunId !== thread.activeRunId
  || cursor.workerState !== (activeRun?.workerState ?? null)
  || cursor.outcome !== (activeRun?.outcome ?? null)
);

const formatThreadLine = (snapshot: ThreadSnapshot, cursor: ThreadViewCursor | null, full: boolean): string => {
  const { thread, activeRun } = snapshot;
  const state = threadState(snapshot);
  const icon = state === "done" || state === "merged" ? "✔"
    : state === "failure" || state === "cancelled" || state === "lost" || state === "conflict" ? "✘"
    : state === "queued" || state === "starting" ? "⏳"
    : state === "waiting-for-input" ? "?"
    : state === "stalled" ? "!"
    : state === "looping" ? "↻"
    : "…";
  const steps = activeRun?.steps ?? 0;
  const questions = (thread.messages ?? []).filter((message) => message.direction === "out" && message.kind === "request"
    && (message.status === "delivered" || message.status === "pending")
    && message.to.kind === thread.parent.kind && message.to.id === thread.parent.id);
  const lastActivityAt = activeRun?.lastActivityAt ?? thread.updatedAt;
  let line = `${icon} ${thread.id} (${thread.preset ?? "user thread"}) ${state}`;
  if (cursor && cursorChanged(snapshot, cursor)) line += " (changed)";
  if (full || !cursor || steps > 0) line += ` · ${full || !cursor ? steps : `+${steps}`} steps`;
  line += ` · last activity ${lastActivityAt}`;
  if (thread.waitingFor) line += `\n  ? waiting for ${thread.waitingFor.kind}: ${thread.waitingFor.text}`;
  if (thread.diffStats && (full || !cursor || JSON.stringify(thread.diffStats) !== JSON.stringify(cursor.diffStats))) {
    line += `\n  Δ ${thread.diffStats.files} files (+${thread.diffStats.insertions} −${thread.diffStats.deletions})`;
  }
  if (thread.integrationBinding) {
    line += `\n  merge applicability: ${thread.integrationBinding.valid === false ? "stale" : thread.integrationBinding.mergeReady ? "ready" : "not ready"}`;
  }
  const childChecks = thread.verification?.childChecks;
  if (childChecks) {
    const exits = childChecks.commands.map((command) => command.exitCode ?? "pending").join(",");
    line += `\n  child checks r${childChecks.resultRevision}: ${childChecks.commands.length} commands exits ${exits || "none"} (${childChecks.binding})`;
  }
  const parentChecks = thread.verification?.parentChecks;
  if (parentChecks) {
    line += `\n  parent checks r${parentChecks.mergedResultRevision}: ${parentChecks.binding}`;
  }
  const review = thread.verification?.review;
  if (review && review.status !== "none") {
    line += `\n  review r${review.resultRevision}: ${review.status}${review.conclusion ? ` — ${review.conclusion}` : ""}`;
  }
  for (const message of questions) if (!cursor?.requestIds?.includes(message.id)) {
    line += `\n  request ${message.id} to parent: ${message.text}`;
  }
  return line;
};

const advanceCursor = (
  observerSessionId: string,
  snapshot: ThreadSnapshot,
  registry: NonNullable<HarnessServiceHost["threadRegistry"]>,
  expectedEpoch?: number,
  observationRef?: string,
): void => {
  const { thread, activeRun } = snapshot;
  registry.setCursor(observerSessionId, thread.id, {
    requestIds: (thread.messages ?? []).filter((message) => message.direction === "out" && message.kind === "request").map((message) => message.id),
    ...(observationRef ? { retainedBy: [...(registry.getCursor(observerSessionId, thread.id)?.retainedBy ?? []), observationRef] } : {}),
    eventSeq: thread.eventSeq,
    ...(thread.resultRevision === undefined ? {} : { resultRevision: thread.resultRevision }),
    lifecycle: thread.lifecycle,
    attention: thread.attention,
    integration: thread.integration,
    activeRunId: thread.activeRunId,
    workerState: activeRun?.workerState ?? null,
    outcome: activeRun?.outcome ?? null,
    progressVersion: 0,
    decisionsCount: 0,
    diffStats: thread.diffStats,
    viewedAt: new Date().toISOString(),
  }, expectedEpoch);
};

const deferCursorAdvancement = (
  ctx: HarnessServiceContext,
  observerSessionId: string,
  snapshots: readonly ThreadSnapshot[],
  registry: NonNullable<HarnessServiceHost["threadRegistry"]>,
): string => {
  const observationRef = randomUUID();
  const expectedEpoch = registry.getCursorEpoch(observerSessionId);
  const commit = () => {
    for (const snapshot of snapshots) advanceCursor(observerSessionId, snapshot, registry, expectedEpoch, observationRef);
  };
  if (ctx.deferResponseDelivery) ctx.deferResponseDelivery(commit, () => undefined);
  else commit();
  return observationRef;
};

const snapshotsFor = async (
  host: HarnessServiceHost,
  owning: OwningContext,
  includeHidden = false,
): Promise<ThreadSnapshot[]> => {
  const registry = host.threadRegistry!;
  if (!owning.family) {
    return registry.listThreadSnapshots(owning.workspaceId, owning.parent, includeHidden);
  }
  const all = await registry.listWorkspaceThreadSnapshots(owning.workspaceId);
  return all.filter(({ thread }) => (
    (includeHidden || !thread.hidden) && parentVisible(owning, thread.parent)
  ));
};

/** A Thread the caller may address — child of its parent, or of its bot-root family. */
const visibleThread = async (
  host: HarnessServiceHost,
  owning: OwningContext,
  threadId: string,
): Promise<Thread | null> => {
  const registry = host.threadRegistry!;
  if (!owning.family) return registry.getThread(owning.workspaceId, owning.parent, threadId);
  const thread = await registry.getThreadById(owning.workspaceId, threadId);
  return thread && parentVisible(owning, thread.parent) ? thread : null;
};

const agentSettingsFor = async (host: HarnessServiceHost, workspaceId: string) => {
  if (!host.harnessSettings) return undefined;
  const snapshot = await host.harnessSettings(workspaceId);
  if (!snapshot) throw new HarnessServiceError("unavailable", "Agent settings are unavailable");
  return mergeHarnessSettings(
    (snapshot.global?.harness ?? {}) as import("@varin/protocol").HarnessSettingsInput, {},
  );
};

export function createThreadDispatchService(host: HarnessServiceHost): HarnessService<"thread.dispatch"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadSpawnSession) {
        throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      }
      // The request already passed Host actor admission; the actor's pinned
      // authority root is the durable clone-source identity for any child.
      const initialAuthorityRoot = ctx.actor.authorityRoot ?? undefined;
      // Task-centered dispatch (D-285): `preset` is optional. Without one the
      // child runs on the caller's model and the tools the worker resolved
      // from its own active set — clamped below to the owning Thread's frozen
      // allowlist. A preset freezes its declared tools; retrieval still
      // requires its configured slot (never the main model silently).
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      const liveSettings = (params.preset !== undefined || params.research !== undefined)
        ? await agentSettingsFor(host, workspaceId) : undefined;
      if (params.preset?.startsWith("custom:") && liveSettings) {
        const key = params.preset.slice("custom:".length);
        const definition = Object.hasOwn(liveSettings.agents, key) ? liveSettings.agents[key] : undefined;
        if (definition && (!definition.enabled || (definition.workFocus.length && !definition.workFocus.includes(owner?.execution.workFocus ?? "code")))) {
          throw new HarnessServiceError("unavailable", `Agent is disabled or unavailable in this work focus: ${params.preset}`);
        }
        if (definition && !definition.model && !params.model) throw new HarnessServiceError("unavailable", `Agent requires a caller model: ${params.preset}`);
      }
      const customPreset = liveSettings ? resolvePresets(liveSettings.models, params.model ?? null,
        liveSettings.agents, owner?.execution.workFocus ?? "code").find(entry => entry.id === params.preset) : undefined;
      const preset: ExecutionPreset | null = params.preset === undefined
        ? null
        : customPreset?.definition ?? (isPresetId(params.preset) ? EXECUTION_PRESETS[params.preset] : null);
      if (preset?.slot && liveSettings?.models[preset.slot]?.enabled === false) {
        throw new HarnessServiceError("unavailable", `Agent is disabled: ${preset.id}`);
      }
      if (params.preset !== undefined && !preset) {
        throw new HarnessServiceError("invalid-params", `Unknown preset: ${params.preset}. Available presets: ${Object.keys(EXECUTION_PRESETS).join(", ")}`);
      }
      if (preset?.id === "retrieval" && !customPreset?.model && !params.model) {
        throw new HarnessServiceError("unavailable", "retrieval is not configured; models.retrievalAgent is empty");
      }
      if (params.kind !== undefined && params.kind !== "implementation" && params.kind !== "discussion") {
        throw new HarnessServiceError("invalid-params", `Unknown thread kind: ${params.kind}`);
      }
      if (params.kind === "discussion" && (params.preset !== undefined || params.research !== undefined || params.worktree !== undefined)) {
        throw new HarnessServiceError("invalid-params", "A discussion consult cannot carry a preset, research capability, or worktree");
      }
      // BC3 Bot consultation: the Thread stays under the requesting work's
      // catalog and parent, but its Run is bound to the named Bot — Bot
      // persona, Bot model default, and the Bot's memory scope. The Bot must
      // exist and be live; consulting an archived Bot is a stale reference.
      let consultBot: { id: string; model: { providerId: string; modelId: string } | null } | null = null;
      if (params.bot !== undefined) {
        if (params.kind !== "discussion") {
          throw new HarnessServiceError("invalid-params", "Bot consultation requires kind: \"discussion\"");
        }
        const found = typeof params.bot === "string" && params.bot.length > 0
          ? await host.bots?.get(params.bot).catch(() => null) ?? null
          : null;
        if (!found || found.archived) {
          throw new HarnessServiceError("unavailable", `Bot is not available for consultation: ${String(params.bot)}`);
        }
        consultBot = found;
      }
      const research = params.research;
      if (research !== undefined && (!isResearchCapability(research.capability)
        || !research.resources
        || Object.entries(research.resources).some(([key, value]) => (
          !["cpu", "gpu", "network", "longRunning"].includes(key) || typeof value !== "boolean"
        )))) {
        throw new HarnessServiceError("invalid-params", "research capability or resource manifest is malformed");
      }
      if (research !== undefined && params.preset !== undefined) {
        throw new HarnessServiceError("invalid-params", "research capability cannot be combined with a preset");
      }
      // A consult inherits the consulted Bot's model when the caller does not
      // pin one — the answer should come from the Bot's configured identity.
      const dispatchModel = consultBot?.model ?? customPreset?.model
        ?? (preset?.slot && liveSettings ? resolveHarnessModelSlot(preset.slot, liveSettings.models, params.model ?? null) : params.model)
        ?? undefined;
      if (preset && liveSettings && !dispatchModel) {
        throw new HarnessServiceError("unavailable", `Agent model is not configured: ${preset.id}`);
      }
      if (!preset && !dispatchModel) {
        throw new HarnessServiceError("invalid-params", "A preset-less dispatch must resolve the caller's current model");
      }
      const environment = params.environment === undefined ? undefined
        : await validateEnvironment(host, workspaceId, params.environment);
      assertOwnerTool(owner, "dispatch");
      if (research !== undefined && owner?.execution.workFocus !== "research") {
        throw new HarnessServiceError("denied", "Research capabilities require a research work focus");
      }
      const researchDefinition = research === undefined ? undefined : RESEARCH_CAPABILITY_DEFINITIONS[research.capability];
      if (researchDefinition && liveSettings?.models[researchDefinition.slot]?.enabled === false) {
        throw new HarnessServiceError("unavailable", `Research agent is disabled: ${research!.capability}`);
      }
      if (researchDefinition && !params.model) {
        throw new HarnessServiceError("unavailable", `Research capability ${research?.capability ?? "unknown"} has no configured model slot`);
      }
      // The execution budget is shared per root task (3.18C): a nested
      // dispatch inherits the owning Thread's frozen budget rather than
      // multiplying capacity by parent level.
      const concurrency = owner?.manifest.concurrency ?? params.concurrency ?? registry.maxConcurrency;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new HarnessServiceError("invalid-params", "Thread concurrency must be a positive integer");
      }
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      let captured: Awaited<ReturnType<NonNullable<HarnessServiceHost["threadCaptureDraftBaseline"]>>> = {
        draftBaselineId: null,
        sourceViewId: null,
        cleanup: async () => undefined,
      };
      if (inputContext.source === "surface") {
        if (!host.threadCaptureDraftBaseline) {
          throw new HarnessServiceError("unavailable", "Thread draft capture is not configured");
        } else {
          try {
            captured = await host.threadCaptureDraftBaseline(ctx.sessionId, workspaceId, inputContext);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new HarnessServiceError("unavailable", message);
          }
        }
      }
      const nestedScope = resolveNestedThreadScope(owner?.execution.scope ?? [], params.scope);
      if (!nestedScope.ok) {
        await captured.cleanup().catch(() => undefined);
        throw new HarnessServiceError(
          "denied",
          `Thread scope cannot expand the parent Run authorization: ${nestedScope.expanded.join(", ")}`,
        );
      }
      // A preset's declared tool set is its fixed contract; the Host validates
      // and freezes it wholesale (§9.2.2). A preset-less dispatch instead
      // inherits the caller's ordinary capabilities, so its claimed set must
      // stay inside the owning Run's frozen allowlist; a root session's
      // worker-resolved set is its own tools, which it already holds.
      // A `discussion` consult never receives write-capable tools: it reads
      // memory and workspace material and answers through its Run result.
      const tools = (researchDefinition?.tools ?? preset?.tools ?? params.tools ?? [])
        .filter((tool) => params.kind === "discussion" ? DISCUSSION_TOOLS.has(tool) : true);
      if (owner && !preset) {
        const denied = tools.filter((tool) => !owner.execution.tools.includes(tool));
        if (denied.length > 0) {
          await captured.cleanup().catch(() => undefined);
          throw new HarnessServiceError(
            "denied",
            `Thread tools cannot exceed the parent Run authorization: ${denied.join(", ")}`,
          );
        }
      }
      // `shared` is an explicit opt-in only; write-capable work defaults to an
      // isolated WorkingState materialized on demand (D-285).
      const worktree = researchDefinition?.worktree ?? (params.worktree === "shared"
        ? "shared" as const
        : captured.draftBaselineId || (preset?.id === "retrieval" && parent.kind === "thread")
          ? "isolated" as const
          : preset?.worktree === "none" ? "none" as const : "isolated" as const);
      // `inherit` fixes the parent's committed input at dispatch time; a queued
      // Thread never re-reads later parent state (D-285.4 / 3.18B).
      let inheritedContext: import("@varin/protocol").ThreadInheritedContext | undefined;
      if (params.input === "inherit") {
        const parentSessionId = parent.kind === "session"
          ? parent.id
          : (await registry.getActiveRun(workspaceId, parent.id))?.sessionId;
        if (!parentSessionId || !host.threadCaptureInputContext) {
          await captured.cleanup().catch(() => undefined);
          throw new HarnessServiceError("unavailable", "Parent input capture is not available for an inherit dispatch");
        }
        let material: Awaited<ReturnType<NonNullable<HarnessServiceHost["threadCaptureInputContext"]>>>;
        try {
          material = await host.threadCaptureInputContext({ sessionId: parentSessionId });
        } catch (error) {
          await captured.cleanup().catch(() => undefined);
          throw error;
        }
        if (material) {
          inheritedContext = {
            fromSessionId: parentSessionId,
            capturedAt: new Date().toISOString(),
            text: material.text,
            anchors: material.anchors,
            ...(material.images ? { images: structuredClone(material.images) } : {}),
          };
        }
      }
      const input = {
        scopeId: workspaceId,
        parent,
        brief: params.task,
        ...(preset ? { preset: preset.id } : {}),
        ...(params.input === "inherit" ? { inputOrigin: "inherit" as const } : {}),
        ...(inheritedContext ? { inheritedContext } : {}),
        ...(initialAuthorityRoot !== undefined ? { initialAuthorityRoot } : {}),
        kind: params.kind === "discussion" ? "discussion" as const : "implementation" as const,
        createdBy: "agent" as const,
        concurrency,
        autoRun: true,
        worktree: params.kind === "discussion" ? "none" as const : worktree,
        ...(captured.draftBaselineId && params.kind !== "discussion" ? { draftBaselineId: captured.draftBaselineId } : {}),
        ...(captured.sourceViewId && params.kind !== "discussion" ? { sourceViewId: captured.sourceViewId } : {}),
        tools,
        permissions: normalizeFrozenHarnessPermissions(owner?.execution.permissions),
        ...(consultBot ? { consultBotId: consultBot.id } : {}),
        ...(dispatchModel ? { model: dispatchModel } : {}),
        ...(environment ? { environment } : {}),
        ...(preset?.systemPromptFragment ? { systemPromptFragment: preset.systemPromptFragment } : {}),
        ...(researchDefinition ? {
          research: {
            capability: research!.capability,
            resources: {
              ...researchDefinition.defaultResources,
              ...(research!.resources as ResearchResourceManifest),
            },
          },
          systemPromptFragment: researchDefinition.systemPromptFragment,
        } : {}),
        // task background is explicit; inherit already contains the fixed Pi
        // input. Neither may acquire future parent blocks during dequeue.
        carryBlocks: false,
        ...(nestedScope.scope.length > 0 ? { scope: nestedScope.scope } : {}),
      };
      let thread: Thread;
      try {
        thread = await registry.createThread(input);
      } catch (error) {
        await captured.cleanup().catch(() => undefined);
        throw error;
      }
      if (input.worktree === "isolated") {
        if (!host.threadPrepareIsolatedBranch) {
          await captured.cleanup().catch(() => undefined);
          await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
          throw new HarnessServiceError("unavailable", "Isolated thread baseline capture is not configured");
        }
        try {
          await host.threadPrepareIsolatedBranch({
            scopeId: workspaceId,
            parent,
            threadId: thread.id,
            draftBaselineId: captured.draftBaselineId,
            signal: ctx.signal,
          });
        } catch (error) {
          await captured.cleanup().catch(() => undefined);
          await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
          if (error instanceof ThreadRuntimeError) {
            const code = error.code === "not-found"
              ? "not-found"
              : error.code === "invalid-request"
                ? "invalid-params"
                : "unavailable";
            throw new HarnessServiceError(code, error.message, error.retryable);
          }
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new HarnessServiceError("unavailable", error.message, true);
          }
          throw new HarnessServiceError(
            "unavailable",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        if (typeof registry.assertDispatchAllowed === "function") {
          await registry.assertDispatchAllowed(workspaceId, thread.id);
        }
      } catch (error) {
        await captured.cleanup().catch(() => undefined);
        await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
        throw error;
      }
      let run: ThreadRun;
      try {
        run = await registry.startRun(workspaceId, thread.id);
      } catch (error) {
        if (error instanceof ThreadAdmissionError) {
          // The immutable baseline is already captured. Keep this queued
          // task, rather than deleting it or using a stale pre-capture count.
          return {
            text: `queued as ${thread.id}${preset ? ` (${preset.id})` : ""} — concurrency is full`,
            threadId: thread.id,
            queued: true,
          };
        }
        await captured.cleanup().catch(() => undefined);
        await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
        throw error;
      }
      void host.threadSpawnSession({ ...input, threadId: thread.id, runId: run.id }).catch(async (error) => {
        await registry.endRun(
          workspaceId,
          thread.id,
          run.id,
          "failure",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      });
      return { text: `dispatched ${thread.id}${preset ? ` (${preset.id})` : ""}`, threadId: thread.id, queued: false };
    },
  };
}

export function createThreadFactsSetService(host: HarnessServiceHost): HarnessService<"thread.facts.set"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || typeof registry.setPendingEvidence !== "function") {
        throw new HarnessServiceError("unavailable", "Thread registry is not configured");
      }
      const binding = await registry.getSessionBinding(ctx.sessionId).catch((error: unknown) => {
        if (error instanceof ThreadRegistryError && error.code === "stale-binding") {
          throw new HarnessServiceError("denied", error.message);
        }
        throw error;
      });
      if (!binding) {
        throw new HarnessServiceError("denied", "submit_facts is only available on a retrieval thread session");
      }
      const thread = typeof registry.getThreadById === "function"
        ? await registry.getThreadById(binding.owningScopeId, binding.threadId)
        : null;
      if (!thread) {
        throw new HarnessServiceError("denied", "Thread session binding does not match a catalog Thread");
      }
      if (thread.preset !== "retrieval") {
        throw new HarnessServiceError("denied", "submit_facts is only available on a retrieval thread");
      }
      if (!thread.manifest.tools.includes("submit_facts")) {
        throw new HarnessServiceError("denied", "Thread tool is not authorized: submit_facts");
      }
      if (typeof params.question !== "string" || !params.question.trim()) {
        throw new HarnessServiceError("invalid-params", "submit_facts requires a question");
      }
      if (!Array.isArray(params.facts)) {
        throw new HarnessServiceError("invalid-params", "submit_facts requires a facts array");
      }
      const runId = binding.runId;
      const receiptAuthority = {
        owningWorkspaceId: binding.owningScopeId,
        sessionId: ctx.sessionId,
        threadId: thread.id,
        runId,
      };
      let catalogCommitted = false;
      try {
        const evidence = await validateRetrievalEvidence({
          question: params.question,
          facts: params.facts,
          ...(params.unknowns ? { unknowns: params.unknowns } : {}),
          ...(params.attempted ? { attempted: params.attempted } : {}),
          frozenScope: thread.manifest.scope,
          ...(ctx.actor.workspaceScope ? { actorScope: ctx.actor.workspaceScope } : {}),
          brief: thread.brief,
          ...(host.readExploreFile ? { readFile: host.readExploreFile } : {}),
          actor: ctx.actor,
          signal: ctx.signal,
          ...(ctx.inputContext ? { inputContext: ctx.inputContext } : {}),
          outputStore: host.outputStore,
          sessionId: ctx.sessionId,
          receiptAuthority,
          ...(host.storeRetrievalArtifact
            ? { storeArtifact: (bytes) => host.storeRetrievalArtifact!(binding.owningScopeId, bytes, receiptAuthority) }
            : {}),
          ...(host.lookupWebFetchReceipt
            ? { lookupReceipt: (receiptId, authority) => host.lookupWebFetchReceipt!(binding.owningScopeId, authority, receiptId) }
            : {}),
        });
        try {
          await registry.setPendingEvidence(binding.owningScopeId, thread.id, runId, evidence);
          catalogCommitted = true;
        } catch (error) {
          throw new HarnessServiceError(
            "denied",
            error instanceof Error ? error.message : String(error),
          );
        }
        await host.protectRetrievalEvidence?.({
          workspaceId: binding.owningScopeId,
          threadId: thread.id,
          runId,
          evidence,
          receiptAuthority,
        });
        return { text: formatRetrievalEvidenceText(evidence), evidence };
      } finally {
        if (!catalogCommitted) {
          await host.releaseRetrievalTemporaryArtifacts?.(
            binding.owningScopeId,
            receiptAuthority,
          ).catch(() => undefined);
        }
      }
    },
  };
}

export function createThreadListService(host: HarnessServiceHost): HarnessService<"thread.list"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { owner } = owning;
      assertOwnerTool(owner, "threads");
      const observer = ctx.sessionId;
      let snapshots = await snapshotsFor(host, owning);
      if (params.ids) snapshots = snapshots.filter(({ thread }) => params.ids!.includes(thread.id));
      const full = params.full ?? false;
      let changed = 0;
      const cursorUpdates: ThreadSnapshot[] = [];
      const lines = snapshots.map((snapshot) => {
        const cursor = registry.getCursor(observer, snapshot.thread.id);
        if (full || cursorChanged(snapshot, cursor)) {
          changed += 1;
          const line = formatThreadLine(snapshot, cursor, full);
          if (!full) cursorUpdates.push(snapshot);
          return line;
        }
        return `${snapshot.thread.id} — no change since last view; still ${threadState(snapshot)}, last activity ${snapshot.activeRun?.lastActivityAt ?? snapshot.thread.updatedAt}`;
      });
      const header = changed === 0 && snapshots.length > 0
        ? "no changes since last view; use wait to block instead of polling"
        : `${snapshots.length} threads · ${changed} changed since last view`;
      const observationRef = deferCursorAdvancement(ctx, observer, cursorUpdates, registry);
      return {
        observationRef,
        text: snapshots.length === 0 ? "no threads" : `${header}\n${lines.join("\n")}`,
        threads: snapshots.map(({ thread, activeRun }) => ({
          id: thread.id,
          lifecycle: thread.lifecycle,
          attention: thread.attention,
          integration: thread.integration,
          brief: thread.brief,
          createdAt: thread.createdAt,
          preset: thread.preset,
          updatedAt: thread.updatedAt,
          activeRun,
          waitingFor: thread.waitingFor,
          diffStats: thread.diffStats,
        })),
      };
    },
  };
}

export function createThreadWaitService(host: HarnessServiceHost): HarnessService<"thread.wait"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { workspaceId, parent, owner } = owning;
      assertOwnerTool(owner, "wait");
      const observer = ctx.sessionId;
      const timeoutMs = Math.min(
        params.timeoutMs ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000),
        HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000,
      );
      // A Thread caller also watches its own record: inbound replies and
      // messages land on it and complete dependency waits (3.18C).
      const selfSnapshot = async (): Promise<ThreadSnapshot | null> => {
        if (!owner) return null;
        const self = await registry.getThreadById(workspaceId, owner.id);
        if (!self) return null;
        return { thread: self, activeRun: await registry.getActiveRun(workspaceId, self.id) };
      };
      const selfBaseline = await selfSnapshot();
      const initialRequests = new Set((selfBaseline?.thread.messages ?? [])
        .filter((message) => message.direction === "in" && (message.status === "delivered" || message.status === "resolved")
          && (message.kind === "request" || message.replyTo !== undefined))
        .map((message) => message.id));
      const actionable = new Set(["user", "permission", "stalled", "looping"]);
      // Progress counters/eventSeq are display cursors, not model wakeups.
      // A dependency wakes on a result, failure/loss, or actionable attention.
      const addressedToCaller = (peer: ThreadMessagePeer): boolean => owning.family
        ? (peer.kind === "thread" && owning.family.has(peer.id))
          || (owner !== null && peerEquals(peer, owner.parent))
        : peerEquals(peer, parent);
      const relevantChildChange = ({ thread, activeRun }: ThreadSnapshot): boolean => {
        const cursor = registry.getCursor(observer, thread.id);
        if (thread.messages?.some((message) => message.direction === "out" && message.kind === "request"
          && message.status === "delivered" && addressedToCaller(message.to)
          && !cursor?.requestIds?.includes(message.id))) return true;
        if (thread.resultRevision !== undefined && thread.resultRevision !== cursor?.resultRevision) return true;
        if (actionable.has(thread.attention) && thread.attention !== cursor?.attention) return true;
        if (thread.integration === "conflict" && cursor?.integration !== "conflict") return true;
        if (activeRun?.workerState === "lost" && cursor?.workerState !== "lost") return true;
        return (thread.lifecycle === "settled" || thread.lifecycle === "archived")
          && (!cursor || cursor.lifecycle !== thread.lifecycle || cursor.activeRunId !== thread.activeRunId
            || cursor.outcome !== (activeRun?.outcome ?? null));
      };
      const hasChanges = async (): Promise<boolean> => {
        ctx.signal.throwIfAborted();
        const snapshots = await snapshotsFor(host, owning, true);
        if (snapshots.some((snapshot) => (!params.ids || params.ids.includes(snapshot.thread.id))
          && relevantChildChange(snapshot))) return true;
        const self = await selfSnapshot();
        if (!owner || !selfBaseline) return false;
        if (!self || self.thread.activeRunId !== owner.activeRunId || self.thread.lifecycle !== "active") {
          throw new HarnessServiceError("unavailable", "The waiting Run is no longer active");
        }
        if (self.thread.messages?.some((message) => message.direction === "in"
          && (message.status === "delivered" || message.status === "resolved")
          && (message.kind === "request" || message.replyTo !== undefined) && !initialRequests.has(message.id))) return true;
        if (selfBaseline.thread.waitingFor?.review !== undefined && self.thread.waitingFor?.review === undefined) return true;
        return actionable.has(self.thread.attention) && self.thread.attention !== selfBaseline.thread.attention;
      };
      let timedOut = false;
      if (!await hasChanges()) {
        if (owner?.activeRunId) {
          // Yield only because this tool is actually blocking. Failure to
          // establish that durable fact is not a successful empty wait.
          const marked = await registry.yieldExecutionSlot(workspaceId, owner.id, owner.activeRunId, {
            kind: "thread",
            text: params.ids?.length ? `Waiting on ${params.ids.join(", ")}` : "Waiting for thread results or addressed requests",
          });
          if (!marked) throw new HarnessServiceError("unavailable", "The waiting Run could not yield its execution slot");
        }
        const deadline = Date.now() + timeoutMs;
        while (true) {
          ctx.signal.throwIfAborted();
          let wake!: (reason: "change" | "timeout" | "abort") => void;
          const notification = new Promise<"change" | "timeout" | "abort">((resolve) => { wake = resolve; });
          // Registry listeners are one-shot. Resubscribe before rechecking,
          // keeping the original deadline even when routine activity arrives.
          const watchedParents: ThreadParent[] = owning.family
            ? [...owning.family].map((id) => ({ kind: "thread" as const, id }))
            : [parent];
          const unsubscribe = watchedParents.map((watched) => registry.subscribeToChanges(workspaceId, watched, () => wake("change")));
          if (owner) unsubscribe.push(registry.subscribeToChanges(workspaceId, owner.parent, () => wake("change")));
          const abort = () => wake("abort");
          ctx.signal.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(() => wake("timeout"), Math.max(0, deadline - Date.now()));
          try {
            if (await hasChanges()) break;
            if (Date.now() >= deadline) { timedOut = true; break; }
            const reason = await notification;
            if (reason === "abort") ctx.signal.throwIfAborted();
            if (reason === "timeout") { timedOut = !await hasChanges(); break; }
          } finally {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", abort);
            for (const stop of unsubscribe) stop();
          }
        }
      }
      // Returning a tool result permits the next model request. A reply or
      // timeout may finish dependency watching, but cannot bypass root admission.
      if (owner?.activeRunId) {
        await registry.awaitExecutionSlot(workspaceId, owner.id, owner.activeRunId, ctx.signal);
      }
      // Messages held while the caller waited flush at this normal boundary.
      if (owner && host.threadSendToSession) {
        const held = await registry.listPendingThreadMessages(workspaceId, owner.id);
        for (const heldMessage of held) {
          await host.threadSendToSession(ctx.sessionId, heldMessage.text, {
            from: messagePeerLabel(heldMessage.from),
            messageId: heldMessage.id,
            ...(heldMessage.kind === "request" ? { requestId: heldMessage.id } : {}),
          });
          await registry.acknowledgeThreadMessages(workspaceId, owner.id, [heldMessage.id], owner.activeRunId ?? undefined);
        }
      }
      const all = await snapshotsFor(host, owning, true);
      const ids = params.ids ?? all.map(({ thread }) => thread.id);
      const targets = all.filter(({ thread }) => ids.includes(thread.id));
      const self = await selfSnapshot();
      if (self && cursorChanged(self, registry.getCursor(observer, self.thread.id))) targets.push(self);
      const done = targets.filter(({ thread }) => thread.lifecycle === "settled" || thread.lifecycle === "archived");
      const queued = targets.filter(({ thread }) => thread.lifecycle === "queued");
      const running = targets.filter(({ thread, activeRun }) => (
        thread.lifecycle === "active"
        && thread.attention !== "user"
        && thread.attention !== "permission"
        && (activeRun?.workerState === "starting" || activeRun?.workerState === "running")
      ));
      const occupied = new Set([...done, ...queued, ...running].map(({ thread }) => thread.id));
      const waiting = targets.filter(({ thread }) => !occupied.has(thread.id));
      const counts = `${done.length} done · ${running.length} running · ${waiting.length} waiting · ${queued.length} queued`;
      const lines = [timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s — ${counts}` : counts];
      for (const snapshot of done) {
        const { thread } = snapshot;
        if (thread.report) {
          lines.push(`✔ ${thread.id} (${thread.preset ?? "unknown"}) — ${thread.report.conclusion.split("\n")[0] ?? "completed"}`);
          lines.push(`  files: ${thread.report.changedFiles.join(", ") || "(none)"} · confidence ${thread.report.confidence}`);
          lines.push(`  deviations from brief: ${thread.report.deviations.join("; ") || "none"}`);
          lines.push(`  unresolved: ${thread.report.unresolved.join("; ") || "none"} · notes: read_thread("${thread.id}") · trace: read_thread("${thread.id}", "steps")`);
        } else {
          lines.push(`✔ ${thread.id} (${thread.preset ?? "unknown"}) — ${threadState(snapshot)}`);
        }
      }
      for (const snapshot of [...running, ...waiting]) {
        lines.push(formatThreadLine(snapshot, registry.getCursor(observer, snapshot.thread.id), false));
      }
      for (const snapshot of queued) {
        lines.push(`⏳ ${snapshot.thread.id} (${snapshot.thread.preset ?? "unknown"}) · queued`);
      }
      const observationRef = deferCursorAdvancement(ctx, observer, targets, registry);
      return {
        observationRef,
        text: lines.join("\n"),
        done: done.length,
        running: running.length,
        waiting: waiting.length,
        queued: queued.length,
        timedOut,
      };
    },
  };
}

const messagePeerLabel = (peer: ThreadMessagePeer): string => (
  peer.kind === "thread" ? `thread ${peer.id}`
    : peer.kind === "user" ? "the user"
      : "the parent agent"
);

const peerEquals = (left: ThreadMessagePeer, right: ThreadMessagePeer): boolean => (
  left.kind === right.kind && left.id === right.id
);

/**
 * Restrict a branch transcript to the selected Run's durable bounds. A
 * continuation may reuse one Pi session, so reading the whole branch would
 * silently attach later Run output to an earlier Run.
 */
const entriesForRun = <T extends { id: string }>(
  entries: readonly T[],
  run: ThreadRun,
  runs: readonly ThreadRun[],
): T[] | null => {
  const ref = run.report?.transcriptRef;
  let fromId: string | null = null;
  let toId: string | null = null;
  if (ref) {
    if (ref.fromEntryId === null && ref.toEntryId === null) return [];
    fromId = ref.fromEntryId;
    toId = ref.toEntryId;
  } else {
    const previous = runs
      .filter((candidate) => candidate.id !== run.id && candidate.attempt < run.attempt && candidate.sessionId === run.sessionId)
      .toSorted((left, right) => left.attempt - right.attempt)
      .at(-1);
    if (previous) {
      const previousTo = previous.report?.transcriptRef.toEntryId;
      if (!previousTo) return null;
      fromId = previousTo;
    }
  }
  const fromIndex = fromId === null ? 0 : entries.findIndex((entry) => entry.id === fromId) + (ref ? 0 : 1);
  const toIndex = toId === null ? entries.length - 1 : entries.findIndex((entry) => entry.id === toId);
  if ((fromId !== null && (fromIndex < 0 || (!ref && entries.findIndex((entry) => entry.id === fromId) < 0)))
    || (toId !== null && toIndex < 0)) return null;
  return entries.slice(Math.max(0, fromIndex), toIndex < 0 ? entries.length : toIndex + 1);
};

const continueError = (error: unknown): never => {
  if (error instanceof ThreadRuntimeError) {
    const code = error.code === "not-found"
      ? "not-found"
      : error.code === "conflict" || error.code === "invalid-request"
        ? "invalid-params"
        : "unavailable";
    throw new HarnessServiceError(code, error.message, error.retryable);
  }
  throw error;
};

export interface AuthorizedThreadRequestInput {
  scopeId: string;
  threadId: string;
  text: string;
  requestId: string;
  from: ThreadMessagePeer;
}

export interface AuthorizedThreadRequestDeps {
  registry: ThreadRegistry;
  continueRun?(input: {
    scopeId: string;
    parent: ThreadParent;
    threadId: string;
    mode: "continue";
    task: string;
    requestId: string;
    from: ThreadMessagePeer;
  }): Promise<{ runId?: string }>;
  sendToSession?(sessionId: string, message: string, meta: { from: string; requestId?: string; messageId: string }): Promise<void>;
}

/**
 * The already-authorized `thread.send(kind=request, context=continue)` core.
 * Both the public service and Host-owned follow-ups use this exact ledger,
 * target lock, held-message flush, and continuation admission path.
 */
export const deliverAuthorizedThreadRequest = async (
  deps: AuthorizedThreadRequestDeps,
  input: AuthorizedThreadRequestInput,
): Promise<{ accepted: true; lifecycle: Thread["lifecycle"]; attention: Thread["attention"]; messageId: string; delivery: "delivered" | "held" | "scheduled"; runId?: string; route?: "active" | "continued" }> => deps.registry.withMessageDelivery(
  input.scopeId,
  `thread:${input.threadId}`,
  async () => {
    const thread = await deps.registry.getThreadById(input.scopeId, input.threadId);
    if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${input.threadId}`);
    if (thread.lifecycle === "archived" || thread.deletion) {
      throw new HarnessServiceError("unavailable", `Thread is unavailable: ${thread.id}`);
    }
    const to = { kind: "thread" as const, id: thread.id };
    const previous = thread.messages?.find((message) => message.direction === "in" && message.id === input.requestId);
    if (previous) {
      if (previous.kind !== "request" || (previous.context ?? "continue") !== "continue"
        || previous.text !== input.text || previous.from.kind !== input.from.kind || previous.from.id !== input.from.id) {
        throw new HarnessServiceError("invalid-params", "requestId is already bound to a different message or sender");
      }
      const continuation = thread.pendingContinuations?.find((candidate) => candidate.requestId === input.requestId);
      const priorRun = (await deps.registry.listRuns(input.scopeId, thread.id))
        .find((candidate) => candidate.request?.requestId === input.requestId);
      if (continuation) return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention,
        messageId: input.requestId, delivery: "scheduled" };
      if (previous.status === "failed") throw new HarnessServiceError("unavailable", previous.failure ?? "The request previously failed");
      if (previous.status === "delivered" || previous.status === "resolved" || priorRun) {
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention,
          messageId: input.requestId, delivery: "delivered",
          route: priorRun ? "continued" : "active",
          ...(previous.runId ?? priorRun?.id ? { runId: previous.runId ?? priorRun!.id } : {}) };
      }
    }
    const at = previous?.at ?? new Date().toISOString();
    if (!previous) {
      await deps.registry.recordDirectedMessage(input.scopeId, {
        id: input.requestId,
        from: input.from,
        to,
        kind: "request",
        context: "continue",
        text: input.text,
        status: "pending",
        at,
      });
    }
    const patch = (status: ThreadMessageRecord["status"], runId?: string) => (
      deps.registry.patchDirectedMessage(input.scopeId, thread.id, input.requestId, {
        status,
        ...(runId ? { runId } : {}),
      })
    );
    if (thread.lifecycle === "queued") {
      return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention,
        messageId: input.requestId, delivery: "scheduled" };
    }
    const run = await deps.registry.getActiveRun(input.scopeId, thread.id);
    const lostWorker = thread.lifecycle === "active" && (run?.outcome === "lost" || run?.workerState === "lost");
    if (thread.lifecycle === "settled" || lostWorker) {
      if (!deps.continueRun) throw new HarnessServiceError("unavailable", "Thread runtime is not configured for continuation");
      let continued: { runId?: string };
      try {
        continued = await deps.continueRun({
          scopeId: input.scopeId,
          parent: thread.parent,
          threadId: thread.id,
          mode: "continue",
          task: input.text,
          requestId: input.requestId,
          from: input.from,
        });
      } catch (error) {
        return continueError(error);
      }
      if (!continued.runId) {
        await deps.registry.enqueueContinuation(input.scopeId, thread.id, {
          requestId: input.requestId,
          mode: "continue",
          task: input.text,
          from: input.from,
          at,
        });
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention,
          messageId: input.requestId, delivery: "scheduled" };
      }
      await patch("delivered", continued.runId);
      return { accepted: true, lifecycle: "active", attention: "none",
        runId: continued.runId, messageId: input.requestId, delivery: "delivered", route: "continued" };
    }
    if (!run || run.workerState === "exited" || (run.workerState === "running" && !run.sessionId)) {
      await patch("held", run?.id);
      return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention,
        messageId: input.requestId, delivery: "held", ...(run?.id ? { runId: run.id } : {}) };
    }
    if (run.workerState === "starting" && !run.sessionId) {
      return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention,
        messageId: input.requestId, delivery: "scheduled" };
    }
    const held = await deps.registry.listPendingThreadMessages(input.scopeId, thread.id, input.requestId);
    if (!deps.sendToSession) throw new HarnessServiceError("unavailable", "Thread session delivery is not configured");
    for (const heldMessage of held) {
      await deps.sendToSession(run.sessionId!, heldMessage.text, {
        from: messagePeerLabel(heldMessage.from),
        messageId: heldMessage.id,
        ...(heldMessage.kind === "request" ? { requestId: heldMessage.id } : {}),
      });
      await deps.registry.acknowledgeThreadMessages(input.scopeId, thread.id, [heldMessage.id], run.id);
    }
    await patch("pending", run.id);
    await deps.sendToSession(run.sessionId!, input.text, {
      from: messagePeerLabel(input.from),
      requestId: input.requestId,
      messageId: input.requestId,
    });
    await patch("delivered", run.id);
    let attention = thread.attention;
    if (thread.waitingFor?.kind === "thread") {
      attention = (await deps.registry.setAttention(input.scopeId, thread.id, "none"))?.attention ?? "none";
    }
    return { accepted: true, lifecycle: "active", attention, runId: run.id,
      messageId: input.requestId, delivery: "delivered", route: "active" };
  },
);

export function createThreadSendService(host: HarnessServiceHost): HarnessService<"thread.send"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadSendToSession) throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { workspaceId, family } = owning;
      const initialOwner = owning.owner;
      // Authenticated UI calls stay user-originated while the same Pi session
      // is temporarily attached to its principal root (research or Bot entry).
      // Worker calls still act with the root Thread's frozen authority.
      let owner = ctx.requestSource === "user" && isAttachedRootPurpose(initialOwner?.purpose)
        ? null
        : initialOwner;
      assertOwnerTool(owner, "send");
      const kind = params.kind ?? "inform";
      if (params.context !== undefined && kind !== "request") {
        throw new HarnessServiceError(
          "invalid-params",
          "context only applies to an execution request (kind: \"request\")",
        );
      }
      // Capability/model re-routing (7B/D-300) re-freezes the target's next
      // Run; it is meaningless on a notification or a session target.
      const upgradeRequested = params.capability !== undefined
        || (params.model !== undefined && params.model !== "inherit");
      if (params.capability !== undefined && !isResearchCapability(params.capability)) {
        throw new HarnessServiceError("invalid-params", `Unknown research capability: ${params.capability}`);
      }
      if (params.resources !== undefined && (params.capability === undefined
        || typeof params.resources !== "object" || params.resources === null
        || Object.entries(params.resources).some(([key, value]) => (
          !["cpu", "gpu", "network", "longRunning"].includes(key) || typeof value !== "boolean"
        )))) {
        throw new HarnessServiceError("invalid-params", "resources must be a valid manifest and require a capability");
      }
      if (params.model !== undefined && params.model !== "inherit") {
        const selected = params.model as { providerId?: unknown; modelId?: unknown };
        if (typeof selected.providerId !== "string" || !selected.providerId
          || typeof selected.modelId !== "string" || !selected.modelId) {
          throw new HarnessServiceError("invalid-params", "model must be a resolved selection or \"inherit\"");
        }
      }
      if (upgradeRequested && kind !== "request") {
        throw new HarnessServiceError("invalid-params", "capability/model re-routing only applies to an execution request");
      }
      if (upgradeRequested && params.to === "parent") {
        throw new HarnessServiceError("invalid-params", "capability/model re-routing applies to a Thread target, not a session");
      }
      if (params.capability !== undefined && ctx.requestSource !== "user"
        && owner?.execution.workFocus !== "research") {
        throw new HarnessServiceError("denied", "Capability re-routing requires a research work focus");
      }
      if (params.to === "parent" && params.threadId !== undefined) {
        throw new HarnessServiceError("invalid-params", "to: \"parent\" and threadId are mutually exclusive");
      }
      if (params.to !== "parent" && params.threadId === undefined) {
        throw new HarnessServiceError("invalid-params", "send requires a threadId or to: \"parent\"");
      }
      const waitSeconds = params.wait ?? 0;
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
        throw new HarnessServiceError("invalid-params", "wait must be a non-negative number of seconds");
      }
      if (waitSeconds > 0 && kind !== "request") {
        throw new HarnessServiceError("invalid-params", "wait applies to an execution request (kind: \"request\")");
      }
      // Sender identity is Host-derived from the session binding — a caller
      // can never claim to be the user or another Thread (3.18C).
      const fromPeer: ThreadMessagePeer = owner
        ? { kind: "thread", id: owner.id }
        : ctx.requestSource === "user"
          ? { kind: "user", id: ctx.sessionId }
          : { kind: "session", id: ctx.sessionId };
      const fromLabel = messagePeerLabel(fromPeer);

      const isUserResearchBranch = async (candidate: Thread): Promise<boolean> => {
        if (ctx.requestSource !== "user") return false;
        let parent = candidate.parent;
        while (parent.kind === "thread") {
          const ancestor = await registry.getThreadById(workspaceId, parent.id);
          if (!ancestor) return false;
          if (isAttachedRootPurpose(ancestor.purpose)) {
            return ancestor.parent.kind === "session" && ancestor.parent.id === ctx.sessionId;
          }
          parent = ancestor.parent;
        }
        return false;
      };

      // Resolve the target: own parent, or a relationship-bound Thread.
      let targetSessionId: string | null = null;
      let target: Thread | null = null;
      if (params.to === "parent") {
        if (!owner) throw new HarnessServiceError("invalid-params", "A root session has no parent to send to");
        if (owner.parent.kind === "session") targetSessionId = owner.parent.id;
        else {
          target = await registry.getThreadById(workspaceId, owner.parent.id);
          if (!target) throw new HarnessServiceError("not-found", `Thread not found: ${owner.parent.id}`);
        }
      } else {
        const candidate = await registry.getThreadById(workspaceId, params.threadId!);
        if (!candidate) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
        // Reachability follows actual root-task relationships, not shared
        // workspace membership: children, the parent, and same-parent
        // siblings for a Thread caller; direct children for a session.
        const related = owner
          ? (candidate.parent.kind === "thread" && candidate.parent.id === owner.id)
            || (owner.parent.kind === "thread" && owner.parent.id === candidate.id)
            || peerEquals(candidate.parent, owner.parent)
            || (family !== null && candidate.parent.kind === "thread" && family.has(candidate.parent.id))
          : (candidate.parent.kind === "session" && candidate.parent.id === ctx.sessionId)
            || await isUserResearchBranch(candidate);
        if (!related) {
          throw new HarnessServiceError("denied", `Thread is outside the caller's root-task relationships: ${candidate.id}`);
        }
        target = candidate;
      }

      if (target && kind === "request" && !upgradeRequested && params.replyTo === undefined
        && waitSeconds === 0 && (params.context ?? "continue") === "continue") {
        return deliverAuthorizedThreadRequest({
          registry,
          ...(host.threadContinueRun ? { continueRun: host.threadContinueRun } : {}),
          ...(host.threadSendToSession ? { sendToSession: (sessionId, message, meta) => host.threadSendToSession!(sessionId, message, meta) } : {}),
        }, {
          scopeId: workspaceId,
          threadId: target.id,
          text: params.message,
          requestId: params.requestId ?? `msg-${randomUUID()}`,
          from: fromPeer,
        });
      }

      const sent = await registry.withMessageDelivery(workspaceId, target ? "thread:" + target.id : "session:" + targetSessionId,
        async (): Promise<Awaited<ReturnType<HarnessService<"thread.send">["handle"]>>> => {
      ctx.signal.throwIfAborted();
      // Refresh after waiting for another input operation; its Run and ledger
      // may have changed. The owning actor is rechecked, not accepted from a stale snapshot.
      const currentOwner = await resolveOwningContext(host, ctx);
      owner = ctx.requestSource === "user" && isAttachedRootPurpose(currentOwner.owner?.purpose)
        ? null
        : currentOwner.owner;
      assertOwnerTool(owner, "send");
      if (target) {
        target = await registry.getThreadById(workspaceId, target.id);
        if (!target) throw new HarnessServiceError("not-found", "Message target was removed");
      }
      const requestId = params.requestId ?? `msg-${randomUUID()}`;
      const toPeer: ThreadMessagePeer = target
        ? { kind: "thread", id: target.id }
        : { kind: "session", id: targetSessionId! };
      const recordedAt = new Date().toISOString();
      const deliveryOf = (status: ThreadMessageRecord["status"]): "delivered" | "held" | "scheduled" => (
        status === "pending" ? "scheduled" : status === "held" ? "held" : "delivered"
      );
      const priorMessage = params.requestId === undefined ? undefined
        : target?.messages?.find((message) => message.direction === "in" && message.id === params.requestId)
          ?? owner?.messages?.find((message) => message.direction === "out" && message.id === params.requestId);
      const priorContinuation = target && params.requestId !== undefined
        ? target.pendingContinuations?.find((request) => request.requestId === params.requestId)
        : undefined;
      const priorRun = target && params.requestId !== undefined
        ? (await registry.listRuns(workspaceId, target.id)).find((candidate) => candidate.request?.requestId === params.requestId)
        : undefined;
      const priorIntent = priorContinuation ?? priorRun?.request;

      // Resolve the next Run's complete identity before checking a retry. A
      // capability can change the required worktree, in which case the
      // retained session cannot honestly be continued: the request is
      // promoted as a fresh Run so normal spawn/fresh preparation creates the
      // real frozen execution directory and carries the retained context.
      const requestedMode = params.context ?? "continue";
      let executionMode = requestedMode;
      let rerouteFrozen: ThreadRun["frozen"] | undefined;
      if (priorIntent) executionMode = priorIntent.mode;
      if (upgradeRequested && target) {
        const definition = params.capability === undefined
          ? undefined
          : RESEARCH_CAPABILITY_DEFINITIONS[params.capability];
        // A retry observes its already accepted request. A new capability
        // assignment must respect the current switch, including explicit inherit.
        if (definition && !priorIntent) {
          const settings = await agentSettingsFor(host, workspaceId);
          if (settings?.models[definition.slot]?.enabled === false) {
            throw new HarnessServiceError("unavailable", `Research agent is disabled: ${definition.capability}`);
          }
        }
        const model = params.model === "inherit" ? target.model : params.model ?? null;
        if (params.model === "inherit" && !target.model) {
          throw new HarnessServiceError("unavailable", "The target Thread has no recorded model to inherit");
        }
        if (definition && !model) {
          throw new HarnessServiceError("unavailable", `Research capability ${definition.capability} has no configured model slot; pass model "inherit" to keep the Thread's model`);
        }
        executionMode = definition?.worktree !== undefined && definition.worktree !== target.manifest.worktree
          ? "fresh"
          : executionMode;
        rerouteFrozen = {
          model: model ?? target.model,
          tools: definition ? [...definition.tools] : [...target.manifest.tools],
          ...(target.manifest.permissions ? { permissions: structuredClone(target.manifest.permissions) } : {}),
          scope: [...target.manifest.scope],
          worktree: definition?.worktree ?? target.manifest.worktree,
          systemPromptFragment: definition?.systemPromptFragment ?? target.manifest.systemPromptFragment,
          inputOrigin: executionMode,
          workFocus: target.manifest.workFocus,
          ...(definition ? {
            research: {
              capability: definition.capability,
              resources: { ...definition.defaultResources, ...(params.resources ?? {}) },
            },
          } : {}),
        };
      }

      // Idempotent retry: a recorded request returns its outcome instead of
      // delivering or scheduling again (3.18C).
      if (params.requestId !== undefined) {
        const prior = priorMessage;
        if (prior) {
          if (priorIntent?.frozen && !upgradeRequested) {
            throw new HarnessServiceError("invalid-params", "requestId is already bound to a different execution identity");
          }
          if (!peerEquals(prior.from, fromPeer) || !peerEquals(prior.to, toPeer)
            || prior.kind !== kind || prior.text !== params.message || prior.replyTo !== params.replyTo
            || (kind === "request" && (prior.context ?? "continue") !== requestedMode)) {
            throw new HarnessServiceError("invalid-params", "requestId is already bound to a different message or sender");
          }
          if (upgradeRequested) {
            if (!priorIntent || !sameFrozenRunConfig(priorIntent.frozen, rerouteFrozen) || priorIntent.mode !== executionMode) {
              throw new HarnessServiceError("invalid-params", "requestId is already bound to a different execution identity");
            }
          }
          if (target?.pendingContinuations?.some((request) => request.requestId === prior.id)) {
            return { accepted: true, lifecycle: target.lifecycle, attention: target.attention,
              messageId: prior.id, delivery: "scheduled" };
          }
          if (prior.status === "failed") throw new HarnessServiceError("unavailable", prior.failure ?? "This execution request previously failed");
          if (prior.status === "pending" || prior.status === "held") {
            if (prior.runId && target) {
              const attempt = (await registry.listRuns(workspaceId, target.id)).find((run) => run.id === prior.runId);
              if (!attempt || attempt.outcome !== null) {
                throw new HarnessServiceError("unavailable", attempt?.exitReason ?? "The recorded Run ended before input delivery was confirmed; inspect that Run rather than starting the request again");
              }
            }
          } else return {
            accepted: true,
            lifecycle: target?.lifecycle ?? "active",
            attention: target?.attention ?? "none",
            messageId: prior.id,
            delivery: deliveryOf(prior.status),
            ...(prior.runId ? { runId: prior.runId } : {}),
          };
        }
      }

      const recordState = (status: ThreadMessageRecord["status"], runId?: string) => registry.recordDirectedMessage(workspaceId, {
        id: requestId, from: fromPeer, to: toPeer, kind, text: params.message,
        ...(kind === "request" ? { context: requestedMode } : {}),
        ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
        status, ...(runId ? { runId } : {}), at: recordedAt,
      });
      // A request id is not a bearer capability. A sibling may answer only
      // requests actually addressed to it, not another sibling's dependency.
      const matchingReplyRequest = (message: ThreadMessageRecord): boolean => (
        message.id === params.replyTo && message.kind === "request"
        && peerEquals(message.to, fromPeer)
        && (peerEquals(message.from, toPeer)
          || (toPeer.kind === "session" && message.from.kind === "user" && message.from.id === toPeer.id))
      );
      const replyMine = params.replyTo === undefined ? undefined
        : owner?.messages?.find((message) => message.direction === "in" && matchingReplyRequest(message));
      const replyTheirs = params.replyTo === undefined ? undefined
        : target?.messages?.find((message) => message.direction === "out" && matchingReplyRequest(message));
      if (params.replyTo !== undefined && !replyMine && !replyTheirs) {
        throw new HarnessServiceError("denied", "replyTo does not identify a request between these actual peers");
      }
      const dependencySatisfied = replyTheirs !== undefined && replyTheirs.status !== "resolved";
      // Session target — the caller Thread's parent session. Sessions carry
      // no message ledger; delivery goes straight to the input boundary.
      if (targetSessionId !== null) {
        await recordState("pending");
        await host.threadSendToSession!(targetSessionId, params.message, {
          from: fromLabel,
          messageId: requestId,
          ...(kind === "request" ? { requestId } : {}),
        });
        await recordState("delivered");
        return { accepted: true, lifecycle: "active", attention: "none", messageId: requestId, delivery: "delivered" };
      }
      const thread = target!;
      if (thread.lifecycle === "archived") {
        throw new HarnessServiceError("unavailable", `Thread is archived: ${thread.id}`);
      }
      if (thread.deletion) {
        throw new HarnessServiceError("unavailable", `Thread is being deleted: ${thread.id}`);
      }
      if (thread.lifecycle === "queued") {
        if (upgradeRequested) {
          throw new HarnessServiceError("invalid-params", "capability/model re-routing needs a Thread that has completed a Run; dispatch carries the initial configuration");
        }
        // Held messages flush into the first Run's prompt at dequeue.
        await recordState("pending");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "scheduled" };
      }

      const run = await registry.getActiveRun(workspaceId, thread.id);
      const lostWorker = thread.lifecycle === "active"
        && (run?.outcome === "lost" || run?.workerState === "lost");

      if (upgradeRequested && !(thread.lifecycle === "settled" || lostWorker)) {
        throw new HarnessServiceError("invalid-params", `capability/model re-routing starts a new Run; the target is not continuable from lifecycle ${thread.lifecycle}`);
      }

      if (thread.lifecycle === "settled" || lostWorker) {
        if (kind === "inform") {
          // Notifications never resurrect finished work; they ride the next
          // Run's input when one is requested (3.18C).
          await recordState("held");
          return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "held" };
        }
        if (!host.threadContinueRun) {
          throw new HarnessServiceError("unavailable", "Thread runtime is not configured for continuation");
        }
        // A capability/model re-route resolves its frozen configuration now:
        // "inherit" keeps the Thread's recorded model, an explicit selection
        // re-routes it, and a capability carries its own tools/fragment/
        // resources. Earlier Runs are never rewritten (7B/D-300).
        // Record first so a retry cannot double-schedule while the Run starts.
        await recordState("pending");
        let continued: { runId?: string };
        try {
          continued = await host.threadContinueRun({
            scopeId: workspaceId,
            parent: thread.parent,
            threadId: thread.id,
            mode: executionMode,
            task: params.message,
            requestId,
            from: fromPeer,
            ...(rerouteFrozen ? { frozen: rerouteFrozen } : {}),
          });
        } catch (error) {
          return continueError(error);
        }
        if (continued.runId === undefined) {
          // A scheduled response promises a durable execution intent, not merely
          // a pending message. The runtime normally recorded it; enforce that
          // postcondition idempotently at this public admission boundary too.
          await registry.enqueueContinuation(workspaceId, thread.id, {
            requestId, mode: executionMode, task: params.message, from: fromPeer,
            ...(rerouteFrozen ? { frozen: rerouteFrozen } : {}), at: recordedAt,
          });
          return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "scheduled" };
        }
        await recordState("delivered", continued.runId);
        return { accepted: true, lifecycle: "active", attention: "none", runId: continued.runId, messageId: requestId, delivery: "delivered" };
      }

      // lifecycle === "active" with a live or starting Run.
      if (!run || run.workerState === "exited" || (run.workerState === "running" && !run.sessionId)) {
        // Mid-settle or pre-bind: hold until the next normal input boundary.
        await recordState("held");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "held" };
      }
      if (run.workerState === "starting" && !run.sessionId) {
        // The Run's prompt is still being built; the message flushes into it.
        await recordState("pending");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "scheduled" };
      }

      const waiting = thread.waitingFor;
      const deliver = async (): Promise<void> => {
        // Held messages flush first so the session sees them in order.
        const held = await registry.listPendingThreadMessages(workspaceId, thread.id, requestId);
        for (const heldMessage of held) {
          await host.threadSendToSession!(run.sessionId!, heldMessage.text, {
            from: messagePeerLabel(heldMessage.from),
            messageId: heldMessage.id,
            ...(heldMessage.kind === "request" ? { requestId: heldMessage.id } : {}),
          });
          await registry.acknowledgeThreadMessages(workspaceId, thread.id, [heldMessage.id], run.id);
        }
        await host.threadSendToSession!(run.sessionId!, params.message, {
          from: fromLabel,
          messageId: requestId,
          ...(kind === "request" ? { requestId } : {}),
        });
      };

      if (kind === "inform" && !dependencySatisfied && waiting !== null) {
        // A waiting Thread keeps waiting: ordinary notifications record for
        // the next boundary instead of waking the model (3.18C).
        await recordState("held");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "held" };
      }
      await recordState("pending", run.id);
      await deliver();
      await recordState("delivered", run.id);
      // A request supersedes a dependency wait; a satisfying reply completes
      // the wait it was bound to. User/permission waits stay — a person is
      // still owed an answer.
      let attention = thread.attention;
      if (waiting?.kind === "thread" && (kind === "request" || dependencySatisfied)) {
        const updated = await registry.setAttention(workspaceId, thread.id, "none");
        attention = updated?.attention ?? "none";
      }
      return {
        accepted: true,
        lifecycle: "active",
        attention,
        runId: run.id,
        messageId: requestId,
        delivery: "delivered",
      };
      });

      // Correlated wait (7E/D-300): only a message whose replyTo names this
      // request satisfies it — unrelated arrivals never impersonate the
      // answer. The wait runs outside the delivery lock and yields the
      // caller's execution slot like thread.wait does.
      if (waitSeconds <= 0 || !sent.accepted) return sent;
      // A Thread caller watches its own ledger for the inbound reply; a
      // session caller watches the target's ledger for the outbound copy.
      const observedId = owner ? owner.id : target?.id;
      if (!observedId) return sent;
      const observedScope = owner ? owner.parent : target!.parent;
      const awaitedId = sent.messageId ?? params.requestId;
      if (!awaitedId) return sent;
      const replyOf = (record: { messages?: ThreadMessageRecord[] } | null | undefined): ThreadMessageRecord | undefined => (
        record?.messages?.find((message) => (
          message.direction === (owner ? "in" : "out")
          && message.replyTo === awaitedId
          && (message.status === "delivered" || message.status === "resolved")
        ))
      );
      const currentReply = async (): Promise<ThreadMessageRecord | undefined> => (
        replyOf(await registry.getThreadById(workspaceId, observedId) ?? undefined)
      );
      let reply = await currentReply();
      let timedOut = false;
      if (!reply) {
        if (owner?.activeRunId) {
          const marked = await registry.yieldExecutionSlot(workspaceId, owner.id, owner.activeRunId, {
            kind: "thread",
            text: `Waiting for a reply to ${awaitedId}`,
          });
          if (!marked) throw new HarnessServiceError("unavailable", "The waiting Run could not yield its execution slot");
        }
        const deadline = Date.now() + Math.min(waitSeconds * 1000, HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000);
        while (true) {
          ctx.signal.throwIfAborted();
          let wake!: (reason: "change" | "timeout" | "abort") => void;
          const notification = new Promise<"change" | "timeout" | "abort">((resolve) => { wake = resolve; });
          const unsubscribe = registry.subscribeToChanges(workspaceId, observedScope, () => wake("change"));
          const abort = () => wake("abort");
          ctx.signal.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(() => wake("timeout"), Math.max(0, deadline - Date.now()));
          try {
            reply = await currentReply();
            if (reply) break;
            if (Date.now() >= deadline) { timedOut = true; break; }
            const reason = await notification;
            if (reason === "abort") ctx.signal.throwIfAborted();
            if (reason === "timeout") {
              reply = await currentReply();
              timedOut = !reply;
              break;
            }
          } finally {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", abort);
            unsubscribe();
          }
        }
      }
      if (owner?.activeRunId) {
        await registry.awaitExecutionSlot(workspaceId, owner.id, owner.activeRunId, ctx.signal);
      }
      // Messages held while the caller waited flush at this boundary.
      if (owner) {
        const held = await registry.listPendingThreadMessages(workspaceId, owner.id);
        for (const heldMessage of held) {
          await host.threadSendToSession(ctx.sessionId, heldMessage.text, {
            from: messagePeerLabel(heldMessage.from),
            messageId: heldMessage.id,
            ...(heldMessage.kind === "request" ? { requestId: heldMessage.id } : {}),
          });
          await registry.acknowledgeThreadMessages(workspaceId, owner.id, [heldMessage.id], owner.activeRunId ?? undefined);
        }
      }
      return {
        ...sent,
        ...(reply ? {
          reply: { messageId: reply.id, text: reply.text, from: reply.from, at: reply.at },
        } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      };
    },
  };
}

export function createThreadHistoryService(host: HarnessServiceHost): HarnessService<"thread.history"> {
  return { handle: async (params, ctx) => {
    const registry = host.threadRegistry;
    if (!registry || !host.threadHistoryEntries) throw new HarnessServiceError("unavailable", "Previous-Run history is unavailable");
    const { workspaceId, owner } = await resolveOwningContext(host, ctx);
    if (!owner) throw new HarnessServiceError("denied", "Previous-Run history is restricted to this Thread's own retained Runs");
    assertOwnerTool(owner, "history");
    if (typeof params.runId !== "string" || !params.runId) throw new HarnessServiceError("invalid-params", "History requires a source Run id");
    const run = (await registry.listRuns(workspaceId, owner.id)).find((candidate) => candidate.id === params.runId);
    if (!run) throw new HarnessServiceError("denied", "The requested Run does not belong to the calling Thread");
    if (!run.sessionId) throw new HarnessServiceError("unavailable", "This Run has no retained Pi transcript");
    ctx.signal.throwIfAborted();
    const source = await host.threadHistoryEntries(run.sessionId);
    ctx.signal.throwIfAborted();
    if (source.sessionId !== run.sessionId || source.scope !== "branch") throw new HarnessServiceError("unavailable", "The source transcript identity did not match the retained Run");
    let page: ReturnType<typeof readHistoryPage>;
    const scopedEntries = entriesForRun(source.entries, run, await registry.listRuns(workspaceId, owner.id));
    if (scopedEntries === null) throw new HarnessServiceError("unavailable", "The requested Run transcript bounds are unavailable");
    try { page = readHistoryPage(scopedEntries, params); }
    catch (error) { throw new HarnessServiceError("invalid-params", error instanceof Error ? error.message : String(error)); }
    return { ...page, details: { ...page.details, runId: run.id, sessionId: run.sessionId, threadId: owner.id } };
  } };
}

export function createThreadReadService(host: HarnessServiceHost): HarnessService<"thread.read"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { workspaceId, owner } = owning;
      assertOwnerTool(owner, "read_thread");
      const thread = await visibleThread(host, owning, params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      let run = await registry.getActiveRun(workspaceId, thread.id);
      let delivery = thread.report;
      if (params.runId !== undefined || params.resultRevision !== undefined) {
        if (params.runId !== undefined && (typeof params.runId !== "string" || !params.runId)
          || params.resultRevision !== undefined && (!Number.isSafeInteger(params.resultRevision) || params.resultRevision < 1)) {
          throw new HarnessServiceError("invalid-params", "A fixed delivery requires a valid Run or result revision");
        }
        const selected = (await registry.listRuns(workspaceId, thread.id)).find((candidate) => (
          (params.runId === undefined || candidate.id === params.runId)
          && (params.resultRevision === undefined || candidate.report?.resultRevision === params.resultRevision)
        ));
        if (!selected) throw new HarnessServiceError("not-found", "The requested delivery does not belong to this Thread");
        run = selected;
        delivery = selected.report ?? null;
      }
      const what: ThreadReadWhat = params.what ?? "blocks";
      const lines: string[] = [];
      if (params.runId !== undefined || params.resultRevision !== undefined) lines.push(`Fixed delivery: Run ${run!.id}${delivery?.resultRevision ? ` / result r${delivery.resultRevision}` : ""}`);
      if (what === "blocks") {
        lines.push(`Thread ${thread.id} (${thread.preset ?? "unknown"}) — ${threadState({ thread, activeRun: run })}`);
        lines.push(`Brief: ${thread.brief}`);
        lines.push(`Steps: ${run?.steps ?? 0} · Last activity: ${run?.lastActivityAt ?? thread.updatedAt}`);
        if (run?.lastToolCall) lines.push(`Last tool: ${run.lastToolCall.name} at ${run.lastToolCall.at}`);
        if (thread.waitingFor) lines.push(`Waiting for: ${thread.waitingFor.kind} — ${thread.waitingFor.text}`);
        if (thread.attention !== "none") lines.push(`Attention: ${thread.attention}`);
        if (run?.workerState === "lost") lines.push("Run: worker-lost");
        if (delivery?.blocksSnapshot) {
          for (const [label, content] of Object.entries(delivery.blocksSnapshot)) {
            lines.push(`\n[${label}]`);
            lines.push(content);
          }
        }
        return { text: lines.join("\n"), report: null, transcriptRef: null };
      }
      if (what === "report") {
        if (!delivery) {
          return {
            text: `Thread ${thread.id} has no report yet (state: ${thread.lifecycle}/${thread.attention}/${thread.integration})`,
            report: null,
            transcriptRef: null,
          };
        }
        const report = delivery;
        if (report.evidence) {
          let visibleBytes = DEFAULT_HARNESS_SETTINGS.output.visibleBytes;
          try {
            const settings = await host.harnessSettings?.(workspaceId);
            const asRecord = (value: unknown): Record<string, unknown> => (
              value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
            );
            if (settings) {
              visibleBytes = mergeHarnessSettings(
                asRecord(asRecord(settings.global).harness),
                settings.projectTrusted ? asRecord(asRecord(settings.project).harness) : {},
              ).output.visibleBytes;
            }
          } catch {
            // The established default remains the display budget when settings are unavailable.
          }
          const page = await readRetrievalReportPage({
            host,
            workspaceId,
            heading: `Thread ${thread.id} (${thread.preset ?? "unknown"}) — Report`,
            evidence: report.evidence,
            offset: params.offset ?? 0,
            length: params.length ?? visibleBytes,
          });
          return {
            text: page.text,
            report,
            transcriptRef: report.transcriptRef,
            nextOffset: page.nextOffset,
            eof: page.eof,
          };
        } else {
          lines.push(`Thread ${thread.id} (${thread.preset ?? "unknown"}) — Report`);
          lines.push(`Conclusion: ${report.conclusion}`);
          lines.push(`Changed files: ${report.changedFiles.join(", ") || "(none)"}`);
          lines.push(`Deviations from brief: ${report.deviations.join("; ") || "none"}`);
          lines.push(`Unresolved: ${report.unresolved.join("; ") || "none"}`);
          lines.push(`Confidence: ${report.confidence}`);
        }
        const full = lines.join("\n");
        if (params.offset !== undefined || params.length !== undefined) {
          const slice = sliceUtf8ByBytes(full, params.offset ?? 0, params.length ?? 32_768);
          return {
            text: slice.text,
            report,
            transcriptRef: report.transcriptRef,
            nextOffset: slice.nextOffset,
            eof: slice.eof,
          };
        }
        return { text: full, report, transcriptRef: report.transcriptRef, eof: true };
      }
      if (what === "transcript") {
        if (!host.threadHistoryEntries) {
          throw new HarnessServiceError("unavailable", "Transcript history is unavailable");
        }
        // Default to the Run that owns visible output: the active Run, else
        // the latest retained session — the same identity the status table
        // excerpts, so an entry id always resolves against it.
        const source = run?.sessionId ? run
          : (await registry.listRuns(workspaceId, thread.id)).findLast((candidate) => candidate.sessionId);
        if (!source?.sessionId) {
          return { text: `Thread ${thread.id} has no retained transcript yet`, report: null, transcriptRef: null };
        }
        const history = await host.threadHistoryEntries(source.sessionId);
        ctx.signal.throwIfAborted();
        if (history.sessionId !== source.sessionId || history.scope !== "branch") {
          throw new HarnessServiceError("unavailable", "The transcript identity did not match the selected Run");
        }
        const runs = await registry.listRuns(workspaceId, thread.id);
        const scopedEntries = entriesForRun(history.entries, source, runs);
        if (scopedEntries === null) {
          throw new HarnessServiceError("unavailable", "The selected Run transcript bounds are unavailable");
        }
        let page: ReturnType<typeof readHistoryPage>;
        try {
          page = readHistoryPage(scopedEntries, {
            ...(params.entry !== undefined ? { entry: params.entry } : {}),
            ...(params.before !== undefined ? { before: params.before } : {}),
            ...(params.after !== undefined ? { after: params.after } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(params.query !== undefined ? { query: params.query } : {}),
            ...(params.path !== undefined ? { path: params.path } : {}),
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
          });
        } catch (error) {
          throw new HarnessServiceError("invalid-params", error instanceof Error ? error.message : String(error));
        }
        const text = page.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const images = page.content.length - page.content.filter((part) => part.type === "text").length;
        return {
          text: images > 0 ? `${text}\n[${images} image(s) retained in the transcript — not rendered here]` : text,
          report: null,
          transcriptRef: source.report?.transcriptRef ?? delivery?.transcriptRef ?? null,
          details: { ...page.details, threadId: thread.id, runId: source.id, sessionId: source.sessionId },
        };
      }
      const since = params.since ?? 0;
      if (!delivery) {
        return { text: `Thread ${thread.id} has no durable transcript reference yet`, report: null, transcriptRef: null };
      }
      if (!host.threadTranscriptReader) {
        throw new HarnessServiceError("unavailable", "Thread transcript reader is not configured");
      }
      return {
        text: await host.threadTranscriptReader.read(delivery.transcriptRef, since),
        report: null,
        transcriptRef: delivery.transcriptRef,
      };
    },
  };
}

export function createThreadMergeService(host: HarnessServiceHost): HarnessService<"thread.merge"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadApplyWorktreeDiff) throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { workspaceId, owner } = owning;
      assertOwnerTool(owner, "merge");
      const thread = await visibleThread(host, owning, params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      const selectedRevision = params.resultRevision ?? thread.resultRevision;
      const alreadyMerged = selectedRevision !== undefined
        ? thread.mergedResultRevision === selectedRevision
        : Boolean(thread.worktree?.resultCommit && thread.mergedCommit === thread.worktree.resultCommit);
      if (thread.integration === "merged" && alreadyMerged) {
        return {
          text: `thread ${thread.id} is already merged`,
          merged: 0,
          conflicts: [],
          ...(selectedRevision === undefined ? {} : { resultRevision: selectedRevision }),
        };
      }
      const run = await registry.getActiveRun(workspaceId, thread.id);
      // A native WorkingBranch owns the default merge source.  A legacy Git
      // resultCommit is only importable before that branch exists; it must not
      // mask a failed native publish or an old Run's revision.
      const hasPublishedResult = thread.workBranchId
        ? selectedRevision !== undefined
        : Boolean(thread.worktree?.resultCommit);
      if ((thread.lifecycle !== "settled" || !run?.outcome) && !(thread.workBranchId && params.resultRevision !== undefined)) {
        return { text: `thread ${thread.id} is not complete (state: ${thread.lifecycle}/${run?.outcome ?? "none"})`, merged: 0, conflicts: [] };
      }
      if (!hasPublishedResult) throw new HarnessServiceError("unavailable", `Thread ${thread.id} has no published result to merge`);
      if (host.requireThreadMergeJournal && !ctx.actor.runId) {
        throw new HarnessServiceError("unavailable", "Thread integration requires an active parent turn recovery binding");
      }
      let sourceOwner: { ownerId: string; generation: number } | undefined;
      if (ctx.inputContext?.source === "surface"
        && ctx.inputContext.roots.some((root) => root.workspaceId === workspaceId && root.dirtyPaths.length > 0)) {
        const resolved = host.agentInputSurfaceOwner?.(ctx.sessionId, ctx.inputContext, workspaceId);
        if (!resolved) {
          throw new HarnessServiceError("unavailable", "The originating document surface for this turn is no longer available");
        }
        sourceOwner = { ownerId: resolved.ownerId, generation: resolved.generation };
      }
      const result = await host.threadApplyWorktreeDiff(
        workspaceId,
        // The merge lands on the caller's receiving surface — under a bot-root
        // family the current root, not the thread's original parent record.
        owning.parent,
        thread.id,
        params.resultRevision,
        ctx.actor.runId,
        {
          ...(sourceOwner ? { sourceOwner } : {}),
          ...(params.expectedBindingFingerprint ? { expectedBindingFingerprint: params.expectedBindingFingerprint } : {}),
          ...(params.resolutions ? { resolutions: params.resolutions } : {}),
          signal: ctx.signal,
        },
      );
      const appliedRevision = result.resultRevision ?? selectedRevision;
      const appliedDraftPaths = result.preview?.paths.filter((path) => (
        path.target === "surface" && path.phase === "surface-applied"
      )).map((path) => path.path) ?? [];
      const pendingSurfaceTargetPaths = result.preview
        ? result.preview.paths.filter((path) => (
            path.target === "surface" && path.phase !== "surface-applied" && path.phase !== "skipped-identical"
          )).map((path) => path.path)
        : result.surfaceTargetPaths ?? [];
      const surfacePending = pendingSurfaceTargetPaths.length > 0;
      if (result.conflicts.length > 0 || result.status === "conflict" || result.status === "compensated" || result.status === "needs-attention" || surfacePending) {
        if (!result.preview) {
          await registry.setIntegration(workspaceId, thread.id, "conflict", result.diffStats);
        }
        const surfaceTargetPaths = result.surfaceTargetPaths ?? [];
        const resolution: string[] = [];
        if (pendingSurfaceTargetPaths.length > 0) {
          resolution.push(`Editor draft paths still require attention: ${pendingSurfaceTargetPaths.join(", ")}. Reopen the originating surface or resolve those paths before retrying.`);
        }
        if (result.status === "needs-attention") {
          resolution.push("Some paths could not be restored automatically. Inspect the integration operation and resolve them before retrying.");
        } else if (result.status === "compensated") {
          resolution.push("Merge failed unexpectedly; changes were safely compensated.");
        } else if (result.conflictState === "markers") {
          resolution.push("Conflict markers placed in the parent. Resolve those paths; no further merge step is needed.");
        } else if (surfaceTargetPaths.length === 0) {
          resolution.push(result.appliedPaths?.length
            ? "The listed paths were written; conflicting paths require a version choice. The published child result is retained."
            : "The parent was left unchanged. The published child result is retained; resolve conflicting paths, then retry merge.");
        }
        const lines = [
          result.conflicts.length > 0
            ? `merge could not apply ${result.conflicts.length} files cleanly:`
            : `merge encountered failure (${result.status}):`,
          ...result.conflicts,
        ];
        if (result.appliedPaths && result.appliedPaths.length > 0) {
          lines.push(`written paths (${result.appliedPaths.length}): ${result.appliedPaths.join(", ")}`);
        }
        if (appliedDraftPaths.length > 0) lines.push(`Editor drafts updated without saving: ${appliedDraftPaths.join(", ")}. Disk-based commands still read the saved files.`);
        lines.push(...resolution);
        return {
          text: lines.join("\n"),
          merged: result.appliedPaths?.length ?? 0,
          conflicts: result.conflicts,
          status: result.status ?? "conflict",
          ...(result.appliedPaths ? { appliedPaths: result.appliedPaths } : {}),
          ...(surfaceTargetPaths.length > 0 ? { surfaceTargetPaths } : {}),
          ...(result.preview ? { preview: result.preview } : {}),
          ...(appliedRevision === undefined ? {} : { resultRevision: appliedRevision }),
          ...(result.operationId ? { operationId: result.operationId } : {}),
        };
      }
      if (!result.preview) {
        await registry.setIntegration(
          workspaceId,
          thread.id,
          "merged",
          result.diffStats,
          appliedRevision === undefined ? thread.worktree?.resultCommit : undefined,
          appliedRevision,
        );
      }
      return {
        text: [
          `merged ${result.merged} files from ${appliedRevision === undefined ? "the fixed Git result" : `result revision ${appliedRevision}`}: ${result.changedFiles?.join(", ") ?? ""}`,
          ...(appliedDraftPaths.length > 0 ? [`Editor drafts updated without saving: ${appliedDraftPaths.join(", ")}. Disk-based commands still read the saved files.`] : []),
        ].join("\n"),
        merged: result.merged,
        conflicts: [],
        status: "applied",
        ...(result.appliedPaths ? { appliedPaths: result.appliedPaths } : {}),
        ...(appliedDraftPaths.length > 0 ? { surfaceTargetPaths: appliedDraftPaths } : {}),
        ...(appliedRevision === undefined ? {} : { resultRevision: appliedRevision }),
        ...(result.operationId ? { operationId: result.operationId } : {}),
      };
    },
  };
}

export function createThreadUpdateService(host: HarnessServiceHost): HarnessService<"thread.update"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadUpdateBaseline) throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { workspaceId, owner } = owning;
      assertOwnerTool(owner, "update");
      const thread = await visibleThread(host, owning, params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      const result = await host.threadUpdateBaseline(
        workspaceId,
        thread.parent,
        thread.id,
        params.resultRevision,
        { signal: ctx.signal },
      );
      return {
        text: result.status === "applied"
          ? `updated thread ${thread.id} baseline to parent result revision ${result.resultRevision}: ${result.updatedFromParent.length} paths adopted, ${result.keptPaths.length} kept, ${result.mergedPaths.length} merged${result.conflicts.length > 0 ? `, ${result.conflicts.length} conflicts kept the thread's bytes` : ""}`
          : result.status === "conflict"
            ? (result.message ?? `thread ${thread.id} baseline update conflicted with concurrent writes; retry the update`)
            : (result.message ?? `thread ${thread.id} baseline updated but requires attention`),
        status: result.status,
        resultRevision: result.resultRevision,
        baseRef: result.baseRef,
        updatedFromParent: result.updatedFromParent,
        keptPaths: result.keptPaths,
        mergedPaths: result.mergedPaths,
        conflicts: result.conflicts,
      };
    },
  };
}

type RetrievalReportSegment =
  | { kind: "text"; bytes: Buffer; byteLength: number }
  | { kind: "artifact"; artifact: RetrievalArtifactRef; byteLength: number };

const retrievalReportSegments = (heading: string, evidence: RetrievalEvidence): RetrievalReportSegment[] => {
  const segments: RetrievalReportSegment[] = [];
  const includedArtifacts = new Set<string>();
  const text = (value: string): void => {
    const bytes = Buffer.from(value, "utf8");
    segments.push({ kind: "text", bytes, byteLength: bytes.byteLength });
  };
  const artifact = (ref: RetrievalArtifactRef): void => {
    if (includedArtifacts.has(ref.hash)) {
      text(`\n    [artifact ${ref.hash} already included]`);
      return;
    }
    includedArtifacts.add(ref.hash);
    text(`\n    <evidence-artifact hash="${ref.hash}" bytes="${ref.byteLength}">\n`);
    segments.push({ kind: "artifact", artifact: ref, byteLength: ref.byteLength });
    text("\n    </evidence-artifact>");
  };

  text(`${heading}\nQuestion: ${evidence.question}\nScope: ${evidence.scope.join(", ") || "(workspace)"}\nCompletion: ${evidence.completion}\nFacts (${evidence.facts.length}):`);
  for (const fact of evidence.facts) {
    text(`\n- [${fact.status}] ${fact.claim}`);
    for (const source of fact.sources) {
      if (source.kind === "local") {
        const range = source.startLine !== undefined && source.endLine !== undefined
          ? `:${source.startLine}-${source.endLine}`
          : "";
        const revision = source.revision ? ` @${source.revision}` : "";
        const origin = source.origin ? ` (${source.origin})` : "";
        const check = source.check ? ` ${source.check}` : "";
        text(`\n  ${source.path ?? "?"}${range}${revision}${origin}${check}`);
      } else if (source.kind === "url") {
        text(`\n  ${source.url ?? "?"}${source.receiptId ? ` receipt ${source.receiptId}` : ""}`);
      } else {
        text(`\n  ${source.artifact ? `output artifact ${source.artifact.hash}` : `output ${source.outputRef?.handle ?? "?"}`}`);
      }
      if (source.excerpt !== undefined) {
        text(`\n${source.excerpt.split("\n").map((line) => `    ${line}`).join("\n")}`);
      } else if (source.artifact) {
        artifact(source.artifact);
      }
    }
  }
  if (evidence.unknowns.length > 0) {
    text(`\nUnknowns:${evidence.unknowns.map((item) => `\n- ${item}`).join("")}`);
  }
  if (evidence.attempted.length > 0) {
    text(`\nAttempted:${evidence.attempted.map((item) => (
      `\n- ${item.action}: ${item.outcome}${item.detail ? ` (${item.detail})` : ""}`
    )).join("")}`);
  }
  return segments;
};

const readRetrievalReportPage = async (input: {
  host: HarnessServiceHost;
  workspaceId: string;
  heading: string;
  evidence: RetrievalEvidence;
  offset: number;
  length: number;
}): Promise<{ text: string; nextOffset: number; eof: boolean }> => {
  const segments = retrievalReportSegments(input.heading, input.evidence);
  const total = segments.reduce((sum, segment) => sum + segment.byteLength, 0);
  const requestedOffset = Math.min(Math.max(0, Math.floor(input.offset)), total);
  const requestedLength = Number.isFinite(input.length)
    ? Math.max(1, Math.floor(input.length))
    : total;
  const windowStart = Math.max(0, requestedOffset - 3);
  const windowEnd = Math.min(total, requestedOffset + requestedLength + 3);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const segmentStart = cursor;
    const segmentEnd = cursor + segment.byteLength;
    cursor = segmentEnd;
    if (segmentEnd <= windowStart || segmentStart >= windowEnd) continue;
    const start = Math.max(0, windowStart - segmentStart);
    const end = Math.min(segment.byteLength, windowEnd - segmentStart);
    if (segment.kind === "text") {
      chunks.push(segment.bytes.subarray(start, end));
      continue;
    }
    if (!input.host.readRetrievalArtifactSlice) {
      throw new HarnessServiceError("unavailable", "Retrieval artifact paging is not configured");
    }
    const bytes = await input.host.readRetrievalArtifactSlice(
      input.workspaceId,
      segment.artifact,
      start,
      end - start,
    );
    if (!bytes || bytes.byteLength !== end - start) {
      throw new HarnessServiceError("unavailable", `Retrieval evidence artifact is unavailable: ${segment.artifact.hash}`);
    }
    chunks.push(bytes);
  }
  const window = Buffer.concat(chunks);
  const sliced = sliceUtf8ByBytes(window, requestedOffset - windowStart, requestedLength);
  const nextOffset = windowStart + sliced.nextOffset;
  return { text: sliced.text, nextOffset, eof: nextOffset >= total };
};

const compareThreadsStable = (
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number => {
  const byCreated = left.createdAt.localeCompare(right.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
};

const cascadeStopDescendants = async (
  host: HarnessServiceHost,
  workspaceId: string,
  threadId: string,
  keepWorktree: boolean,
  reason: string,
): Promise<void> => {
  const registry = host.threadRegistry!;
  const children = (await registry.listThreads(workspaceId, { kind: "thread", id: threadId }, true))
    .toSorted(compareThreadsStable);
  for (const child of children) {
    await cascadeStopDescendants(host, workspaceId, child.id, keepWorktree, reason);
    if (host.threadKillSession) await host.threadKillSession(child.id, keepWorktree, workspaceId);
    await registry.cancelThread(workspaceId, child.id, reason);
  }
};

export function createThreadKillService(host: HarnessServiceHost): HarnessService<"thread.kill"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const owning = await resolveOwningContext(host, ctx);
      const { workspaceId, owner } = owning;
      assertOwnerTool(owner, "kill");
      const thread = await visibleThread(host, owning, params.threadId);
      if (!thread) return { text: `unknown thread: ${params.threadId}` };
      const keepWorktree = params.keepWorktree ?? false;
      const releaseCascade = !host.threadKillSession && typeof registry.beginCascade === "function"
        ? await registry.beginCascade(workspaceId, thread.id)
        : () => undefined;
      try {
        if (host.threadKillSession) {
          await host.threadKillSession(thread.id, keepWorktree, workspaceId);
        } else {
          await cascadeStopDescendants(host, workspaceId, thread.id, keepWorktree, "killed by parent");
        }
        await registry.cancelThread(workspaceId, thread.id, "killed by parent");
      } finally {
        releaseCascade();
      }
      return { text: `killed ${thread.id}${keepWorktree ? " (worktree kept)" : ""}` };
    },
  };
}
