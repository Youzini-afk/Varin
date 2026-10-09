import path from 'node:path';
import { languageIdForPath } from '@varin/protocol';
import { waitWithSignal } from '../cancellation.js';
import type {
  SpawnOptionsWithStdioTuple,
  StdioPipe,
} from 'node:child_process';
import { launchOwnedProcess, terminateOwnedProcess, type ManagedProcessOwner, type ManagedPipedProcessHandle } from "../process/types.js";
import { pathToFileURL } from 'node:url';
import { createJsonRpcClient } from './jsonrpc.js';
import {
  LanguageMappingError,
  mapCallHierarchyItem,
  mapCodeAction,
  mapColorPresentation,
  mapColorInformation,
  mapCompletionItem,
  mapDiagnostic,
  mapDocumentLink,
  mapDocumentHighlight,
  mapFoldingRange,
  mapHover,
  mapInlayHint,
  mapLocation,
  mapLocationLink,
  mapRange,
  mapSelectionRange,
  mapSignatureHelp,
  mapSymbols,
  mapTextEdits,
  mapWorkspaceEdit,
  resourceFromUri,
} from './mapping.js';
import type { LanguageResource } from './mapping.js';
import type { DocumentAuthority, DocumentMutationObservation } from '../documents/authority.js';

type JsonRpcClient = ReturnType<typeof createJsonRpcClient>;

interface CapabilityObject extends Record<string, unknown> {
  commands?: unknown;
  firstTriggerCharacter?: unknown;
  full?: unknown;
  legend?: { tokenModifiers?: unknown; tokenTypes?: unknown };
  moreTriggerCharacter?: unknown;
  range?: unknown;
  resolveProvider?: boolean;
  retriggerCharacters?: unknown;
  triggerCharacters?: unknown;
}

interface ServerCapabilities extends Record<string, unknown> {
  codeActionProvider?: CapabilityObject;
  completionProvider?: CapabilityObject;
  documentOnTypeFormattingProvider?: CapabilityObject;
  inlayHintProvider?: CapabilityObject;
  documentLinkProvider?: CapabilityObject;
  semanticTokensProvider?: CapabilityObject | true;
  signatureHelpProvider?: CapabilityObject;
}

interface LanguageOwner {
  entrypointId: string;
  extensionId: string;
  generation: number;
}

interface LanguageProvider {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  initializationOptions?: Record<string, unknown>;
  languageIds: string[];
  ownerKey: string;
  ownerScopeKey: string;
  providerId: string;
  source: 'builtin' | 'extension' | 'host' | 'workspace';
  workspaceId?: string;
}

interface OpenLanguageDocument {
  content: string;
  documentVersion: number;
  /**
   * Identity of the text this document was synchronized from: a Documents disk
   * revision or `surface-draft:<ref>:<n>`. Only Host-owned views set it; the
   * editor view's identity is its own `documentVersion` (D-087).
   */
  contentRevision?: string;
  usedAt?: number;
  readers?: number;
  fixed?: boolean;
}

type ResolveCollectionName =
  | 'codeActionResolveItems'
  | 'completionResolveItems'
  | 'documentLinkResolveItems'
  | 'inlayHintResolveItems';

interface LanguageSessionRecord extends ManagedProcessOwner<ManagedPipedProcessHandle> {
  activeRequests: number;
  documentEpoch: number;
  nextDocumentVersion: number;
  pendingTermination?: Promise<void>;
  callHierarchyItems: Map<string, unknown>;
  child: ManagedPipedProcessHandle | null;
  codeActionResolveItems: Map<string, unknown>;
  completionResolveItems: Map<string, unknown>;
  documentLinkResolveItems: Map<string, unknown>;
  documents: Map<string, OpenLanguageDocument>;
  failureReason: string | null;
  generation: number;
  inlayHintResolveItems: Map<string, unknown>;
  languageId: string;
  languageIds: string[];
  message: string;
  providerId: string;
  providerOwnerKey: string;
  resolveCounter: number;
  root: string;
  rpc: JsonRpcClient | null;
  serverCapabilities: ServerCapabilities;
  status: 'degraded' | 'failed' | 'ready' | 'starting';
  usedAt: number;
  view: LanguageViewId;
  workspaceId: string;
}

interface LanguageStatusSnapshot extends Record<string, unknown> {
  features?: Record<string, unknown>;
  generation?: number;
  languageId: string;
  message?: string;
  providerId?: string;
  status: string;
  view?: LanguageViewId;
  workspaceId: string;
}

interface LanguageRequest extends Record<string, unknown> {
  arguments?: unknown[];
  changes?: Array<{ from: number; insert: string; to: number }>;
  code?: unknown;
  color?: unknown;
  command?: string;
  content?: string;
  contentRevision?: string;
  diagnostics?: Array<Record<string, unknown>>;
  documentVersion?: number;
  expectedRevision?: string;
  expectedViewRevision?: number;
  formatting?: unknown;
  /** Token for a CallHierarchyItem held by the session (callHierarchy requests). */
  itemToken?: string;
  languageId?: string;
  newName?: string;
  position?: unknown;
  positions?: unknown[];
  providerId?: string;
  query?: string;
  range?: unknown;
  reason?: string;
  resolveToken?: string;
  resource?: LanguageResource;
  source?: string;
  fixed?: boolean;
  documentLanguageId?: string;
  warmOnly?: boolean;
  triggerCharacter?: string;
  triggerKind?: string;
  view?: LanguageViewId;
}

type FeatureMapper = (raw: unknown, record: LanguageSessionRecord) => unknown;

interface LanguageProviderDescriptor extends Record<string, unknown> {
  args?: unknown;
  command?: unknown;
  env?: unknown;
  initializationOptions?: unknown;
  languageIds?: unknown;
  providerId?: unknown;
  source?: unknown;
  workspaceId?: unknown;
}

interface LanguageSupervisorOptions {
  activateProviders?: (request: { languageId: string; workspaceId: string }) => Promise<void>;
  prepareProvider?: (providerId: string, root: string, signal: AbortSignal) => Promise<{ command: string; args: readonly string[]; initializationOptions?: Readonly<Record<string, unknown>> } | null>;
  documents: Pick<DocumentAuthority, 'getWorkspace' | 'watch' | 'readSnapshot'>;
  env?: NodeJS.ProcessEnv;
  isTrusted?: (root: string) => Promise<boolean>;
  pathModule?: typeof path;
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
  ) => ManagedPipedProcessHandle | Promise<ManagedPipedProcessHandle>;
  /** Host-owned views release their server after this much inactivity. */
  hostViewIdleMs?: number;
  /** Documents a Host-owned view keeps open before closing the least recently used. */
  hostViewDocumentLimit?: number;
  /** Initialize must settle even if a server leaves its handshake unanswered. */
  initializeTimeoutMs?: number;
  /** Query budget starts after startup, preserving the former Harness budget. */
  requestTimeoutMs?: number;
  now?: () => number;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const asCapabilities = (value: unknown): ServerCapabilities => {
  const record = asRecord(value);
  return record ? record as ServerCapabilities : {};
};

/**
 * One language server session cannot be both the editor's live buffer and an
 * agent turn's fixed text: the last writer decides the content while the
 * version number belongs to the editor. Views separate the two owners (D-087).
 */
export type LanguageViewId = 'agent' | 'surface' | `agent:${string}`;

export const SURFACE_LANGUAGE_VIEW: LanguageViewId = 'surface';
export const AGENT_LANGUAGE_VIEW: LanguageViewId = 'agent';

const asView = (value: unknown): LanguageViewId => (value === AGENT_LANGUAGE_VIEW || (typeof value === 'string' && value.startsWith('agent:')) ? value as LanguageViewId : SURFACE_LANGUAGE_VIEW);

/** Host-owned views assign their own document versions and own their lifecycle. */
const isHostOwnedView = (view: LanguageViewId): boolean => view !== SURFACE_LANGUAGE_VIEW;

const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'label',
  'comment', 'string', 'keyword', 'number', 'regexp', 'operator', 'decorator',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
  'modification', 'documentation', 'defaultLibrary',
];
const CODE_ACTION_KINDS = [
  '', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.move',
  'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll',
];

const capabilityValue = (record: LanguageSessionRecord, key: string) => record.serverCapabilities[key];

