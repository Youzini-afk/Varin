import { historicalUiEmbeds, historicalUiRevision } from './history-revisions.js';
import { createHash, randomUUID } from 'node:crypto';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { INTERACTIVE_UI_CAPABILITY, INTERACTIVE_UI_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import { parseConversationContent, normalizeConversationUi, migrateConversationUiState } from '@varin/application-client';
import type { UiBranchScope, UiFragmentRegistrationInput, UiMessageFragment, UiCaptureRequest, UiObservation, UiReadInput, UiSourceIdentity, UiViewState, RenderUiInput, ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { runToolDomainCall } from '../kernel/tool-invocation.js';
import { compileToolJsonSchema } from '../models/schema.js';
import { createUiContentStore, UiContentError, UiMutationUnknownError } from './store.js';
import { READ_PAGE_CHUNK_BYTES } from '../harness/read-page.js';
import type { MediaResourceStore } from '../harness/media-resources.js';
import { threadMaterialScope } from '../kernel/material-storage.js';
import { uiRecordTypes } from './lifecycle.js';

interface LiveView {
  root: string; token: string; source: UiSourceIdentity; clientId: string; branchScope?: UiBranchScope;
  queue: UiCaptureRequest[];
  pending: Map<string, { resolve(value: UiObservation): void; reject(error: unknown): void }>;
  wake?: () => void;
}
function textPage(text: string, input: UiReadInput, next: object) {
  const bytes = Buffer.from(text), offset = input.offset ?? 0, limit = input.limit ?? READ_PAGE_CHUNK_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || offset > bytes.length) throw new UiContentError('Invalid resource page');
  const end = Math.min(bytes.length, offset + limit);
  let content: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    content = decoder.decode(bytes.subarray(offset, end), { stream: end !== bytes.length });
    if (!content && offset < bytes.length) {
      const first = bytes[offset]!, width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + width));
    }
  } catch { throw new UiContentError('Offset must be a UTF-8 character boundary; use the returned continuation'); }
  const nextOffset = offset + Buffer.byteLength(content);
  return { content, offset, totalBytes: bytes.length, ...(nextOffset < bytes.length ? { next: { ...next, offset: nextOffset } } : {}) };
}
function sourcePage(text: string, input: UiReadInput, ref: string) {
  const lines = text.split('\n'), start = input.startLine ?? 1, end = Math.min(input.endLine ?? lines.length, lines.length);
  if (start < 1 || start > lines.length || end < start || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new UiContentError(`Invalid line range (${lines.length} lines total)`);
  return { status: 'ready', ref, file: input.file, startLine: start, endLine: end, totalLines: lines.length,
    ...textPage(lines.slice(start - 1, end).join('\n'), input, { kind: 'ui', ref, view: 'source', file: input.file, startLine: start, endLine: end }) };
}
export function createInteractiveUiRuntime(options: { kernel: KernelClient; runtime: AgentRuntimeClient; media: MediaResourceStore }) {
  const requireOwner = async (identity: UiBranchScope) => {
    const thread = await options.runtime.thread(identity.threadId);
    if (thread.deleted_at_ms != null || !thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new UiContentError('Conversation branch is unavailable', 404);
  };
  const store = createUiContentStore(options.kernel, () => console.error('[Interactive content] Temporary object cleanup requires attention'), requireOwner);
  const views = new Map<string, LiveView>();
  const scope = async (threadId: string) => (await options.runtime.familyList({ callerThreadId: threadId, includeSelf: true })).rootThreadId;
  const target = async (identity: Pick<ThreadIdentity, 'threadId' | 'branchId'>) => {
    await requireOwner(identity);
    return scope(identity.threadId);
  };
  const registerFragment = async (identity: ThreadIdentity, input: UiFragmentRegistrationInput, signal?: AbortSignal) => {
    const root = await target(identity);
    if (typeof input.messageId !== 'string' || !input.messageId || typeof input.fragmentKey !== 'string'
      || input.contentIndex !== undefined && (!Number.isSafeInteger(input.contentIndex) || input.contentIndex < 0)) throw new UiContentError('Invalid message fragment identity');
    // Search the current branch's ancestry, never read an arbitrary client-supplied history ID.
    let before: string | undefined, head: string | undefined;
    let selected: Awaited<ReturnType<AgentRuntimeClient['historyPage']>>['items'][number] | undefined;
    do {
      const page = await options.runtime.historyPage({ branchId: identity.branchId, limit: 100, ...(head ? { headId: head } : {}), ...(before ? { beforeId: before } : {}) }, signal);
      if (head && (page.head !== head || page.boundary_reset)) throw new UiContentError('Conversation history changed; reopen this fragment', 409);
      head = page.head ?? undefined;
      selected = page.items.find(item => item.id === input.messageId);
      if (selected) break;
      if (page.previous === before && before) throw new UiContentError('History reader did not advance', 503);
      before = page.previous ?? undefined;
    } while (before);
    if (!selected || selected.source !== 'assistant') throw new UiContentError('Assistant fragment is unavailable in this branch', 404);
    const item = await options.runtime.historyItem(selected, signal);
    const body = (item.content as { content?: { kind?: string; text?: unknown; output?: { parts?: { kind?: string; text?: unknown }[] } } })?.content;
    let text: unknown;
    if (body?.kind === 'text' && (input.contentIndex === undefined || input.contentIndex === 0)) text = body.text;
    else if (body?.kind === 'output' && input.contentIndex !== undefined) {
      const part = body.output?.parts?.[input.contentIndex]; if (part?.kind === 'text') text = part.text;
    }
    if (typeof text !== 'string') throw new UiContentError('Source is not assistant body text');
    const fragment = parseConversationContent(text, { role: 'assistant' }).find(part => part.kind === 'ui' && part.fragmentKey === input.fragmentKey);
    if (!fragment || fragment.kind !== 'ui') throw new UiContentError('Complete interaction not found at this source position', 404);
    const contentVersion = createHash('sha256').update(fragment.raw).digest('hex');
    if (input.contentVersion !== undefined && input.contentVersion !== contentVersion) throw new UiContentError('Fragment definition changed', 409);
    const origin: UiMessageFragment = { threadId: identity.threadId, branchId: identity.branchId, messageId: selected.id,
      fragmentKey: input.fragmentKey, ...(body?.kind !== 'output' || input.contentIndex === undefined ? {} : { contentIndex: input.contentIndex }), contentVersion };
    const receipt = await store.render(root, { content: fragment.definition, ...(fragment.node.label ? { title: fragment.node.label } : {}) },
      `fragment:${JSON.stringify(origin)}`, undefined, origin);
    return store.source(root, receipt.ref);
  };
  const captureBranch = async (identity: ThreadIdentity, targetBranchId: string, headId: string | null, signal?: AbortSignal) => {
    const root = await target(identity);
    const ancestors = new Set<string>(), revisions = new Set<string>(); let before: string | undefined;
    if (headId) do {
      const page = await options.runtime.historyPage({ branchId: identity.branchId, headId, limit: 100, ...(before ? { beforeId: before } : {}) }, signal);
      if (page.head !== headId || page.boundary_reset) throw new UiContentError('Fork history changed', 409);
      for (const item of page.items) {
        ancestors.add(item.id);
        const revision = await historicalUiRevision(item, options.runtime, operationId => store.operationReceipt(root, operationId), signal);
        if (revision) revisions.add(revision);
        for (const embedded of await historicalUiEmbeds(item, options.runtime, async ref => {
          try { return (await store.resolve(root, ref)).version.ref === ref; }
          catch (error) { if (error instanceof UiContentError && error.status === 404) return false; throw error; }
        }, signal)) revisions.add(embedded);
      }
      if (before && page.previous === before) throw new UiContentError('History reader did not advance', 503);
      before = page.previous ?? undefined;
    } while (before);
    signal?.throwIfAborted();
    await store.captureBranch(root, { threadId: identity.threadId, branchId: identity.branchId },
      { threadId: identity.threadId, branchId: targetBranchId }, headId, messageId => ancestors.has(messageId), ref => revisions.has(ref));
  };
  const closeView = (ref: string, current: LiveView) => {
    if (views.get(ref) !== current) return;
    views.delete(ref); current.wake?.();
    for (const pending of current.pending.values()) pending.reject(new UiContentError('View is no longer connected', 503, 'ui_view_disconnected'));
    current.pending.clear();
  };
  const live = (root: string, ref: string, token?: string) => {
    const view = views.get(ref);
    if (!view || view.root !== root || token !== undefined && token !== view.token) throw new UiContentError('View is no longer connected', 503, 'ui_view_disconnected');
    return view;
  };
  const observe = async (root: string, ref: string, view: UiReadInput['view'], signal: AbortSignal) => {
    const current = live(root, ref);
    const id = randomUUID();
    let abort!: () => void;
    try {
      return await new Promise<UiObservation>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true });
        current.pending.set(id, { resolve, reject }); current.queue.push({ id, view: view ?? 'summary' }); current.wake?.();
      });
    } finally { signal.removeEventListener('abort', abort); current.pending.delete(id); current.queue = current.queue.filter(request => request.id !== id); }
  };
  const attach = async (root: string, source: UiSourceIdentity, ref = `ui-view:${randomUUID()}`, clientId: string, signal?: AbortSignal, branchScope?: UiBranchScope) => {
    if (source.ref && source.preview) throw new UiContentError('View must have exactly one source');
    if (source.ref) source = { ref: (await store.resolve(root, source.ref)).version.ref };
    else if (!source.preview) throw new UiContentError('View needs a source');
    else if (source.preview.content) { try { source = { preview: { ...source.preview, content: normalizeConversationUi(source.preview.content) } }; } catch { throw new UiContentError('Invalid declarative preview'); } }
    const old = views.get(ref);
    const saved = await store.view(root, ref);
    let initialState: UiViewState | null | undefined;
    const otherBranch = Boolean(branchScope && saved?.branchScope && (branchScope.threadId !== saved.branchScope.threadId || branchScope.branchId !== saved.branchScope.branchId));
    if (otherBranch) { initialState = null; ref = `ui-view:${randomUUID()}`; }
    else if (old && (old.root !== root || old.clientId !== clientId) || saved?.lease && saved.lease.clientId !== clientId) {
      initialState = saved?.state ?? null; ref = `ui-view:${randomUUID()}`;
    } else if (old) closeView(ref, old);
    if (!otherBranch && saved?.state && saved.source.ref !== source.ref) {
      const before = saved.source.ref ? (await store.source(root, saved.source.ref)).content : saved.source.preview?.content;
      const after = source.ref ? (await store.source(root, source.ref)).content : source.preview?.content;
      if (before && after) {
        const data = saved.state.data;
        const migrated = migrateConversationUiState(before, after, data && typeof data === 'object' && !Array.isArray(data) ? data : {});
        initialState = { ...saved.state, data: migrated.values, controls: { ...saved.state.controls, __varinResetKeys: migrated.resetKeys } };
      }
    }
    if (branchScope && (!saved || otherBranch)) initialState = await store.branchSeed(root, branchScope, source, clientId);
    const token = randomUUID();
    const { state } = await store.saveView(root, ref, { ...(branchScope ? { branchScope } : {}), source, lease: { token, clientId }, ...(initialState === undefined ? {} : { state: initialState }) });
    signal?.throwIfAborted();
    return { viewRef: ref, token, state };
  };
  const validateViewScope = async (root: string, ref: string, scope: UiBranchScope) => {
    const saved = await store.view(root, ref);
    if (saved?.branchScope && (saved.branchScope.threadId !== scope.threadId || saved.branchScope.branchId !== scope.branchId)) throw new UiContentError('View belongs to another conversation branch', 403);
  };
  const poll = async (root: string, ref: string, token: string, signal: AbortSignal): Promise<UiCaptureRequest | null> => {
    if (!views.has(ref)) {
      const saved = await store.view(root, ref);
      signal.throwIfAborted();
      if (saved?.lease?.token !== token) throw new UiContentError('View connection changed', 409);
      if (!views.has(ref)) views.set(ref, { root, token, source: saved.source, clientId: saved.lease.clientId, ...(saved.branchScope ? { branchScope: saved.branchScope } : {}), queue: [], pending: new Map() });
    }
    const current = live(root, ref, token);
    if (current.wake) throw new UiContentError('View already has an observer', 409);
    if (current.queue.length) return current.queue.shift()!;
    return new Promise((resolve, reject) => {
      // This is an observation heartbeat, never a deadline on execution or rendering.
      const timer = setTimeout(() => finish(null), 25_000);
      const abort = () => { closeView(ref, current); finish(null, signal.reason); };
      const finish = (value: UiCaptureRequest | null, error?: unknown) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); delete current.wake;
        if (error) reject(error); else resolve(value);
      };
      current.wake = () => finish(current.queue.shift() ?? null);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  };
  /** A disconnected view is never answered with older data as if it were live. The saved view
   * record has no capture time, so none is reported; the source summary lists connected views. */
  const disconnectedView = async (root: string, input: UiReadInput, view: UiReadInput['view']) => {
    const saved = await store.view(root, input.ref).catch(() => null);
    const source = saved?.source.ref ?? null;
    return { status: 'unavailable', code: 'ui_view_disconnected', ref: input.ref, view: view ?? 'summary', source,
      savedStateAvailable: Boolean(saved?.state),
      message: 'This view is not connected now, so its live state cannot be read. Read the source summary for currently connected views, or read the source with view: source.',
      next: source ? [{ kind: 'ui', ref: source, view: 'summary' }, { kind: 'ui', ref: source, view: 'source' }] : [] };
  };
  const read = async (root: string, input: UiReadInput, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const view = input.view ?? 'summary';
    if (input.ref.startsWith('ui:')) {
      const { version } = await store.resolve(root, input.ref);
      const summary = { kind: 'ui', ref: version.ref, title: version.title, entry: version.entry, files: Object.keys(version.files), revision: version.revision };
      if (view === 'summary') return { status: 'ready', ...summary,
        views: [...views].filter(([, v]) => v.root === root && v.source.ref === version.ref).map(([ref]) => ref) };
      if (view !== 'source') {
        const candidates = [...views].filter(([, v]) => v.root === root && v.source.ref === version.ref).map(([ref]) => ref);
        // A stable failure status keeps this guidance intact through the generic resource tool.
        return { status: 'unavailable', code: 'ui_view_required', ...summary, views: candidates,
          message: candidates.length ? 'Select one of views and repeat this read with its ui-view: reference. Each view has its own live state.'
            : 'No live view is connected for this revision. Open this content in the chat, then read summary to discover its ui-view: reference. Source is available with view: source.',
          next: candidates.map(ref => ({ kind: 'ui', ref, view })) };
      }
      if (version.content) {
        if (input.file) throw new UiContentError('Declarative content has no source files');
        const definition = { content: version.content, definition: version.definition, messageFragment: version.messageFragment, branchScope: version.branchScope, forkedFrom: version.forkedFrom };
        const page = textPage(JSON.stringify(definition), input, { kind: 'ui', ref: version.ref, view: 'source' });
        return { status: 'ready', ...summary, ...(page.next || page.offset ? { contentText: page.content, offset: page.offset, totalBytes: page.totalBytes, ...(page.next ? { next: page.next } : {}) } : definition) };
      }
      if (!input.file) return { status: 'ready', ...summary };
      const text = await store.file(root, version.ref, input.file);
      return sourcePage(text, input, version.ref);
    }
    let observed: UiObservation, snapshotRef: string, text: string | undefined;
    if (input.ref.startsWith('ui-selection:')) {
      const selection = await store.selection(root, input.ref);
      snapshotRef = selection.snapshotRef; observed = await store.readSnapshot(root, snapshotRef); text = selection.text;
      if (selection.structure) observed.structure = selection.structure;
      if (view === 'summary') return { status: 'ready', ref: selection.ref, snapshotRef, title: selection.title, text, region: selection.region,
        source: selection.source.ref ?? (selection.source.preview ? { callId: selection.source.preview.callId, sequence: selection.source.preview.sequence, baseRef: selection.source.preview.baseRef } : null),
        image: selection.image ? { available: true } : undefined };
    } else if (input.ref.startsWith('ui-snapshot:')) { snapshotRef = input.ref; observed = await store.readSnapshot(root, snapshotRef); }
    else {
      try { observed = await observe(root, input.ref, view, signal); }
      catch (error) {
        if (!(error instanceof UiContentError) || error.code !== 'ui_view_disconnected') throw error;
        return disconnectedView(root, input, view);
      }
      snapshotRef = await store.snapshot(root, observed);
    }
    if (view === 'source') {
      if (observed.ref) return read(root, { ...input, ref: observed.ref }, signal);
      if (observed.preview?.content) {
        if (input.file) throw new UiContentError('Declarative previews have no source files');
        const definition = { content: observed.preview.content, messageFragment: observed.preview.messageFragment };
        const page = textPage(JSON.stringify(definition), input, { kind: 'ui', ref: snapshotRef, view: 'source' });
        return { status: 'ready', snapshotRef, provenance: 'client-preview', ...(page.next || page.offset ? { contentText: page.content, offset: page.offset, totalBytes: page.totalBytes, ...(page.next ? { next: page.next } : {}) } : definition) };
      }
      const contents = observed.preview!.contents;
      if (!input.file) return { status: 'ready', snapshotRef, files: Object.keys(contents) };
      if (!Object.hasOwn(contents, input.file)) throw new UiContentError('Preview file not found', 404);
      return { ...sourcePage(contents[input.file]!, input, snapshotRef), snapshotRef };
    }
    const summary = { status: 'ready', snapshotRef, provenance: observed.ref ? 'saved' : 'client-preview', source: observed.ref ?? (observed.preview ? { callId: observed.preview.callId, sequence: observed.preview.sequence, baseRef: observed.preview.baseRef } : null), capturedAt: observed.capturedAt, viewport: observed.viewport, render: observed.render };
    if (view === 'state') {
      const page = textPage(JSON.stringify({ state: observed.state, context: observed.context }), input, { kind: 'ui', ref: snapshotRef, view });
      return page.next || page.offset ? { ...summary, stateText: page.content, offset: page.offset, totalBytes: page.totalBytes, ...(page.next ? { next: page.next } : {}) }
        : { ...summary, state: observed.state, context: observed.context };
    }
    if (view === 'structure') {
      const nodes = observed.structure ?? [];
      const page = textPage(JSON.stringify(nodes), input, { kind: 'ui', ref: input.ref.startsWith('ui-selection:') ? input.ref : snapshotRef, view });
      return { ...summary, totalNodes: nodes.length, ...(text ? { text } : {}), ...(page.next || page.offset
        ? { structureText: page.content, offset: page.offset, totalBytes: page.totalBytes, ...(page.next ? { next: page.next } : {}) }
        : { structure: nodes }) };
    }
    if (view === 'screen') {
      if (!observed.image) throw new UiContentError('This client cannot capture the current view; its state and structure remain readable', 503, 'ui_screen_capture_unsupported');
      return { ...summary, captureMethod: observed.image.method, capturedBounds: observed.image.bounds, imageCapturedAt: observed.image.capturedAt,
        stateCapturedAt: observed.stateCapturedAt ?? observed.capturedAt,
        outputParts: [{ kind: 'media', media: { media_type: observed.image.mimeType, data_base64: observed.image.data } }] };
    }
    return { ...summary, totalNodes: observed.structure?.length ?? 0, screenshotAvailable: Boolean(observed.image), ...(text ? { text } : {}) };
  };
  /** A fork writes through the original work owner and its idempotent operation receipts.
   * Reusing an old parent reference cannot overwrite edits already made in the local branch. */
  const renderForBranch = async (root: string, input: RenderUiInput, origin: string, branch: UiBranchScope,
    readMedia?: (resourceId: string) => Promise<{ mimeType: string; bytes: Uint8Array }>) => {
    if (input.ref && (input.content !== undefined) !== (input.changes !== undefined)) {
      const source = await store.source(root, input.ref);
      const owner = source.branchScope ?? source.messageFragment;
      // Older HTML works predate branch ownership metadata. Fork rather than guessing
      // that the current branch is entitled to mutate their shared latest revision.
      if (Boolean(source.content) === (input.content !== undefined) && (!owner || owner.threadId !== branch.threadId || owner.branchId !== branch.branchId)) {
        const initial: RenderUiInput = source.content ? { content: source.definition ?? source.content, title: source.title }
          : { title: source.title, entry: source.entry, changes: Object.entries(source.contents).map(([file, text]) => ({ op: 'write', file, text })) };
        const retainMedia = async (resourceId: string) => {
          const saved = source.assets[`media:${resourceId}`];
          if (saved) return { mimeType: saved.mimeType, bytes: Buffer.from(saved.data, 'base64') };
          if (!readMedia) throw new UiContentError('Original media is unavailable');
          return readMedia(resourceId);
        };
        const fork = await store.render(root, initial,
          `branch-fork:${JSON.stringify([branch.threadId, branch.branchId, source.workRef])}`, source.content ? undefined : retainMedia,
          source.messageFragment ? { ...source.messageFragment, ...branch } : undefined, branch, source.ref);
        input = { ...input, ref: fork.ref };
      }
    }
    return store.render(root, input, origin, readMedia, undefined, branch);
  };
  const validate = compileToolJsonSchema(INTERACTIVE_UI_TOOL_DECLARATIONS[0]!.tool!.inputSchema);
  const capability: HostCapabilityHandler = async (method, input, call) => {
    if (method !== 'render' || !validate(input)) throw new UiContentError('Arguments do not match render_ui');
    return runToolDomainCall(call, { domain: INTERACTIVE_UI_CAPABILITY, toolName: 'render_ui', operation: 'effect', arguments: parseVarinToolJson(input) }, async invocation => {
      try {
        call.signal.throwIfAborted();
        const root = await scope(invocation.threadId);
        const payload = input as unknown as RenderUiInput;
        const readMedia = (resourceId: string) => options.media.read({ owningWorkspaceId: threadMaterialScope(root), threadId: invocation.threadId }, resourceId);
        const run = await options.runtime.run(invocation.runId);
        const result = await renderForBranch(root, payload, invocation.operationId, { threadId: invocation.threadId, branchId: run.branch_id }, readMedia);
        return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: parseVarinToolJson(result), parts: [] } } };
      } catch (error) {
        const unknown = error instanceof UiMutationUnknownError;
        return { executor_stopped: true, completion: { kind: 'result', outcome: unknown ? 'indeterminate' : call.signal.aborted ? 'cancelled' : 'failed', effect: unknown ? 'unknown' : 'none',
          content: { data: { status: unknown ? 'unknown' : call.signal.aborted ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'Content could not be saved' }, parts: [] } } };
      }
    });
  };
  const releaseDeleted = async (signal?: AbortSignal, cleanupOnly = false) => {
    const discovery = await options.kernel.issueGrant({ grantId: `ui-discovery:${randomUUID()}`, owningWorkspace: null, executionWorkspace: null,
      capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] }, signal);
    try {
      const roots = new Set<string>();
      for (const recordType of uiRecordTypes) {
        const { workspaceIds } = await options.kernel.recordWorkspaces({ recordType }, discovery, signal);
        for (const workspace of workspaceIds) if (workspace.startsWith('__varin_ui__:')) roots.add(workspace.slice('__varin_ui__:'.length));
      }
      if (!roots.size) return { pending: false };
      let pending = false;
      // Native release receipts keep failed physical cleanup discoverable even
      // after their UI records are gone. Retry those exact hashes first.
      for (const root of roots) pending = (await store.cleanup(root, signal)).pending || pending;
      if (cleanupOnly) return { pending };
      // Cheap ownership discovery first. Full UI tracing is opt-in, so ordinary
      // material maintenance and a live UI family never scan every message body.
      const plan = await options.runtime.materialRetention(undefined, signal);
      const retired = new Set(plan.threads.filter(thread => thread.release).map(thread => thread.threadId));
      const families = new Map<string, boolean>();
      for (const thread of plan.threads) families.set(thread.rootThreadId, (families.get(thread.rootThreadId) ?? true) && thread.release);
      for (const [ref, current] of views) if (families.get(current.root) || current.branchScope && retired.has(current.branchScope.threadId)) closeView(ref, current);
      const candidates = [...roots].filter(root => families.get(root));
      if (!candidates.length) return { pending };
      // Invoke only after native metadata retirement. The full Catalog projection
      // protects queued, historical, shared and inherited references after restart.
      const traced = await options.runtime.materialRetention(undefined, signal, true);
      for (const root of candidates) {
        signal?.throwIfAborted(); await store.collect(root, traced, signal);
        pending = (await store.cleanup(root, signal)).pending || pending;
      }
      return { pending };
    } finally { await options.kernel.revokeGrant(discovery.grantId); }
  };
  return { store, scope, target, registerFragment, renderForBranch, validateViewScope, captureBranch, capability, read, attach, poll, releaseDeleted,
    disconnect(root: string, ref: string, token: string) {
      const current = views.get(ref); if (current?.root === root && current.token === token) closeView(ref, current);
    },
    async detach(root: string, ref: string, token: string, state?: UiViewState) {
      const current = views.get(ref); if (current?.root === root && current.token === token) closeView(ref, current);
      await store.saveView(root, ref, { lease: null, ...(state === undefined ? {} : { state }) }, token); return { closed: true };
    },
    async state(root: string, ref: string, token: string, state: UiViewState) {
      await store.saveView(root, ref, { state }, token); return { saved: true };
    },
    reply(root: string, ref: string, token: string, id: string, observation?: UiObservation, error?: string) {
      const current = live(root, ref, token); const pending = current.pending.get(id);
      if (pending) {
        if (error || !observation) pending.reject(new UiContentError(error ?? 'View capture is unavailable', 503));
        else if (observation.viewRef !== ref || observation.ref !== current.source.ref || observation.preview?.callId !== current.source.preview?.callId || observation.preview?.sequence !== current.source.preview?.sequence) pending.reject(new UiContentError('View changed while observing', 409));
        else pending.resolve(observation);
      }
      return { received: true };
    },
    close() { for (const [ref, current] of views) closeView(ref, current); },
  };
}
export type InteractiveUiRuntime = ReturnType<typeof createInteractiveUiRuntime>;
