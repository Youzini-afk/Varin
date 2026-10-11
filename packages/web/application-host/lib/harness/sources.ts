/**
 * research.source records: durable shared research inputs (7C, D-300).
 *
 * A source is a named, provenance-carrying input that experiments and threads
 * can pin by identity — a dataset URI, a paper, a code snapshot or an object in
 * the workspace store. Registering a source does not fetch or copy it; the
 * locator records where the material actually lives.
 */
import { createHash, randomUUID } from "node:crypto";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type { ResearchSourceView, SourceListParams, SourceListResult, SourceRegisterParams } from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";
import { mayAccessResearch, requireResearchOwner, type ExperimentCaller } from "./research-identity.js";

const SOURCE_PREFIX = "research.source:";
export const SOURCE_KINDS = new Set(["dataset", "paper", "code", "artifact", "collection", "other"]);

const mayRead = (record: KernelRecordResult, caller: ExperimentCaller): boolean => mayAccessResearch(caller, record);

const relativeSourcePath = (value: string, scope?: readonly string[]): string => {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")
    || normalized.split("/").includes("..")) {
    throw new HarnessServiceError("invalid-params", "source path must be workspace-relative");
  }
  const result = normalized.split("/").filter((part) => part && part !== ".").join("/");
  if (!result) throw new HarnessServiceError("invalid-params", "source path must identify a file or directory");
  if (scope?.length && !scope.some((root) => root === "" || result === root || result.startsWith(`${root}/`))) {
    throw new HarnessServiceError("denied", "source path is outside the actor scope");
  }
  return result;
};

interface SourceServiceDeps {
  client: KernelClient;
  now?: () => number;
  /** Source fact changed — drives UI refresh. */
  onChange?: (workspaceId: string) => void;
}

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const str = (value: unknown): string | undefined => (
  typeof value === "string" && value ? value : undefined
);

const view = (record: KernelRecordResult): ResearchSourceView | null => {
  const payload = payloadOf(record);
  const sourceId = str(payload.id);
  const kind = str(payload.kind);
  if (!sourceId || !kind) return null;
  const label = str(payload.label);
  const uri = str(payload.uri);
  const sourcePath = str(payload.path);
  const objectHash = record.references.find((reference) => reference.slot === "content")?.objectHash;
  if (payload.objectHash && payload.objectHash !== objectHash) {
    throw new HarnessServiceError("unavailable", "Research source content reference is inconsistent");
  }
  const note = str(payload.note);
  return {
    sourceId,
    kind,
    ...(label ? { label } : {}),
    ...(uri ? { uri } : {}),
    ...(sourcePath ? { path: sourcePath } : {}),
    ...(objectHash ? { objectHash } : {}),
    ...(note ? { note } : {}),
    state: record.state === "retired" ? "retired" : "available",
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    createdAt: record.createdAt,
  };
};