const supportsMethod = (record: LanguageSessionRecord, method: string, request: Record<string, unknown>): boolean => {
  const capability = record.serverCapabilities ?? {};
  if (method === 'workspace/executeCommand') {
    const commands = asRecord(capability.executeCommandProvider)?.commands;
    return typeof request.command === 'string' && Array.isArray(commands) && commands.includes(request.command);
  }
  if (method === 'completionItem/resolve') {
    return capability.completionProvider?.resolveProvider === true;
  }
  if (method === 'codeAction/resolve') {
    return capability.codeActionProvider?.resolveProvider === true;
  }
  if (method === 'inlayHint/resolve') {
    return capability.inlayHintProvider?.resolveProvider === true;
  }
  if (method === 'documentLink/resolve') {
    return capability.documentLinkProvider?.resolveProvider === true;
  }
  if (method === 'textDocument/semanticTokens/full') {
    const provider = capability.semanticTokensProvider;
    return provider === true || provider?.full === true || typeof provider?.full === 'object';
  }
  if (method === 'textDocument/semanticTokens/range') {
    const provider = capability.semanticTokensProvider;
    return provider === true || provider?.range === true || typeof provider?.range === 'object';
  }
  const key = ({
    'textDocument/completion': 'completionProvider',
    'textDocument/hover': 'hoverProvider',
    'textDocument/signatureHelp': 'signatureHelpProvider',
    'textDocument/definition': 'definitionProvider',
    'textDocument/references': 'referencesProvider',
    'textDocument/documentSymbol': 'documentSymbolProvider',
    'workspace/symbol': 'workspaceSymbolProvider',
    'textDocument/rename': 'renameProvider',
    'textDocument/codeAction': 'codeActionProvider',
    'textDocument/formatting': 'documentFormattingProvider',
    'textDocument/rangeFormatting': 'documentRangeFormattingProvider',
    'textDocument/onTypeFormatting': 'documentOnTypeFormattingProvider',
    'textDocument/inlayHint': 'inlayHintProvider',
    'textDocument/documentHighlight': 'documentHighlightProvider',
    'textDocument/diagnostic': 'diagnosticProvider',
    'textDocument/foldingRange': 'foldingRangeProvider',
    'textDocument/selectionRange': 'selectionRangeProvider',
    'textDocument/documentLink': 'documentLinkProvider',
    'textDocument/documentColor': 'colorProvider',
    'textDocument/colorPresentation': 'colorProvider',
    'textDocument/prepareCallHierarchy': 'callHierarchyProvider',
    'callHierarchy/incomingCalls': 'callHierarchyProvider',
    'callHierarchy/outgoingCalls': 'callHierarchyProvider',
  } as Record<string, string>)[method];
  if (!key) return true;
  const value = capabilityValue(record, key);
  return value === true || typeof value === 'object';
};

const ownerScopeKey = (owner?: LanguageOwner | null): string => owner
  ? `${owner.extensionId}\0${owner.entrypointId}`
  : 'varin.host';
const exactOwnerKey = (owner?: LanguageOwner | null): string => owner
  ? `${ownerScopeKey(owner)}\0${owner.generation}`
  : 'varin.host\0host';

const toFileUri = (absolutePath: string): string => pathToFileURL(absolutePath).href;

const offsetToPosition = (text: string, offset: number) => {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const prefix = text.slice(0, clamped);
  const lines = prefix.split('\n');
  return { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1]?.length ?? 0 };
};

const rangeFromOffsets = (text: string, from: number, to: number) => ({
  start: offsetToPosition(text, from),
  end: offsetToPosition(text, to),
});

const lspSeverity = (value: unknown): 'error' | 'hint' | 'info' | 'warning' => {
  if (value === 1) return 'error';
  if (value === 2) return 'warning';
  if (value === 4) return 'hint';
  return 'info';
};

