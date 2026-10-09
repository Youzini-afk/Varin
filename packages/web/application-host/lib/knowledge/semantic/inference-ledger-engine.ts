/** Sole durable owner of semantic inference admission and receipt facts.
 * Loaded only inside the existing private semantic storage process. */
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { remoteEmbeddingSpaceParts, type HarnessEmbedResult } from "@varin/protocol";
import { createStorePersistence, trackStoreMutations } from "../persistence.js";
import { semanticInferenceOperationKey, type SemanticInferenceAdmission, type SemanticInferenceAdmissionResult,
  type SemanticInferenceFact, type SemanticInferenceFactFilter, type SemanticInferenceLedgerIdentity,
  type SemanticInferenceLedgerOpenOptions, type SemanticInferenceOperation, type SemanticInferenceSettlement } from "./inference-ledger-contract.js";
import type { NativeSemanticInferenceReceipt } from "./native-inference.js";

const { TriviumDB } = createRequire(import.meta.url)("triviumdb") as typeof import("triviumdb");
type Entry = SemanticInferenceFact & { type: "semantic-inference" | "semantic-inference-attempt"; token: string; result?: HarnessEmbedResult };
const invalid = (): never => { throw new Error("Invalid semantic inference ledger record"); };
const text = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : invalid();
const integer = (value: unknown, minimum = 0): number => Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : invalid();
const hash = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid();

function identityOf(input: SemanticInferenceLedgerIdentity): SemanticInferenceLedgerIdentity {
  if (!input || input.protocol !== "openai-compatible" || !input.operation) return invalid();
  const source = input.operation;
  let operation: SemanticInferenceOperation;
  if (source.kind === "native-query") {
    const invocation = source.invocation;
    if (!invocation || source.stage !== "native-code-retrieval.semantic.query-embedding") return invalid();
    operation = { kind: source.kind, hostId: text(source.hostId), threadId: text(source.threadId), runId: text(source.runId),
      stage: source.stage, invocation: invocation.kind === "model_step"
        ? { kind: invocation.kind, requestId: text(invocation.requestId), toolCallId: text(invocation.toolCallId) }
        : invocation.kind === "policy_action"
          ? { kind: invocation.kind, actionId: text(invocation.actionId), nodeId: text(invocation.nodeId), toolCallId: text(invocation.toolCallId) }
          : invalid() };
  } else if (source.kind === "index-build" && source.stage === "document-embedding") {
    operation = { kind: source.kind, hostId: text(source.hostId), workspaceId: text(source.workspaceId),
      recipeId: text(source.recipeId), stage: source.stage };
  } else return invalid();
  if (!Array.isArray(input.inputHashes) || input.inputHashes.length === 0) return invalid();
  return { providerId: text(input.providerId), modelId: text(input.modelId), protocol: input.protocol,
    configurationId: text(input.configurationId), endpointHash: hash(input.endpointHash),
    credentialScopeHash: hash(input.credentialScopeHash), maxTokens: integer(input.maxTokens, 1),
    ...(input.dimensions === undefined ? {} : { dimensions: integer(input.dimensions, 1) }),
    operation, inputHashes: input.inputHashes.map(hash) };
}

function receiptOf(input: NativeSemanticInferenceReceipt, identity: SemanticInferenceLedgerIdentity): NativeSemanticInferenceReceipt {
  if (!input || input.providerId !== identity.providerId || input.modelId !== identity.modelId
    || input.configurationId !== identity.configurationId
    || input.purpose !== (identity.operation.kind === "native-query" ? "query-embedding" : "index-document-embedding")
    || input.inputItems !== identity.inputHashes.length
    || !["not-started", "succeeded", "failed", "indeterminate", "delivery-blocked"].includes(input.state)
    || typeof input.attemptsKnown !== "boolean" || !input.usage
    || (input.usage.status === "known" && input.usage.inputTokens === undefined && input.usage.totalTokens === undefined)
    || (input.httpStatus !== undefined && input.httpStatus > 599)) return invalid();
  const usage = input.usage.status === "unknown" ? { status: "unknown" as const }
    : input.usage.status === "known" ? { status: "known" as const,
      ...(input.usage.inputTokens === undefined ? {} : { inputTokens: integer(input.usage.inputTokens) }),
      ...(input.usage.totalTokens === undefined ? {} : { totalTokens: integer(input.usage.totalTokens) }) } : invalid();
  return { batchId: text(input.batchId), providerId: identity.providerId, modelId: identity.modelId,
    configurationId: identity.configurationId, purpose: input.purpose, inputItems: input.inputItems,
    inputBytes: integer(input.inputBytes), attempts: integer(input.attempts), attemptsKnown: input.attemptsKnown,
    state: input.state, usage, ...(input.httpStatus === undefined ? {} : { httpStatus: integer(input.httpStatus, 100) }) };
}