export function createSourceService(deps: SourceServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const contexts = new Map<string, Promise<KernelScopedClient>>();

  const context = (workspaceId: string): Promise<KernelScopedClient> => {
    const existing = contexts.get(workspaceId);
    if (existing) return existing;
    const creating = (async () => {
      const grant = await deps.client.issueGrant({
        grantId: `source:${randomUUID()}`,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return deps.client.scoped(grant);
    })();
    contexts.set(workspaceId, creating);
    void creating.catch(() => { if (contexts.get(workspaceId) === creating) contexts.delete(workspaceId); });
    return creating;
  };

  const register = async (
    workspaceId: string,
    params: SourceRegisterParams,
    actor: ExperimentCaller,
  ): Promise<ResearchSourceView> => {
    const originalOwner = requireResearchOwner(actor);
    const kind = typeof params.kind === "string" ? params.kind.trim() : "";
    if (!SOURCE_KINDS.has(kind)) {
      throw new HarnessServiceError("invalid-params", `source kind must be one of ${[...SOURCE_KINDS].join(", ")}`);
    }
    const uri = typeof params.uri === "string" && params.uri.trim() ? params.uri.trim() : undefined;
    const path = typeof params.path === "string" && params.path.trim()
      ? relativeSourcePath(params.path.trim(), actor.workspaceScope) : undefined;
    if (params.objectHash !== undefined && !/^sha256-[a-f0-9]{64}$/.test(params.objectHash)) {
      throw new HarnessServiceError("invalid-params", "source objectHash must be a SHA-256 object identity");
    }
    const objectHash = params.objectHash;
    if (!uri && !path && !objectHash) {
      throw new HarnessServiceError("invalid-params", "source requires a uri, path or objectHash locator");
    }
    const sourceId = actor.owner.runtime === "agent" ? `source-${createHash("sha256").update(originalOwner.runtime === "agent" ? originalOwner.operationId : "").digest("hex")}` : `source-${randomUUID()}`;
    const scoped = await context(workspaceId);
    const prior = await scoped.getRecord(workspaceId, `${SOURCE_PREFIX}${sourceId}`);
    if (prior) {
      if (!mayRead(prior, actor) || JSON.stringify(payloadOf(prior).request) !== JSON.stringify(params)) throw new HarnessServiceError("invalid-params", "Source registration intent changed");
      const result = view(prior); if (!result) throw new HarnessServiceError("unavailable", "Original source registration is unreadable"); return result;
    }
    const record = await scoped.putRecord({
      operationId: actor.owner.runtime === "agent" ? `research.source:${originalOwner.runtime === "agent" ? originalOwner.operationId : ""}` : `research.source:${randomUUID()}`,
      recordId: `${SOURCE_PREFIX}${sourceId}`,
      workspaceId,
      recordType: "research.source",
      state: "available",
      payloadJson: JSON.stringify({
        id: sourceId,
        workspaceId,
        researchOwner: originalOwner, request: params,
        executionWorkspaceId: actor.executionWorkspaceId,
        kind,
        ...(params.label?.trim() ? { label: params.label.trim() } : {}),
        ...(uri ? { uri } : {}),
        ...(path ? { path } : {}),
        ...(objectHash ? { objectHash } : {}),
        ...(params.note?.trim() ? { note: params.note.trim() } : {}),
        createdAt: now(),
      }),
      ownerIds: [],
      references: objectHash ? [{ slot: "content", objectHash }] : [],
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
      ...(actor.threadId ? { threadId: actor.threadId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
    });
    const result = view(record);
    if (!result) throw new HarnessServiceError("failed", "registered source record is unreadable");
    try { deps.onChange?.(workspaceId); } catch { /* observer errors must not break writes */ }
    return result;
  };

  const get = async (workspaceId: string, sourceId: string, caller: ExperimentCaller): Promise<ResearchSourceView | null> => {
    const scoped = await context(workspaceId);
    const record = await scoped.getRecord(workspaceId, `${SOURCE_PREFIX}${sourceId}`);
    if (record && !mayRead(record, caller)) throw new HarnessServiceError("denied", "Research source is outside the caller's task relationships");
    return record ? view(record) : null;
  };

  const list = async (workspaceId: string, params: SourceListParams, caller: ExperimentCaller): Promise<SourceListResult> => {
    const scoped = await context(workspaceId);
    const all: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId, recordType: "research.source", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    const sources = all
      .filter((record) => mayRead(record, caller))
      .map(view)
      .filter((entry): entry is ResearchSourceView => entry !== null)
      .filter((entry) => params.kind === undefined || entry.kind === params.kind);
    const text = sources.length === 0
      ? "No research sources registered."
      : sources.map((entry) => {
          const locator = entry.uri ?? entry.path ?? entry.objectHash ?? "?";
          return `${entry.sourceId} · ${entry.kind}${entry.label ? ` · ${entry.label}` : ""} · ${locator}${entry.state === "retired" ? " (retired)" : ""}`;
        }).join("\n");
    return { sources, text };
  };

  return { register, get, list };
}

export type SourceService = ReturnType<typeof createSourceService>;