export const createLanguageSupervisor = ({
  activateProviders = async () => {},
  prepareProvider,
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
  hostViewIdleMs = 300_000,
  hostViewDocumentLimit = 64,
  initializeTimeoutMs = 45_000,
  requestTimeoutMs = 30_000,
  now = () => Date.now(),
}: LanguageSupervisorOptions) => {
  const providers: LanguageProvider[] = [];
  const sessions = new Map<string, LanguageSessionRecord>();
  const desiredDocuments = new Map<string, Map<string, OpenLanguageDocument>>();
  const generations = new Map<string, number>();
  const workspaceListeners = new Map<string, Set<(event: unknown) => void>>();
  const nextGeneration = (key: string, existing?: LanguageSessionRecord | null): number => {
    const next = (existing?.generation ?? generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    return next;
  };

  const emit = (workspaceId: string, event: unknown): void => {
    const listeners = workspaceListeners.get(workspaceId);
    if (!listeners) return;
    const envelope = asRecord(event);
    const snapshot = asRecord(envelope?.snapshot);
    const languages = Array.isArray(snapshot?.languageIds) ? snapshot.languageIds : [];
    if (envelope?.kind === 'status' && snapshot && languages.length) {
      const { languageIds: _languages, ...value } = snapshot;
      for (const languageId of languages) for (const listener of listeners) listener({ ...envelope, snapshot: { ...value, languageId } });
    } else for (const listener of listeners) listener(event);
  };

  const findProvider = (workspaceId: string, languageId: string): LanguageProvider | null => (
    providers.filter((provider) => (
      provider.languageIds.includes(languageId)
      && (!provider.workspaceId || provider.workspaceId === workspaceId)
    )).sort((left, right) => Number(Boolean(right.workspaceId)) - Number(Boolean(left.workspaceId))
      || Number(left.source === 'builtin') - Number(right.source === 'builtin'))[0] ?? null
  );

  // A provider may serve several languages (for example TS, TSX and JS).
  // Those languages share one project process within the same code view.
  const sessionKey = (workspaceId: string, languageId: string, view: LanguageViewId): string => (
    `${workspaceId}\0${findProvider(workspaceId, languageId)?.providerId ?? languageId}\0${view}`
  );
  const activations = new Map<string, Promise<void>>();

  const inflight = new Map<string, { promise: Promise<LanguageSessionRecord | null>; controller: AbortController; users: number; workspaceId: string; view: LanguageViewId }>();
  const retainedWorkspaces = new Map<string, number>();
  const fileWatches = new Map<string, ReturnType<DocumentAuthority['watch']>>();
  let disposed = false;

  const snapshotFor = (record: LanguageSessionRecord | null | undefined): LanguageStatusSnapshot | null => {
    if (!record) return null;
    const snapshot: LanguageStatusSnapshot = {
      status: record.status,
      workspaceId: record.workspaceId,
      languageId: record.languageId,
      languageIds: record.languageIds,
    };
    snapshot.view = record.view;
    if (record.providerId) snapshot.providerId = record.providerId;
    if (typeof record.generation === 'number') snapshot.generation = record.generation;
    if (record.message) snapshot.message = record.message;
    if (record.status === 'ready' || record.status === 'degraded') {
      const completion = record.serverCapabilities?.completionProvider;
      const signature = record.serverCapabilities?.signatureHelpProvider;
      const onType = record.serverCapabilities?.documentOnTypeFormattingProvider;
      const features: Record<string, unknown> = {};
      if (Array.isArray(completion?.triggerCharacters)) {
        features.completionTriggerCharacters = completion.triggerCharacters.filter((value) => typeof value === 'string');
      }
      if (Array.isArray(signature?.triggerCharacters)) {
        features.signatureHelpTriggerCharacters = signature.triggerCharacters.filter((value) => typeof value === 'string');
      }
      if (Array.isArray(signature?.retriggerCharacters)) {
        features.signatureHelpRetriggerCharacters = signature.retriggerCharacters.filter((value) => typeof value === 'string');
      }
      const onTypeCharacters = [onType?.firstTriggerCharacter, ...(Array.isArray(onType?.moreTriggerCharacter) ? onType.moreTriggerCharacter : [])]
        .filter((value) => typeof value === 'string');
      if (onTypeCharacters.length > 0) features.onTypeFormattingTriggerCharacters = onTypeCharacters;
      if (Object.keys(features).length > 0) snapshot.features = features;
    }
    return snapshot;
  };

  const getStatus = (workspaceId: string, languageId: string, view: LanguageViewId = SURFACE_LANGUAGE_VIEW): LanguageStatusSnapshot => {
    const existing = sessions.get(sessionKey(workspaceId, languageId, view));
    if (existing) return { ...(snapshotFor(existing) ?? { status: 'absent', workspaceId, view }), languageId };
    return { status: 'absent', workspaceId, languageId, view };
  };


  const pendingExits = new Set<Promise<void>>();

  const clearRecordDiagnostics = (record: LanguageSessionRecord): void => {
    for (const [resourceId] of record.documents) {
      emit(record.workspaceId, {
        kind: 'diagnostics',
        workspaceId: record.workspaceId,
        languageId: languageIdForPath(resourceId) ?? record.languageId,
        view: record.view,
        resourceId,
        providerId: record.providerId,
        generation: record.generation,
        items: [],
      });
    }
  };

  const disposeRecord = (record: LanguageSessionRecord | null | undefined, reason = 'Language server stopped'): Promise<void> => {
    if (!record) return Promise.resolve();
    if (record.pendingTermination) return record.pendingTermination;
    clearRecordDiagnostics(record);
    record.status = 'degraded'; record.message = reason + '; waiting for process exit';
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    record.rpc?.rejectAll(new Error(reason));
    record.rpc?.dispose();
    record.rpc = null;
    const exited = terminateOwnedProcess(record).then(() => {
      emit(record.workspaceId, { kind: 'status', snapshot: {
        status: 'absent', workspaceId: record.workspaceId, languageId: record.languageId,
        languageIds: record.languageIds,
        view: record.view, providerId: record.providerId, generation: record.generation,
      } });
    }).finally(() => {
      delete record.pendingTermination; pendingExits.delete(exited);
      if (![...sessions.values()].some(other => other.workspaceId === record.workspaceId && other !== record && other.rpc)) {
        fileWatches.get(record.workspaceId)?.close();
        fileWatches.delete(record.workspaceId);
      }
    });
    void exited.catch((error: unknown) => setFailed(record, error instanceof Error ? error.message : String(error)));
    record.pendingTermination = exited;
    pendingExits.add(exited);
    record.documents.clear();
    record.callHierarchyItems?.clear();
    record.completionResolveItems?.clear();
    record.codeActionResolveItems?.clear();
    record.inlayHintResolveItems?.clear();
    record.documentLinkResolveItems?.clear();
    return exited;
  };

  const retireRecord = (key: string, record: LanguageSessionRecord, reason: string): void => {
    void disposeRecord(record, reason).then(() => {
      if (sessions.get(key) === record) sessions.delete(key);
    }).catch(() => undefined); // disposeRecord publishes the retained failure.
  };

  const setFailed = (record: LanguageSessionRecord, message: string): void => {
    record.status = 'failed';
    record.message = message;
    record.failureReason = record.failureReason ?? 'provider-failed';
    clearRecordDiagnostics(record);
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
  };

  const createRecord = (input: {
    workspaceId: string;
    languageId: string;
    view: LanguageViewId;
    providerId: string;
    providerOwnerKey: string;
    generation: number;
    status: LanguageSessionRecord['status'];
    message: string;
    failureReason: string | null;
    root: string;
  }): LanguageSessionRecord => ({
    workspaceId: input.workspaceId,
    languageId: input.languageId,
    languageIds: [...(providers.find(provider => provider.providerId === input.providerId)?.languageIds ?? [input.languageId])],
    view: input.view,
    providerId: input.providerId,
    providerOwnerKey: input.providerOwnerKey,
    generation: input.generation,
    status: input.status,
    message: input.message,
    failureReason: input.failureReason,
    documents: new Map<string, OpenLanguageDocument>(),
    activeRequests: 0,
    documentEpoch: 0,
    nextDocumentVersion: 0,
    child: null,
    rpc: null,
    root: input.root,
    serverCapabilities: {},
    callHierarchyItems: new Map<string, unknown>(),
    completionResolveItems: new Map<string, unknown>(),
    codeActionResolveItems: new Map<string, unknown>(),
    inlayHintResolveItems: new Map<string, unknown>(),
    documentLinkResolveItems: new Map<string, unknown>(),
    resolveCounter: 0,
    usedAt: now(),
  });

  const ensureSession = async (
    workspaceId: string,
    languageId: string,
    view: LanguageViewId,
    signal?: AbortSignal,
  ): Promise<LanguageSessionRecord | null> => {
    signal?.throwIfAborted();
    let provider = findProvider(workspaceId, languageId);
    if (!provider || provider.source === 'builtin') {
      const activationKey = `${workspaceId}\0${languageId}`;
      let activation = activations.get(activationKey);
      if (!activation) {
        activation = activateProviders({ workspaceId, languageId });
        activations.set(activationKey, activation);
        const owned = activation;
        void owned.finally(() => { if (activations.get(activationKey) === owned) activations.delete(activationKey); }).catch(() => undefined);
      }
      try {
        await waitWithSignal(activation, signal);
      } catch (error) {
        signal?.throwIfAborted();
        const key = sessionKey(workspaceId, languageId, view);
        const existing = sessions.get(key);
        const failed = createRecord({
          workspaceId, languageId, view,
          providerId: provider?.providerId ?? 'varin.workspace-match',
          providerOwnerKey: provider?.ownerKey ?? 'varin.host\0activation',
          generation: existing?.generation ?? nextGeneration(key),
          status: 'failed',
          message: error instanceof Error ? error.message : 'Language extension activation failed',
          failureReason: 'provider-failed', root: '',
        });
        if (!existing?.rpc) {
          sessions.set(key, failed);
          emit(workspaceId, { kind: 'status', snapshot: snapshotFor(failed) });
        }
        return failed;
      }
      provider = findProvider(workspaceId, languageId);
    }
    signal?.throwIfAborted();
    if (!provider || disposed) return null;
    const key = sessionKey(workspaceId, languageId, view);
    let pending = inflight.get(key);
    while (pending?.controller.signal.aborted) {
      await waitWithSignal(pending.promise.catch(() => undefined), signal);
      pending = inflight.get(key);
    }
    if (!pending) {
      const controller = new AbortController();
      pending = { controller, workspaceId, view, users: 0, promise: resolveSession(workspaceId, languageId, view, controller) };
      inflight.set(key, pending);
      const owned = pending;
      void owned.promise.finally(() => { if (inflight.get(key) === owned) inflight.delete(key); }).catch(() => undefined);
    }
    pending.users += 1;
    try {
      return await waitWithSignal(pending.promise, signal);
    } finally {
      pending.users -= 1;
      if (pending.users === 0 && signal?.aborted && inflight.get(key) === pending) pending.controller.abort();
    }
  };

  const resolveSession = async (workspaceId: string, languageId: string, view: LanguageViewId, controller: AbortController): Promise<LanguageSessionRecord | null> => {
    if (disposed) return null;
    const key = sessionKey(workspaceId, languageId, view);
    const existing = sessions.get(key);
    if (existing?.pendingTermination) await existing.pendingTermination;
    controller.signal.throwIfAborted();
    if (existing?.rpc && (existing.status === 'ready' || existing.status === 'degraded')) {
      existing.usedAt = now();
      return existing;
    }
    const provider = findProvider(workspaceId, languageId);
    if (!provider || disposed) return null;
    if (existing) await disposeRecord(existing);
    controller.signal.throwIfAborted();
    return startSession(workspaceId, languageId, view, provider, controller, existing);
  };

  const startSession = async (
    workspaceId: string,
    languageId: string,
    view: LanguageViewId,
    provider: LanguageProvider,
    controller: AbortController,
    existing?: LanguageSessionRecord | null,
  ): Promise<LanguageSessionRecord> => {
    const key = sessionKey(workspaceId, languageId, view);

    let workspace;
    try {
      workspace = await documents.getWorkspace(workspaceId, controller.signal);
    } catch (error) {
      controller.signal.throwIfAborted();
      const failed = createRecord({
        workspaceId,
        languageId,
        view,
        providerId: provider.providerId,
        providerOwnerKey: provider.ownerKey,
        generation: nextGeneration(key, existing),
        status: 'failed',
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
        failureReason: 'provider-failed',
        root: '',
      });
      sessions.set(key, failed);
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(failed) });
      return failed;
    }

    if (provider.source === 'workspace' && !await isTrusted(workspace.root)) {
      const failed = createRecord({
        workspaceId,
        languageId,
        view,
        providerId: provider.providerId,
        providerOwnerKey: provider.ownerKey,
        generation: nextGeneration(key, existing),
        status: 'failed',
        message: 'Untrusted workspace cannot execute project-provided language server commands',
        failureReason: 'untrusted',
        root: workspace.root,
      });
      sessions.set(key, failed);
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(failed) });
      return failed;
    }

    const record = createRecord({
      workspaceId,
      languageId,
      view,
      providerId: provider.providerId,
      providerOwnerKey: provider.ownerKey,
      generation: nextGeneration(key, existing),
      status: 'starting',
      message: '',
      failureReason: null,
      root: workspace.root,
    });
    sessions.set(key, record);
    record.launchController = controller;
    emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });

    let child: ManagedPipedProcessHandle;
    let initializationOptions = provider.initializationOptions;
    try {
      child = await launchOwnedProcess(record, async (signal) => {
        const prepared = await prepareProvider?.(provider.providerId, workspace.root, signal);
        if (prepared?.initializationOptions) initializationOptions = { ...prepared.initializationOptions, ...initializationOptions };
        signal.throwIfAborted();
        return spawn(prepared?.command ?? provider.command, prepared?.args ?? provider.args, {
        cwd: workspace.root,
        env: {
          ...env,
          ...provider.env,
          // Electron and VS Code expose their executable as process.execPath.
          // Language providers are always headless CLI processes; without Node
          // mode a provider using process.execPath launches another GUI shell.
          ELECTRON_RUN_AS_NODE: '1',
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
        });
      });
    } catch (error) {
      await disposeRecord(record, 'Language startup failed').catch(() => undefined);
      setFailed(record, error instanceof Error ? error.message : 'Failed to start language server');
      return record;
    }
    record.child = child;
    const rpc = createJsonRpcClient({
      input: child.stdout,
      output: child.stdin,
      onRequest: (method, params) => {
        if (method === 'workspace/configuration') {
          const items = asRecord(params)?.items;
          // No synthetic configuration overrides: servers use their own defaults
          // and read the project's native configuration (pyrightconfig, tsconfig…).
          return Array.isArray(items) ? items.map(() => null) : [];
        }
        if (method === 'workspace/workspaceFolders') return [{ uri: toFileUri(record.root), name: pathModule.basename(record.root) }];
        if (method === 'window/workDoneProgress/create' || method === 'window/showMessageRequest') return null;
        if (method === 'workspace/applyEdit') return { applied: false, failureReason: 'Edits must be requested through Documents.' };
        throw new Error(`Unsupported language client method: ${method}`);
      },
    });
    record.rpc = rpc;
    rpc.onNotification((method, params) => {
      if (sessions.get(key) !== record || record.rpc !== rpc) return;
      if (method !== 'textDocument/publishDiagnostics') return;
      const notification = asRecord(params) ?? {};
      const uri = typeof notification.uri === 'string' ? notification.uri : '';
      const resource = resourceFromUri(uri, workspaceId, record.root, pathModule);
      if (!resource) return;
      const resourceId = resource.resourceId;
      const open = record.documents.get(resourceId);
      const documentVersion = typeof notification.version === 'number' && Number.isFinite(notification.version)
        ? notification.version
        : undefined;
      if (open && Number.isFinite(documentVersion) && documentVersion !== open.documentVersion) return;
      const items = Array.isArray(notification.diagnostics) ? notification.diagnostics.map((diagnostic) => mapDiagnostic(diagnostic, {
        workspaceId,
        root: record.root,
        pathModule,
        resource,
        documentVersion: typeof documentVersion === 'number' && Number.isFinite(documentVersion) ? documentVersion : null,
        severity: lspSeverity,
        providerId: record.providerId,
        generation: record.generation,
      })) : [];
      emit(workspaceId, {
        kind: 'diagnostics',
        workspaceId,
        languageId: languageIdForPath(resourceId) ?? languageId,
        view: record.view,
        resourceId,
        ...(open?.contentRevision && documentVersion === open.documentVersion ? { contentRevision: open.contentRevision } : {}),
        providerId: record.providerId,
        generation: record.generation,
        items,
      });
    });
    child.stderr.on('data', () => {
      // stderr may contain paths; never log language-server payloads.
    });
    child.on("error", (error: Error) => {
      if (record.child !== child) return;
      rpc.rejectAll(error); setFailed(record, error.message);
    });
    child.on('exit', (code) => {
      if (record.child !== child) return;
      rpc.rejectAll(new Error('Language server exited'));
      if (record.status === 'starting' || record.status === 'ready' || record.status === 'degraded') {
        setFailed(record, `Language server exited${code === null ? '' : ` with code ${code}`}`);
      }
      record.child = null;
      record.rpc = null;
    });

    try {
      if (!fileWatches.has(workspaceId)) {
        fileWatches.set(workspaceId, documents.watch(workspaceId, event => {
          if (event.resource) observeDocumentMutation({ ...event.resource, kind: event.kind === 'deleted' ? 'deleted' : event.kind === 'created' ? 'created' : 'modified' });
          else if (event.kind === 'reset') {
            const resources = new Set<string>();
            for (const current of sessions.values()) {
              if (current.workspaceId === workspaceId) for (const resourceId of current.documents.keys()) resources.add(resourceId);
            }
            for (const resourceId of resources) observeDocumentMutation({ workspaceId, resourceId, kind: 'modified' });
          }
        }));
      }
      const initializeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(initializeTimeoutMs)]);
      const initialized = asRecord(await rpc.request('initialize', {
        processId: null,
        rootUri: toFileUri(workspace.root),
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                deprecatedSupport: true,
                preselectSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                insertReplaceSupport: true,
                resolveSupport: {
                  properties: ['documentation', 'detail', 'additionalTextEdits', 'command'],
                },
                tagSupport: { valueSet: [1] },
              },
              contextSupport: true,
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
              contextSupport: true,
            },
            definition: {},
            references: {},
            rename: {},
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: CODE_ACTION_KINDS },
              },
              dataSupport: true,
              disabledSupport: true,
              isPreferredSupport: true,
              resolveSupport: { properties: ['edit', 'command'] },
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true, tagSupport: { valueSet: [1] } },
            formatting: {},
            rangeFormatting: {},
            onTypeFormatting: {},
            semanticTokens: {
              requests: { range: true, full: true },
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: true,
            },
            inlayHint: { dynamicRegistration: false, resolveSupport: { properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'] } },
            documentHighlight: {},
            foldingRange: { lineFoldingOnly: false },
            selectionRange: {},
            documentLink: { tooltipSupport: true },
            colorProvider: {},
            publishDiagnostics: { versionSupport: true, relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            symbol: { resolveSupport: { properties: ['location.range'] }, tagSupport: { valueSet: [1] } },
            workspaceEdit: { documentChanges: true, changeAnnotationSupport: { groupsOnLabel: true } },
            executeCommand: { dynamicRegistration: false },
          },
        },
        workspaceFolders: [{ uri: toFileUri(workspace.root), name: pathModule.basename(workspace.root) }],
        ...(initializationOptions ? { initializationOptions } : {}),
      }, initializeSignal));
      record.serverCapabilities = asCapabilities(initialized?.capabilities);
      rpc.notify('initialized', {});
      if (sessions.get(key) !== record || !providers.includes(provider)) {
        disposeRecord(record, 'Language provider changed during startup');
        if (sessions.get(key) === record) sessions.delete(key);
        return record;
      }
      // The editor owns its buffers, so a replacement server must be handed the
      // current ones. A Host-owned view instead re-synchronizes the documents a
      // caller actually asks for, so a restart never replays every file the
      // agent ever touched (D-087).
      const desired = isHostOwnedView(view) ? null : desiredDocuments.get(key);
      if (desired) {
        for (const [resourceId, document] of desired) {
          const uri = toFileUri(pathModule.resolve(record.root, resourceId));
          record.documents.set(resourceId, { ...document });
          rpc.notify('textDocument/didOpen', {
            textDocument: {
              uri,
              languageId: languageIdForPath(resourceId) ?? languageId,
              version: document.documentVersion,
              text: document.content,
            },
          });
        }
      }
      record.status = 'ready';
      record.message = '';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      if (isHostOwnedView(view) || retainedWorkspaces.has(workspaceId)) ensureIdleReaper();
    } catch (error) {
      await disposeRecord(record, 'Language initialization failed').catch(() => undefined);
      setFailed(record, error instanceof Error ? error.message : 'Language server initialize failed');
    }
    return record;
  };

  /**
   * A Host-owned view opens whatever a caller asks about, so without a bound it
   * would grow for the life of the workspace. The least recently used documents
   * are closed instead of accumulating (D-087).
   */
  const closeExcessHostDocuments = (
    record: LanguageSessionRecord,
    desired: Map<string, OpenLanguageDocument>,
    keepResourceId: string,
  ): void => {
    while (record.documents.size > hostViewDocumentLimit) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidateId, document] of record.documents) {
        if (candidateId === keepResourceId || document.readers || document.fixed) continue;
        const usedAt = document.usedAt ?? 0;
        if (usedAt < oldestAt) {
          oldestAt = usedAt;
          oldestId = candidateId;
        }
      }
      if (!oldestId) return;
      record.documents.delete(oldestId);
      desired.delete(oldestId);
      try {
        record.rpc?.notify('textDocument/didClose', {
          textDocument: { uri: toFileUri(pathModule.resolve(record.root, oldestId)) },
        });
      } catch {
        // A closing server cannot block eviction.
      }
    }
  };

  let idleTimer: ReturnType<typeof setInterval> | null = null;

  const releaseIdleHostViews = async (): Promise<void> => {
    const deadline = now() - hostViewIdleMs;
    for (const [key, record] of [...sessions]) {
      const idleEligible = isHostOwnedView(record.view) || !desiredDocuments.get(key)?.size;
      if (!idleEligible || record.usedAt > deadline || record.activeRequests > 0
        || ((record.view === AGENT_LANGUAGE_VIEW || record.view === SURFACE_LANGUAGE_VIEW) && retainedWorkspaces.has(record.workspaceId))
        || inflight.has(key)) continue;
      await disposeRecord(record, 'Host language view released after idle');
      if (sessions.get(key) === record) sessions.delete(key);
      inflight.delete(key);
      desiredDocuments.delete(key);
    }
    if (idleTimer && ![...sessions].some(([key, record]) => isHostOwnedView(record.view) || !desiredDocuments.get(key)?.size)) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  };

  const ensureIdleReaper = (): void => {
    if (idleTimer || hostViewIdleMs <= 0) return;
    idleTimer = setInterval(() => { void releaseIdleHostViews().catch(() => undefined); }, Math.max(1000, Math.floor(hostViewIdleMs / 4)));
    idleTimer.unref?.();
  };

  const syncDocument = async (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted();
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const resourceId = request.resource?.resourceId;
    const view = asView(request.view);
    if (!workspaceId || !resourceId || !languageId) {
      return { status: 'failed', message: 'Document identity is required' };
    }
    const requestedVersion = typeof request.documentVersion === 'number' && Number.isFinite(request.documentVersion)
      ? request.documentVersion
      : 0;
    let key = sessionKey(workspaceId, languageId, view);
    // Await startup before selecting the previous document and assigning its
    // next version. The update below is synchronous through the notification.
    const record = request.reason === 'close' || request.warmOnly
      ? sessions.get(key)
      : await ensureSession(workspaceId, languageId, view, options.signal);
    options.signal?.throwIfAborted();
    if (request.warmOnly && (!record?.rpc || (record.status !== 'ready' && record.status !== 'degraded'))) {
      return { status: 'absent', message: 'Language server is not already running for this view.' };
    }
    if (!record) return { status: 'absent' };
    key = sessionKey(workspaceId, languageId, view);
    if (record.status === 'failed' || !record.rpc) return { status: 'failed', message: record.message || 'Language server is unavailable' };
    const absolutePath = pathModule.resolve(record.root, resourceId);
    const relativePath = pathModule.relative(record.root, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || pathModule.isAbsolute(relativePath)) return { status: 'failed', message: 'Path is outside workspace' };
    const hostOwned = isHostOwnedView(view);
    const desired = desiredDocuments.get(key) ?? new Map<string, OpenLanguageDocument>();
    desiredDocuments.set(key, desired);
    const previousDesired = desired.get(resourceId);
    if (request.reason === 'close') {
      desired.delete(resourceId);
      if (desired.size === 0) desiredDocuments.delete(key);
      const open = record?.documents.get(resourceId);
      const releaseEmptyRecord = async (): Promise<void> => {
        // Only the editor view disappears with its last tab. A Host-owned view
        // stays until it goes idle so closing one document cannot cancel work in
        // the other view (D-087).
        if (!record || hostOwned || desired.size > 0 || retainedWorkspaces.has(workspaceId)) return;
        await disposeRecord(record, 'Last language document closed');
        if (sessions.get(key) === record) sessions.delete(key);
        inflight.delete(key);
      };
      if (!record || !record.rpc || !open) {
        await releaseEmptyRecord();
        return { status: 'absent' };
      }
      record.documents.delete(resourceId);
      if (!hostOwned || open.fixed) record.documentEpoch += 1;
      record.rpc.notify('textDocument/didClose', { textDocument: { uri: toFileUri(absolutePath) } });
      const result = {
        status: 'synced',
        documentVersion: open.documentVersion,
        viewRevision: record.documentEpoch,
        providerId: record.providerId,
        generation: record.generation,
      };
      await releaseEmptyRecord();
      return result;
    }
    if (!hostOwned && previousDesired && requestedVersion < previousDesired.documentVersion) {
      return { status: 'stale', documentVersion: previousDesired.documentVersion };
    }
    const incrementalChanges = Array.isArray(request.changes)
      ? [...request.changes].sort((left, right) => right.from - left.from || right.to - left.to)
      : [];
    const nextContent = request.content
      ?? (incrementalChanges.length > 0 && previousDesired?.content !== undefined
        ? incrementalChanges.reduce(
            (text, change) => `${text.slice(0, change.from)}${change.insert}${text.slice(change.to)}`,
            previousDesired.content,
          )
        : previousDesired?.content ?? '');
    // The editor owns its own version sequence; a Host-owned view assigns its
    // own so the two writers never share one namespace.
    const documentVersion = hostOwned
      ? record.nextDocumentVersion + 1
      : requestedVersion;
    const contentRevision = typeof request.contentRevision === 'string' ? request.contentRevision : undefined;
    const nextDesired: OpenLanguageDocument = {
      documentVersion,
      content: nextContent,
      ...(contentRevision ? { contentRevision } : {}),
      ...(request.fixed ? { fixed: true } : {}),
      usedAt: now(),
    };
    const uri = toFileUri(absolutePath);
    const open = record.documents.get(resourceId);
    if (hostOwned && open && open.contentRevision === contentRevision && open.content === nextContent) {
      // Already bound to this exact text: no notification, no version bump.
      open.usedAt = now();
      record.usedAt = now();
      desired.set(resourceId, open);
      return {
        status: 'synced',
        documentVersion: open.documentVersion,
        viewRevision: record.documentEpoch,
        ...(open.contentRevision ? { contentRevision: open.contentRevision } : {}),
        providerId: record.providerId,
        generation: record.generation,
      };
    }
    if (!hostOwned && open && documentVersion < open.documentVersion) {
      return { status: 'stale', documentVersion: open.documentVersion };
    }
    desired.set(resourceId, nextDesired);
    if (hostOwned) record.nextDocumentVersion = documentVersion;
    // Opening or evicting a disk-backed buffer does not change the code view.
    // Content changes and fixed overlays can affect another file's query.
    if (!hostOwned || request.fixed || (open && open.content !== nextContent)) record.documentEpoch += 1;
    record.usedAt = now();
    if (!open) {
      record.documents.set(resourceId, nextDesired);
      record.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: request.documentLanguageId ?? languageId, version: documentVersion, text: nextContent },
      });
    } else if (open.documentVersion !== documentVersion || open.content !== nextContent) {
      const canUseIncremental = request.reason === 'change'
        && incrementalChanges.length > 0
        && previousDesired?.content === open.content;
      const contentChanges = canUseIncremental
        ? incrementalChanges.map((change) => ({
            range: rangeFromOffsets(open.content, change.from, change.to),
            text: change.insert,
          }))
        : [{ text: nextContent }];
      record.documents.set(resourceId, nextDesired);
      record.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: documentVersion },
        contentChanges,
      });
    }
    if (request.reason === 'save') {
      record.rpc.notify('textDocument/didSave', { textDocument: { uri } });
    }
    if (hostOwned) {
      closeExcessHostDocuments(record, desired, resourceId);
      ensureIdleReaper();
    }
    return {
      status: 'synced',
      documentVersion,
      viewRevision: record.documentEpoch,
      ...(contentRevision ? { contentRevision } : {}),
      providerId: record.providerId,
      generation: record.generation,
    };
  };

  const completionTriggerKind = (value: unknown): number => {
    if (value === 'triggerCharacter') return 2;
    if (value === 'incomplete') return 3;
    return 1;
  };

  const featureParams = (method: string, request: LanguageRequest, uri?: string) => {
    if (method === 'workspace/symbol') return { query: request.query ?? '' };
    if (method === 'textDocument/completion') {
      return {
        textDocument: { uri },
        position: request.position,
        context: {
          triggerKind: completionTriggerKind(request.triggerKind),
          ...(typeof request.triggerCharacter === 'string' ? { triggerCharacter: request.triggerCharacter } : {}),
        },
      };
    }
    if (method === 'textDocument/signatureHelp') {
      return {
        textDocument: { uri },
        position: request.position,
        context: {
          triggerKind: completionTriggerKind(request.triggerKind),
          isRetrigger: request.triggerKind === 'incomplete',
          ...(typeof request.triggerCharacter === 'string' ? { triggerCharacter: request.triggerCharacter } : {}),
        },
      };
    }
    if (method === 'textDocument/references') {
      return { textDocument: { uri }, position: request.position, context: { includeDeclaration: true } };
    }
    if (method === 'textDocument/prepareCallHierarchy') {
      return { textDocument: { uri }, position: request.position };
    }
    if (method === 'textDocument/codeAction') {
      return {
        textDocument: { uri },
        range: request.range,
        context: {
          diagnostics: Array.isArray(request.diagnostics) ? request.diagnostics.map((diagnostic) => ({
            range: diagnostic.range,
            message: diagnostic.message,
            ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
            ...(diagnostic.source ? { source: diagnostic.source } : {}),
          })) : [],
        },
      };
    }
    if (method === 'textDocument/formatting') {
      return { textDocument: { uri }, options: request.formatting ?? { tabSize: 2, insertSpaces: true } };
    }
    if (method === 'textDocument/rangeFormatting') {
      return { textDocument: { uri }, range: request.range, options: request.formatting ?? { tabSize: 2, insertSpaces: true } };
    }
    if (method === 'textDocument/onTypeFormatting') {
      return {
        textDocument: { uri },
        position: request.position,
        ch: request.triggerCharacter ?? '',
        options: request.formatting ?? { tabSize: 2, insertSpaces: true },
      };
    }
    if (method === 'textDocument/semanticTokens/full') return { textDocument: { uri } };
    if (method === 'textDocument/semanticTokens/range') return { textDocument: { uri }, range: request.range };
    if (method === 'textDocument/inlayHint') return { textDocument: { uri }, range: request.range };
    if (method === 'textDocument/selectionRange') return { textDocument: { uri }, positions: request.positions ?? [] };
    if (method === 'textDocument/colorPresentation') {
      return { textDocument: { uri }, color: request.color, range: request.range };
    }
    if (method === 'workspace/executeCommand') {
      return {
        command: request.command,
        ...(Array.isArray(request.arguments) ? { arguments: request.arguments } : {}),
      };
    }
    return {
      ...(uri ? { textDocument: { uri } } : {}),
      ...(request.position ? { position: request.position } : {}),
      ...(request.range ? { range: request.range } : {}),
      ...(request.newName ? { newName: request.newName } : {}),
    };
  };

  const featureFailure = (record: LanguageSessionRecord | null | undefined, message: string, reason = 'request-failed') => ({
    status: 'failed',
    message,
    reason,
    ...(record?.providerId ? { providerId: record.providerId } : {}),
    ...(typeof record?.generation === 'number' && Number.isFinite(record.generation) ? { generation: record.generation } : {}),
  });

  const requestFeature = async (
    method: string,
    request: LanguageRequest,
    mapResult: FeatureMapper,
    options: { params?: unknown; signal?: AbortSignal } = {},
  ) => {
    options.signal?.throwIfAborted();
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const resourceId = request.resource?.resourceId;
    const view = asView(request.view);
    if (!workspaceId || !languageId) return { status: 'absent', ...(workspaceId ? { workspaceId } : {}), ...(languageId ? { languageId } : {}) };
    const record = request.warmOnly ? sessions.get(sessionKey(workspaceId, languageId, view))
      : await ensureSession(workspaceId, languageId, view, options.signal);
    options.signal?.throwIfAborted();
    if (!record) return { status: 'absent', workspaceId, languageId };
    if (request.warmOnly && record.status !== 'ready' && record.status !== 'degraded') return { status: 'absent', workspaceId, languageId };
    if (!findProvider(workspaceId, languageId) && record.status !== 'failed') {
      return { status: 'absent', workspaceId, languageId };
    }
    if (!record || record.status === 'failed' || !record.rpc) {
      return featureFailure(record, record?.message || 'Language server is unavailable', record?.failureReason ?? 'provider-failed');
    }
    const open = resourceId ? record.documents.get(resourceId) : null;
    const staleResult = (reason: 'generation' | 'revision' | 'version') => ({
      status: 'stale',
      documentVersion: open?.documentVersion ?? request.documentVersion ?? 0,
      ...(open?.contentRevision ? { contentRevision: open.contentRevision } : {}),
      reason,
      providerId: record.providerId,
      generation: record.generation,
    });
    if (
      (typeof request.providerId === 'string' && request.providerId !== record.providerId)
      || (Number.isFinite(request.generation) && request.generation !== record.generation)
    ) {
      return staleResult('generation');
    }
    if (!supportsMethod(record, method, request)) {
      return featureFailure(record, `Language provider does not support ${method}`, 'unsupported');
    }
    // A Host-owned view asserts the text identity it resolved; the editor view
    // keeps asserting its own document version (D-087).
    if (typeof request.expectedRevision === 'string' && open?.contentRevision !== request.expectedRevision) {
      return staleResult('revision');
    }
    if (request.expectedViewRevision !== undefined && request.expectedViewRevision !== record.documentEpoch) return staleResult('revision');
    if (open && Number.isFinite(request.documentVersion) && request.documentVersion !== open.documentVersion) {
      return staleResult('version');
    }
    record.usedAt = now();
    if (open) open.usedAt = now();
    let uri;
    if (resourceId) {
      const resolved = pathModule.resolve(record.root, resourceId);
      const relative = pathModule.relative(record.root, resolved);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
        return featureFailure(record, 'Path is outside workspace', 'unsupported');
      }
      uri = toFileUri(resolved);
    }
    const params = options.params ?? featureParams(method, request, uri);
    record.activeRequests += 1;
    if (open) open.readers = (open.readers ?? 0) + 1;
    try {
      const queryDeadline = AbortSignal.timeout(requestTimeoutMs);
      const raw = await record.rpc.request(method, params, options.signal ? AbortSignal.any([options.signal, queryDeadline]) : queryDeadline);
      if (sessions.get(sessionKey(workspaceId, languageId, view)) !== record) {
        return staleResult('generation');
      }
      const current = resourceId ? record.documents.get(resourceId) : null;
      if (request.expectedViewRevision !== undefined && request.expectedViewRevision !== record.documentEpoch) return staleResult('revision');
      if (typeof request.expectedRevision === 'string' && current?.contentRevision !== request.expectedRevision) {
        return {
          status: 'stale',
          documentVersion: current?.documentVersion ?? 0,
          ...(current?.contentRevision ? { contentRevision: current.contentRevision } : {}),
          reason: 'revision',
          providerId: record.providerId,
          generation: record.generation,
        };
      }
      if (request.documentVersion !== undefined && request.documentVersion !== current?.documentVersion) {
        return staleResult('version');
      }
      return {
        status: 'ready',
        documentVersion: request.documentVersion ?? open?.documentVersion ?? 0,
        ...(open?.contentRevision ? { contentRevision: open.contentRevision } : {}),
        providerId: record.providerId,
        generation: record.generation,
        value: mapResult(raw, record),
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'TimeoutError') return featureFailure(record, 'Language request timed out', 'timeout');
      if (error instanceof LanguageMappingError) {
        return featureFailure(record, error.message, error.reason);
      }
      if (record.rpc && (record.status === 'ready' || record.status === 'degraded')) {
        record.status = 'degraded';
        record.message = error instanceof Error ? error.message : 'Language request failed';
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return featureFailure(record, error instanceof Error ? error.message : 'Language request failed');
    } finally {
      record.activeRequests -= 1;
      if (open) open.readers = Math.max(0, (open.readers ?? 1) - 1);
      record.usedAt = now();
    }
  };

  const storeResolveItem = (record: LanguageSessionRecord, collection: Map<string, unknown>, raw: unknown): string => {
    record.resolveCounter += 1;
    const token = `${record.generation}:${record.resolveCounter}`;
    collection.set(token, raw);
    return token;
  };

  const resolveFeature = async (
    method: string,
    request: LanguageRequest,
    collectionName: ResolveCollectionName,
    mapResult: FeatureMapper,
  ) => {
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const record = workspaceId && languageId ? sessions.get(sessionKey(workspaceId, languageId, asView(request.view))) : null;
    const raw = request.resolveToken ? record?.[collectionName].get(request.resolveToken) : undefined;
    if (!record || !record.rpc || !raw) {
      return record
        ? featureFailure(record, 'Language resolve item is stale', 'unsupported')
        : { status: 'absent', ...(workspaceId ? { workspaceId } : {}), ...(languageId ? { languageId } : {}) };
    }
    return requestFeature(method, request, mapResult, { params: raw });
  };

  const mappingContext = (record: LanguageSessionRecord) => ({
    workspaceId: record.workspaceId,
    root: record.root,
    pathModule,
  });

  const codeActionMappingContext = (record: LanguageSessionRecord, request: LanguageRequest) => ({
    ...mappingContext(record),
    diagnosticContext: {
      ...mappingContext(record),
      resource: request.resource ?? { workspaceId: record.workspaceId, resourceId: '' },
      documentVersion: request.documentVersion ?? 0,
      severity: lspSeverity,
      providerId: record.providerId,
      generation: record.generation,
    },
  });

  const observeDocumentMutation = (event: Pick<DocumentMutationObservation, 'workspaceId' | 'resourceId' | 'kind'>): void => {
    for (const [key, record] of sessions) {
      if (record.workspaceId !== event.workspaceId || !record.rpc || (record.status !== 'ready' && record.status !== 'degraded')) continue;
      const resourceId = event.resourceId.replaceAll('\\', '/');
      const absolute = pathModule.resolve(record.root, resourceId);
      const relative = pathModule.relative(record.root, absolute);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) continue;
      const invalidate = (): void => {
        if (sessions.get(key) !== record || !record.rpc) return;
        const open = record.documents.get(resourceId);
        if (open?.fixed) return;
        const language = languageIdForPath(resourceId);
        if (open || (language && record.languageIds.includes(language)) || /\.(?:json|toml|yaml|yml|xml)$/.test(resourceId)) {
          record.documentEpoch += 1;
          emit(record.workspaceId, { kind: 'diagnostics-invalidated', view: record.view });
        }
        // A closed disk document is once again read by the server from disk.
        // Fixed drafts and editor buffers keep their own content ownership.
        try {
          if (isHostOwnedView(record.view) && open) {
            record.rpc.notify('textDocument/didClose', { textDocument: { uri: toFileUri(absolute) } });
            record.documents.delete(resourceId);
            desiredDocuments.get(key)?.delete(resourceId);
          }
          record.rpc.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: toFileUri(absolute), type: event.kind === 'created' ? 1 : event.kind === 'deleted' ? 3 : 2 }] });
        } catch (error) { setFailed(record, error instanceof Error ? error.message : 'Language connection failed'); }
      };
      const open = record.documents.get(resourceId);
      if (open?.fixed) continue;
      if (isHostOwnedView(record.view) && open) {
        // Watch delivery can follow a bind that already read the new disk bytes.
        // Invalidate only when the current binding differs from disk.
        void documents.readSnapshot({ workspaceId: record.workspaceId, resourceId }).then(snapshot => {
          const current = record.documents.get(resourceId);
          if (snapshot.status === 'ready' && current?.contentRevision === snapshot.revision) return;
          invalidate();
        }, invalidate);
      } else invalidate();
    }
  };

  return {
    registerProvider(descriptor: LanguageProviderDescriptor, owner?: LanguageOwner) {
      const languageIds = Array.isArray(descriptor?.languageIds)
        ? descriptor.languageIds.filter((id) => typeof id === 'string' && id)
        : [];
      if (!descriptor?.providerId || !descriptor.command || languageIds.length === 0) {
        throw new Error('Language provider requires providerId, command, and languageIds');
      }
      const next: LanguageProvider = {
        providerId: descriptor.providerId as string,
        command: descriptor.command as string,
        args: Array.isArray(descriptor.args) ? descriptor.args.filter((value): value is string => typeof value === 'string') : [],
        languageIds,
        source: owner
          ? 'extension'
          : (descriptor.source === 'workspace' || descriptor.source === 'extension' || descriptor.source === 'builtin'
            ? descriptor.source
            : 'host'),
        ownerScopeKey: ownerScopeKey(owner),
        ownerKey: exactOwnerKey(owner),
      };
      if (typeof descriptor.workspaceId === 'string' && descriptor.workspaceId) {
        next.workspaceId = descriptor.workspaceId;
      }
      if (descriptor.env && typeof descriptor.env === 'object') next.env = descriptor.env as NodeJS.ProcessEnv;
      if (descriptor.initializationOptions && typeof descriptor.initializationOptions === 'object' && !Array.isArray(descriptor.initializationOptions)) {
        next.initializationOptions = structuredClone(descriptor.initializationOptions) as Record<string, unknown>;
      }
      const existingIndex = providers.findIndex((provider) => provider.providerId === next.providerId);
      const existing = existingIndex >= 0 ? providers[existingIndex] : null;
      if (existing && existing.ownerScopeKey !== next.ownerScopeKey) {
        throw new Error(`Language provider ID is already owned: ${next.providerId}`);
      }
      if (existingIndex >= 0) providers.splice(existingIndex, 1, next);
      else providers.push(next);
      if (existing) {
        for (const [key, record] of sessions) {
          if (record.providerId !== existing.providerId) continue;
          retireRecord(key, record, 'Language provider updated');
          inflight.delete(key);
        }
      }
      return next;
    },
    async unregisterProvider(providerId: unknown, owner?: LanguageOwner) {
      const index = providers.findIndex((provider) => (
        provider.providerId === providerId
        && provider.ownerKey === exactOwnerKey(owner)
      ));
      if (index < 0) return { status: 'not-owned', providerId };
      const [removed] = providers.splice(index, 1);
      if (!removed) return { status: 'not-owned', providerId };
      for (const [key, record] of sessions) {
        if (record.providerId !== removed.providerId) continue;
        await disposeRecord(record, 'Language provider disabled');
        sessions.delete(key);
        inflight.delete(key);
      }
      await Promise.all([...pendingExits]);
      return { status: 'unregistered', providerId };
    },
    getStatus,
    observeDocumentMutation,
    async prewarm(workspaceId: string, languageId: string, signal?: AbortSignal) {
      return Promise.all([AGENT_LANGUAGE_VIEW, SURFACE_LANGUAGE_VIEW].map(view => ensureSession(workspaceId, languageId, view, signal)));
    },
    retainWorkspace(workspaceId: string): () => void {
      retainedWorkspaces.set(workspaceId, (retainedWorkspaces.get(workspaceId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (retainedWorkspaces.get(workspaceId) ?? 1) - 1;
        if (count > 0) retainedWorkspaces.set(workspaceId, count);
        else retainedWorkspaces.delete(workspaceId);
      };
    },
    subscribe(workspaceId: string, listener: (event: unknown) => void) {
      const listeners = workspaceListeners.get(workspaceId) ?? new Set();
      listeners.add(listener);
      workspaceListeners.set(workspaceId, listeners);
      return {
        close() {
          listeners.delete(listener);
          if (listeners.size === 0) workspaceListeners.delete(workspaceId);
        },
      };
    },
    hasSyncedDocument(
      workspaceId: string,
      languageId: string,
      resourceId: string,
      view: LanguageViewId = SURFACE_LANGUAGE_VIEW,
    ): boolean {
      return desiredDocuments.get(sessionKey(workspaceId, languageId, view))?.has(resourceId) === true;
    },
    syncedDocumentVersion(
      workspaceId: string,
      languageId: string,
      resourceId: string,
      view: LanguageViewId = SURFACE_LANGUAGE_VIEW,
    ): number | null {
      return desiredDocuments.get(sessionKey(workspaceId, languageId, view))?.get(resourceId)?.documentVersion ?? null;
    },
    /** Text identity a Host-owned view currently holds for one document. */
    syncedContentRevision(
      workspaceId: string,
      languageId: string,
      resourceId: string,
      view: LanguageViewId = AGENT_LANGUAGE_VIEW,
    ): string | null {
      return desiredDocuments.get(sessionKey(workspaceId, languageId, view))?.get(resourceId)?.contentRevision ?? null;
    },
    /** Live server processes per view; occupancy is reported, not hidden. */
    inspectViews(): Array<{ workspaceId: string; languageId: string; view: LanguageViewId; status: string; openDocuments: number; idleMs: number }> {
      const at = now();
      return [...sessions.values()].map((record) => ({
        workspaceId: record.workspaceId,
        languageId: record.languageId,
        view: record.view,
        status: record.status,
        openDocuments: record.documents.size,
        idleMs: Math.max(0, at - record.usedAt),
      }));
    },
    releaseIdleHostViews,
    syncDocument,
    pullDiagnostics: (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => requestFeature('textDocument/diagnostic', request, (raw, record) => {
      const report = asRecord(raw);
      if (report?.kind !== 'full' || !Array.isArray(report.items)) return null;
      return report.items.map(item => mapDiagnostic(item, {
        workspaceId: record.workspaceId, root: record.root, pathModule, resource: request.resource!,
        documentVersion: request.documentVersion ?? null, severity: lspSeverity,
        providerId: record.providerId, generation: record.generation,
      }));
    }, options),
    completion: (request: LanguageRequest) => requestFeature('textDocument/completion', request, (raw, record) => {
      const rawRecord = asRecord(raw);
      const items = Array.isArray(raw) ? raw : Array.isArray(rawRecord?.items) ? rawRecord.items : [];
      record.completionResolveItems.clear();
      const canResolve = record.serverCapabilities?.completionProvider?.resolveProvider === true;
      return items.map((item) => mapCompletionItem(
        item,
        canResolve ? storeResolveItem(record, record.completionResolveItems, item) : undefined,
      )).filter(Boolean);
    }),
    completionResolve: (request: LanguageRequest) => resolveFeature(
      'completionItem/resolve',
      request,
      'completionResolveItems',
      (raw) => mapCompletionItem(raw, request.resolveToken),
    ),
    hover: (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => requestFeature('textDocument/hover', request, mapHover, options),
    signatureHelp: (request: LanguageRequest) => requestFeature('textDocument/signatureHelp', request, mapSignatureHelp),
    definition: (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => requestFeature('textDocument/definition', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return values.map((value) => mapLocationLink(value, record.workspaceId, record.root, pathModule)).filter(Boolean);
    }, options),
    references: (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => requestFeature('textDocument/references', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      return values.map((value) => mapLocation(value, record.workspaceId, record.root, pathModule)).filter(Boolean);
    }, options),
    prepareCallHierarchy: (request: LanguageRequest) => requestFeature('textDocument/prepareCallHierarchy', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.callHierarchyItems.clear();
      return values.map((value) => {
        const mapped = mapCallHierarchyItem(value, record.workspaceId, record.root, pathModule);
        if (!mapped) return null;
        const itemToken = storeResolveItem(record, record.callHierarchyItems, value);
        return { ...mapped, itemToken };
      }).filter(Boolean);
    }),
    callHierarchyIncoming: async (request: LanguageRequest) => {
      const languageId = request.languageId;
      const workspaceId = request.resource?.workspaceId;
      const record = workspaceId && languageId ? sessions.get(sessionKey(workspaceId, languageId, asView(request.view))) : null;
      const raw = request.itemToken ? record?.callHierarchyItems.get(request.itemToken) : undefined;
      if (!record || !record.rpc || !raw) {
        return record
          ? featureFailure(record, 'Language call hierarchy item is stale', 'stale-item')
          : { status: 'absent' as const, ...(workspaceId ? { workspaceId } : {}), ...(languageId ? { languageId } : {}) };
      }
      return requestFeature('callHierarchy/incomingCalls', request, (rawCalls, session) => {
        const values = Array.isArray(rawCalls) ? rawCalls : [];
        return values.map((value) => {
          const call = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
          const from = mapCallHierarchyItem(call['from'], session.workspaceId, session.root, pathModule);
          const fromRanges = (Array.isArray(call['fromRanges']) ? call['fromRanges'] : [])
            .map((range) => mapRange(range))
            .filter(Boolean);
          return from ? { from, fromRanges } : null;
        }).filter(Boolean);
      }, { params: { item: raw } });
    },
    callHierarchyOutgoing: async (request: LanguageRequest) => {
      const languageId = request.languageId;
      const workspaceId = request.resource?.workspaceId;
      const record = workspaceId && languageId ? sessions.get(sessionKey(workspaceId, languageId, asView(request.view))) : null;
      const raw = request.itemToken ? record?.callHierarchyItems.get(request.itemToken) : undefined;
      if (!record || !record.rpc || !raw) {
        return record
          ? featureFailure(record, 'Language call hierarchy item is stale', 'stale-item')
          : { status: 'absent' as const, ...(workspaceId ? { workspaceId } : {}), ...(languageId ? { languageId } : {}) };
      }
      return requestFeature('callHierarchy/outgoingCalls', request, (rawCalls, session) => {
        const values = Array.isArray(rawCalls) ? rawCalls : [];
        return values.map((value) => {
          const call = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
          const to = mapCallHierarchyItem(call['to'], session.workspaceId, session.root, pathModule);
          const fromRanges = (Array.isArray(call['fromRanges']) ? call['fromRanges'] : [])
            .map((range) => mapRange(range))
            .filter(Boolean);
          return to ? { to, fromRanges } : null;
        }).filter(Boolean);
      }, { params: { item: raw } });
    },
    documentSymbols: (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => requestFeature('textDocument/documentSymbol', request, (raw, record) => (
      mapSymbols(raw, mappingContext(record))
    ), options),
    workspaceSymbols: (request: LanguageRequest, options: { signal?: AbortSignal } = {}) => requestFeature('workspace/symbol', request, (raw, record) => (
      mapSymbols(raw, mappingContext(record))
    ), options),
    rename: (request: LanguageRequest) => requestFeature('textDocument/rename', request, (raw, record) => (
      mapWorkspaceEdit(raw, mappingContext(record))
    )),
    codeActions: (request: LanguageRequest) => requestFeature('textDocument/codeAction', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.codeActionResolveItems.clear();
      const canResolve = record.serverCapabilities?.codeActionProvider?.resolveProvider === true;
      return values.map((value) => mapCodeAction(
        value,
        codeActionMappingContext(record, request),
        canResolve ? storeResolveItem(record, record.codeActionResolveItems, value) : undefined,
      )).filter(Boolean);
    }),
    codeActionResolve: (request: LanguageRequest) => resolveFeature(
      'codeAction/resolve',
      request,
      'codeActionResolveItems',
      (raw, record) => mapCodeAction(raw, codeActionMappingContext(record, request), request.resolveToken),
    ),
    executeCommand: (request: LanguageRequest) => requestFeature(
      'workspace/executeCommand',
      request,
      (raw) => raw ?? null,
    ),
    documentFormatting: (request: LanguageRequest) => requestFeature('textDocument/formatting', request, mapTextEdits),
    documentRangeFormatting: (request: LanguageRequest) => requestFeature('textDocument/rangeFormatting', request, mapTextEdits),
    onTypeFormatting: (request: LanguageRequest) => requestFeature('textDocument/onTypeFormatting', request, mapTextEdits),
    semanticTokens: (request: LanguageRequest) => requestFeature(
      request.range ? 'textDocument/semanticTokens/range' : 'textDocument/semanticTokens/full',
      request,
      (raw, record) => {
        const result = asRecord(raw);
        if (!result || !Array.isArray(result.data)) return null;
        const provider = record.serverCapabilities?.semanticTokensProvider;
        const legend = provider === true ? undefined : provider?.legend;
        return {
          data: result.data.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0),
          ...(typeof result.resultId === 'string' ? { resultId: result.resultId } : {}),
          legend: {
            tokenTypes: Array.isArray(legend?.tokenTypes) ? legend.tokenTypes.filter((value) => typeof value === 'string') : [],
            tokenModifiers: Array.isArray(legend?.tokenModifiers) ? legend.tokenModifiers.filter((value) => typeof value === 'string') : [],
          },
        };
      },
    ),
    inlayHints: (request: LanguageRequest) => requestFeature('textDocument/inlayHint', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.inlayHintResolveItems.clear();
      const canResolve = record.serverCapabilities?.inlayHintProvider?.resolveProvider === true;
      return values.map((value) => mapInlayHint(
        value,
        mappingContext(record),
        canResolve ? storeResolveItem(record, record.inlayHintResolveItems, value) : undefined,
      )).filter(Boolean);
    }),
    inlayHintResolve: (request: LanguageRequest) => resolveFeature(
      'inlayHint/resolve',
      request,
      'inlayHintResolveItems',
      (raw, record) => mapInlayHint(raw, mappingContext(record), request.resolveToken),
    ),
    documentHighlights: (request: LanguageRequest) => requestFeature('textDocument/documentHighlight', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapDocumentHighlight).filter(Boolean)
    )),
    foldingRanges: (request: LanguageRequest) => requestFeature('textDocument/foldingRange', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapFoldingRange).filter(Boolean)
    )),
    selectionRanges: (request: LanguageRequest) => requestFeature('textDocument/selectionRange', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapSelectionRange).filter(Boolean)
    )),
    documentLinks: (request: LanguageRequest) => requestFeature('textDocument/documentLink', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.documentLinkResolveItems.clear();
      const canResolve = record.serverCapabilities?.documentLinkProvider?.resolveProvider === true;
      return values.map((value) => mapDocumentLink(
        value,
        mappingContext(record),
        canResolve ? storeResolveItem(record, record.documentLinkResolveItems, value) : undefined,
      )).filter(Boolean);
    }),
    documentLinkResolve: (request: LanguageRequest) => resolveFeature(
      'documentLink/resolve',
      request,
      'documentLinkResolveItems',
      (raw, record) => mapDocumentLink(raw, mappingContext(record), request.resolveToken),
    ),
    documentColors: (request: LanguageRequest) => requestFeature('textDocument/documentColor', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapColorInformation).filter(Boolean)
    )),
    colorPresentations: (request: LanguageRequest) => requestFeature('textDocument/colorPresentation', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapColorPresentation).filter(Boolean)
    )),
    async restart(workspaceId: string, languageId: string, view: LanguageViewId = SURFACE_LANGUAGE_VIEW) {
      // Restarting one view leaves the other owner's session alone.
      const key = sessionKey(workspaceId, languageId, view);
      const starting = inflight.get(key);
      starting?.controller.abort();
      await starting?.promise.catch(() => undefined);
      const existing = sessions.get(key);
      await disposeRecord(existing, 'Language server restart');
      if (existing) sessions.delete(key);
      inflight.delete(key);
      const record = await ensureSession(workspaceId, languageId, view);
      return snapshotFor(record) ?? { status: 'absent', workspaceId, languageId, view };
    },
    async disposeWorkspace(workspaceId: string, owner?: LanguageOwner, view?: LanguageViewId) {
      const ownerKey = owner ? exactOwnerKey(owner) : null;
      const keepWarmSurface = !ownerKey && view === SURFACE_LANGUAGE_VIEW && retainedWorkspaces.has(workspaceId);
      if (!ownerKey && !keepWarmSurface) {
        const starts = [...inflight.values()].filter(entry => entry.workspaceId === workspaceId && (!view || entry.view === view));
        for (const start of starts) start.controller.abort();
        await Promise.allSettled(starts.map(start => start.promise));
        if (!view) retainedWorkspaces.delete(workspaceId);
      }
      for (const [key, record] of sessions) {
        if (record.workspaceId !== workspaceId) continue;
        if (view && record.view !== view) continue;
        if (ownerKey && record.providerOwnerKey !== ownerKey) continue;
        if (keepWarmSurface) {
          clearRecordDiagnostics(record);
          for (const resourceId of record.documents.keys()) {
            record.rpc?.notify('textDocument/didClose', { textDocument: { uri: toFileUri(pathModule.resolve(record.root, resourceId)) } });
          }
          record.documents.clear();
          record.documentEpoch += 1;
          record.usedAt = now();
          desiredDocuments.delete(key);
          continue;
        }
        await disposeRecord(record, 'Workspace language services disposed');
        sessions.delete(key);
        inflight.delete(key);
      }
      if (!ownerKey) {
        if (!view) workspaceListeners.delete(workspaceId);
        for (const key of desiredDocuments.keys()) {
          if (key.startsWith(`${workspaceId}\0`) && (!view || key.endsWith(`\0${view}`))) desiredDocuments.delete(key);
        }
      }
      await Promise.all([...pendingExits]);
    },
    async dispose() {
      disposed = true;
      for (const watch of fileWatches.values()) watch.close();
      fileWatches.clear();
      for (const start of inflight.values()) start.controller.abort();
      await Promise.allSettled([...inflight.values()].map(start => start.promise));
      await Promise.all([...sessions.values()].map((record) => disposeRecord(record, 'Language supervisor disposed')));
      sessions.clear();
      desiredDocuments.clear();
      inflight.clear();
      workspaceListeners.clear();
      providers.length = 0;
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      await Promise.all([...pendingExits]);
    },
  };
};