function resultOf(input: HarnessEmbedResult, entry: Entry): HarnessEmbedResult {
  const identity = entry.identity;
  const space = input?.space;
  if (!space || input.batchId !== entry.receipt.batchId || space.providerId !== identity.providerId
    || space.modelId !== identity.modelId || space.configurationId !== identity.configurationId
    || space.protocol !== identity.protocol || space.maxTokens !== identity.maxTokens
    || !Number.isSafeInteger(space.dim) || space.dim < 1
    || (identity.dimensions !== undefined && space.dim !== identity.dimensions)
    || !Array.isArray(input.items) || input.items.length !== identity.inputHashes.length) return invalid();
  const expectedSpace = createHash("sha256").update(JSON.stringify(remoteEmbeddingSpaceParts({
    protocol: space.protocol, providerId: space.providerId, modelId: space.modelId,
    configurationId: space.configurationId, maxTokens: space.maxTokens, dimensions: space.dim,
  }))).digest("hex").slice(0, 16);
  if (space.spaceId !== expectedSpace) return invalid();
  const ids = new Set<string>();
  const items = input.items.map((item, index) => {
    if (!item || item.index !== index || !Array.isArray(item.vector) || item.vector.length !== space.dim
      || item.vector.some(value => typeof value !== "number" || !Number.isFinite(value)) || ids.has(item.id)) return invalid();
    const id = text(item.id); ids.add(id);
    return { id, index, vector: [...item.vector] };
  });
  return { batchId: input.batchId, space: { providerId: identity.providerId, modelId: identity.modelId,
    protocol: identity.protocol, configurationId: identity.configurationId, maxTokens: space.maxTokens,
    dim: space.dim, spaceId: expectedSpace }, items };
}

const vectorBindingKey = (identity: SemanticInferenceLedgerIdentity): string => JSON.stringify([
  identity.providerId, identity.modelId, identity.protocol, identity.configurationId,
  identity.endpointHash, identity.dimensions ?? null, identity.maxTokens,
]);
const intentKey = (identity: SemanticInferenceLedgerIdentity): string => JSON.stringify([vectorBindingKey(identity), identity.inputHashes]);
const fact = (entry: Entry): SemanticInferenceFact => ({ key: entry.key, identity: entry.identity,
  receipt: entry.receipt, state: entry.state, hasResult: Boolean(entry.result),
  admissionNumber: entry.admissionNumber, noDispatchFinalized: entry.noDispatchFinalized,
  createdAt: entry.createdAt, updatedAt: entry.updatedAt });
const outcome = (entry: Entry): Exclude<SemanticInferenceAdmissionResult, { status: "admitted" }> => entry.result
  ? { status: "completed", result: entry.result, receipt: entry.receipt }
  : entry.state === "unknown" ? { status: "indeterminate", receipt: { ...entry.receipt, state: "indeterminate" } }
    : { status: "terminal", receipt: entry.receipt };
const retryableNoSend = (entry: Entry): boolean => entry.noDispatchFinalized && entry.state === "terminal"
  && entry.receipt.state === "not-started" && entry.receipt.attemptsKnown && entry.receipt.attempts === 0;

export function createSemanticInferenceLedgerEngine(options: SemanticInferenceLedgerOpenOptions) {
  if (!options || typeof options.dataDir !== "string" || !options.dataDir
    || typeof options.hostId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(options.hostId)) return invalid();
  // Deliberately a sibling of semantic/, not inside the removable derived cache.
  const directory = join(options.dataDir, "knowledge", options.hostId, "semantic-inference");
  mkdirSync(directory, { recursive: true });
  const native = new TriviumDB(join(directory, "ledger.tdb"), {
    dim: 1, syncMode: "full", loadTextIndex: false, autoBuildQuiver: false, payloadCacheMb: 0,
  });
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;
  let closed = false;
  const enqueue = <T>(operation: () => T): Promise<T> => {
    if (closed || closing) return Promise.reject(new Error("Semantic inference ledger is closed"));
    const work = () => { persistence.recover(); return operation(); };
    const result = tail.then(work, work); tail = result.then(() => undefined, () => undefined); return result;
  };
  const persistence = createStorePersistence({ walCommits: true, flush: () => native.flush(), close: () => native.close(),
    enqueue, onError: () => { /* Failed checkpoints remain retryable before the next operation. */ } });
  const db = trackStoreMutations(native, persistence);
  try { for (const name of ["type", "key", "token", "state"]) db.createIndex(name); }
  catch (error) {
    try { persistence.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Inference ledger initialization and close failed"); }
    throw error;
  }
  const decode = (payload: unknown): Entry => {
    const value = payload as Entry | null;
    if (!value || !["semantic-inference", "semantic-inference-attempt"].includes(value.type)
      || (value.state !== "unknown" && value.state !== "terminal") || typeof value.noDispatchFinalized !== "boolean") return invalid();
    const identity = identityOf(value.identity);
    const receipt = receiptOf(value.receipt, identity);
    if (identity.operation.hostId !== options.hostId || hash(value.key) !== semanticInferenceOperationKey(identity, receipt.purpose)
      || (value.state === "unknown") !== (receipt.state === "indeterminate")
      || !Number.isFinite(Date.parse(text(value.createdAt))) || !Number.isFinite(Date.parse(text(value.updatedAt)))) return invalid();
    const entry: Entry = { type: value.type, key: value.key, token: text(value.token), identity, receipt,
      state: value.state, hasResult: Boolean(value.result), admissionNumber: integer(value.admissionNumber, 1),
      noDispatchFinalized: value.noDispatchFinalized, createdAt: value.createdAt, updatedAt: value.updatedAt };
    if ((entry.noDispatchFinalized && !retryableNoSend(entry))
      || (entry.type === "semantic-inference-attempt" && (identity.operation.kind !== "index-build" || !retryableNoSend(entry)))) return invalid();
    if (value.result) {
      if (receipt.state !== "succeeded" || !receipt.attemptsKnown) return invalid();
      entry.result = resultOf(value.result, entry);
    } else if (receipt.state === "succeeded") return invalid();
    return entry;
  };
  const lookup = (query: { key: string } | { token: string }, type: Entry["type"] = "semantic-inference"): { id: number; entry: Entry } | null => {
    const ids = db.indexedLookup({ type, ...query }, Math.max(1, db.nodeCount()));
    if (ids.length > 1) throw new Error("Conflicting durable semantic inference operations");
    if (ids.length === 0) return null;
    const entry = decode(db.getPayload(ids[0]!));
    return { id: ids[0]!, entry };
  };
  return {
    admit(input: SemanticInferenceAdmission): Promise<SemanticInferenceAdmissionResult> {
      return enqueue(() => {
        const identity = identityOf(input?.identity);
        if (identity.operation.hostId !== options.hostId) return invalid();
        const receipt = receiptOf(input.receipt, identity);
        const key = hash(input.key);
        if (key !== semanticInferenceOperationKey(identity, receipt.purpose)
          || receipt.state !== "indeterminate" || receipt.attempts !== 0 || receipt.attemptsKnown) return invalid();
        const previous = lookup({ key });
        if (previous) {
          // Intent is immutable under one originating invocation, including
          // unknown outcomes. A changed credential scope alone is not a new
          // semantic intent; the inference caller must reauthorize it.
          if (intentKey(previous.entry.identity) !== intentKey(identity)
            || previous.entry.receipt.inputBytes !== receipt.inputBytes) {
            throw new Error("Semantic inference operation intent changed");
          }
          if (previous.entry.result && previous.entry.identity.credentialScopeHash !== identity.credentialScopeHash) {
            throw new Error("Semantic inference completed credential scope changed");
          }
          if (identity.operation.kind !== "index-build" || !retryableNoSend(previous.entry)) return outcome(previous.entry);
        }
        if (identity.operation.kind === "index-build") {
          const hashes = new Set(identity.inputHashes);
          const binding = vectorBindingKey(identity);
          // A restarted inventory can regroup model batches. Unresolved input
          // work remains fenced independently of the batch shape/order, rather
          // than allowing [A, B] to be replayed as [A] or [B, C]. Only unresolved
          // rows are scanned; settlement maintains this property index.
          for (const id of db.indexedLookup({ type: "semantic-inference", state: "unknown" }, Math.max(1, db.nodeCount()))) {
            const prior = decode(db.getPayload(id));
            const origin = prior.identity.operation;
            if (origin.kind !== "index-build" || origin.hostId !== identity.operation.hostId
              || origin.workspaceId !== identity.operation.workspaceId || origin.recipeId !== identity.operation.recipeId
              || vectorBindingKey(prior.identity) !== binding) continue;
            if (prior.identity.inputHashes.some(item => hashes.has(item))) return outcome(prior);
          }
        }
        const token = randomUUID();
        const now = new Date().toISOString();
        const entry: Entry = { type: "semantic-inference", key, token, identity, receipt,
          state: "unknown", hasResult: false, admissionNumber: (previous?.entry.admissionNumber ?? 0) + 1,
          noDispatchFinalized: false, createdAt: now, updatedAt: now };
        // Full-sync Trivium commits fsync their WAL before returning. The
        // shared persistence owner acknowledges only that durable transaction.
        db.commitTransaction([
          ...(previous ? [{ type: "delete" as const, id: previous.id },
            { type: "insert" as const, vector: [0], payload: { ...previous.entry, type: "semantic-inference-attempt" } }] : []),
          { type: "insert", vector: [0], payload: entry },
        ]);
        persistence.commit();
        return { status: "admitted", token };
      });
    },
    settle(token: string, settlement: SemanticInferenceSettlement): Promise<void> {
      return enqueue(() => {
        const current = lookup({ token: text(token) }) ?? lookup({ token }, "semantic-inference-attempt");
        if (!current) throw new Error("Semantic inference admission token is unavailable");
        const receipt = receiptOf(settlement?.receipt, current.entry.identity);
        if (receipt.batchId !== current.entry.receipt.batchId || receipt.inputBytes !== current.entry.receipt.inputBytes
          || (receipt.state === "succeeded" && (!receipt.attemptsKnown || !settlement.result))
          || (receipt.attemptsKnown && receipt.attempts === 0
            && (receipt.httpStatus !== undefined || receipt.usage.status !== "unknown"))
          || (settlement.noDispatchFinalized !== undefined && settlement.noDispatchFinalized !== true)
          || (settlement.noDispatchFinalized && (receipt.state !== "not-started" || !receipt.attemptsKnown || receipt.attempts !== 0))
          || (settlement.result && receipt.state !== "succeeded")) return invalid();
        const result = settlement.result ? resultOf(settlement.result, current.entry) : undefined;
        if (current.entry.state === "terminal") {
          if (JSON.stringify(current.entry.receipt) !== JSON.stringify(receipt)
            || JSON.stringify(current.entry.result) !== JSON.stringify(result)
            || current.entry.noDispatchFinalized !== Boolean(settlement.noDispatchFinalized)) {
            throw new Error("Semantic inference settlement is already terminal");
          }
          return;
        }
        const entry: Entry = { ...current.entry, receipt, state: receipt.state === "indeterminate" ? "unknown" : "terminal", hasResult: Boolean(result),
          noDispatchFinalized: Boolean(settlement.noDispatchFinalized),
          updatedAt: new Date().toISOString(), ...(result ? { result } : {}) };
        db.commitTransaction([{ type: "delete", id: current.id }, { type: "insert", vector: [0], payload: entry }]);
        persistence.commit();
      });
    },
    read(key: string) { return enqueue(() => { const current = lookup({ key: hash(key) }); return current ? outcome(current.entry) : null; }); },
    list(filter: SemanticInferenceFactFilter = {}): Promise<SemanticInferenceFact[]> {
      return enqueue(() => {
        if ((filter.runId !== undefined && !text(filter.runId)) || (filter.scopeId !== undefined && !text(filter.scopeId))
          || (filter.state !== undefined && filter.state !== "unknown" && filter.state !== "terminal")) return invalid();
        const entries: SemanticInferenceFact[] = [];
        const ids = ["semantic-inference", "semantic-inference-attempt"].flatMap(type => db.indexedLookup({ type }, Math.max(1, db.nodeCount())));
        for (const id of ids) {
          const entry = decode(db.getPayload(id));
          const operation = entry.identity.operation;
          if (filter.runId !== undefined && (operation.kind !== "native-query" || operation.runId !== filter.runId)) continue;
          if (filter.scopeId !== undefined && (operation.kind === "native-query" ? operation.threadId : operation.workspaceId) !== filter.scopeId) continue;
          if (filter.state !== undefined && entry.state !== filter.state) continue;
          entries.push(fact(entry));
        }
        return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.key.localeCompare(right.key) || left.admissionNumber - right.admissionNumber);
      });
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = tail.then(() => { persistence.close(); closed = true; })
        .catch(error => { closing = null; throw error; });
      return closing;
    },
  };
}
export type SemanticInferenceLedgerEngine = ReturnType<typeof createSemanticInferenceLedgerEngine>;
