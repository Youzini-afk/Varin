import type { AgentSettingsSnapshot } from '@varin/application-client';
/** Native invocation and public-reader adapters into the existing Web/material owners. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseThreadMaterials, type ThreadInputMaterials } from './thread-material-input.js';
import type { ThreadIdentity, ThreadMaterialsAPI, ThreadMaterialArtifactReadRequest, ThreadResearchSelection } from '@varin/application-client';
import { WEB_CAPABILITY, WEB_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { compileToolJsonSchema } from '../models/schema.js';
import {
  resolveHarnessDocumentReadingSettings, parseHarnessWebSearchSettings,
  DOCUMENT_MIME_TYPES, formatWebSourceCitation, parseWebSourceCitation, materialAttachmentRef,
  type DocumentReadRequest, type FetchResult, type HarnessDocumentReadingSettings, type HarnessWebDomainPolicy,
  type WebFetchRequest, type WebSearchRequest, type WebSearchResult,
  type MaterialsCollectionParams, type ScholarlyPaper,
} from '@varin/protocol';
import type { DocumentReader, DocumentReaderContext } from '../harness/document-reading.js';
import { readDocumentMaterial, type AlternateDocumentReader, type DocumentMaterialSources } from '../harness/document-material.js';
import { resolveHarnessWebBinding, type HarnessWebBinding } from '../harness/harness-web-settings.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { createWebFetch } from '../harness/web-fetch.js';
import type { ThreadMaterialAuthority, WebMaterialStore } from '../harness/web-materials.js';
import { createWebSearchService, resolveConfiguredSearchProvider } from '../harness/web-search.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExtensionToolConfiguration, ExtensionToolRun } from './extension-tool-owner.js';
import { extendToolConfiguration } from './extension-tool-owner.js';
import { createMaterialToolOwner } from './material-tool-owner.js';
import { threadMaterialScope } from './material-storage.js';
import type { ExtensionToolBinding, LaunchSource, OutputBody, IncomingMedia, OutputPart } from './protocol.generated.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { DocumentSources } from './document-sources.js';
import { parseWebRetrievalAssistanceConfiguration, WebAssistanceIndeterminateError, type WebRetrievalAssistanceConfiguration, type createWebRetrievalAssistance } from './web-retrieval-assistance.js';
import { captureSearchSource, captureScholarlySource } from '../harness/web-sources.js';
import { MaterialCollectionMutationError, type createMaterialCollections } from '../harness/material-collections.js';

export { WEB_CAPABILITY };
const declarations = new Map(WEB_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.web.'.length),
  { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceCitation = (result: FetchResult): FetchResult => {
  if (result.status !== 'ok' || !result.snapshot || result.snapshot.document?.kind === 'pdf') return result;
  const snapshot = result.snapshot;
  if (snapshot.document) {
    const query = new URLSearchParams({ page: '1', format: snapshot.document.kind });
    if (snapshot.document.source?.contentHash) query.set('sourceHash', snapshot.document.source.contentHash);
    return { ...result, citation: `varin-material://${encodeURIComponent(snapshot.snapshotId)}?${query}`, attachmentRef: materialAttachmentRef(snapshot.snapshotId) };
  }
  return { ...result, citation: formatWebSourceCitation({ snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash,
    ...(result.range && result.range.endLine >= result.range.startLine ? { startLine: result.range.startLine, endLine: result.range.endLine } : {}) }),
    ...(result.ranges && result.ranges.length > 1 ? { passageCitations: result.ranges.map(({ startLine, endLine }) => ({ startLine, endLine,
      citation: formatWebSourceCitation({ snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash, startLine, endLine }) })) } : {}),
    attachmentRef: materialAttachmentRef(snapshot.snapshotId) };
};
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
interface WebConfiguration {
  version: 1 | 2;
  assistance?: WebRetrievalAssistanceConfiguration;
  web: HarnessWebBinding;
  documentReading: HarnessDocumentReadingSettings;
  disabledTools: string[];
}
function capture(snapshot: AgentSettingsSnapshot): WebConfiguration {
  const global = object(snapshot.global.harness) ? snapshot.global.harness : {};
  const project = snapshot.projectTrusted && object(snapshot.project.harness) ? snapshot.project.harness : {};
  const tools = { ...(object(global.tools) ? global.tools : {}), ...(object(project.tools) ? project.tools : {}) };
  for (const value of WEB_TOOL_DECLARATIONS) {
    const enabled = tools[value.tool!.name];
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Web tool settings must be boolean');
  }
  return { version: 1, web: resolveHarnessWebBinding(snapshot),
    documentReading: resolveHarnessDocumentReadingSettings(global.documentReading),
    disabledTools: WEB_TOOL_DECLARATIONS.filter(value => tools[value.tool!.name] === false).map(value => value.tool!.name),
  };
}
const domains = (config: WebConfiguration): HarnessWebDomainPolicy => ({
  ...(config.web.settings?.domains?.allow === undefined ? {} : { allow: config.web.settings.domains.allow }),
  block: config.web.settings?.domains?.block ?? [],
});
function configuration(identity: string | null | undefined): WebConfiguration {
  let value: unknown;
  try { value = identity ? JSON.parse(identity) : null; } catch { value = null; }
  const invalid = () => new Error('The original Web configuration is unavailable; prepare a new execution');
  if (!object(value) || (value.version !== 1 && value.version !== 2) || Object.keys(value).some(key => !['version', 'web', 'documentReading', 'disabledTools', 'assistance'].includes(key))
    || !object(value.web) || typeof value.web.generation !== 'string' || !object(value.web.settings)
    || !object(value.web.settings.domains) || !strings(value.web.settings.domains.block)
    || value.web.settings.domains.allow !== undefined && !strings(value.web.settings.domains.allow)
    || value.web.settings.render !== undefined && typeof value.web.settings.render !== 'boolean'
    || value.web.settings.readingAssistance !== undefined && typeof value.web.settings.readingAssistance !== 'boolean'
    || value.web.settings.search !== undefined && !parseHarnessWebSearchSettings(value.web.settings.search)
    || value.web.searchError !== undefined && typeof value.web.searchError !== 'string'
    || !strings(value.disabledTools)) throw invalid();
  const documentReading = resolveHarnessDocumentReadingSettings(value.documentReading);
  if (!isDeepStrictEqual(documentReading, value.documentReading)) throw invalid();
  return { version: value.version as 1 | 2, web: value.web as unknown as HarnessWebBinding, documentReading, disabledTools: value.disabledTools,
    ...(value.version === 2 ? { assistance: parseWebRetrievalAssistanceConfiguration(value.assistance) } : {}) };
}
function decode(method: string, value: unknown) {
  const selected = declarations.get(method);
  if (!selected || !selected.validate(value)) throw new HarnessServiceError('invalid-params',
    'Arguments do not match the Web capability. Select a supported search request, page or document source.');
  return { selected, input: parseVarinToolJson(value) };
}

/** Keep source identities and requested content, without embedding a second
 * copy of the retained document layout inside each snapshot reference. */
export function webOutput(result: FetchResult | WebSearchResult): OutputBody<IncomingMedia> {
  const parts: OutputPart<IncomingMedia>[] = [];
  const snapshotRef = (snapshot: NonNullable<Extract<FetchResult, { status: 'ok' }>['snapshot']>) => {
    if (snapshot.document?.kind !== 'pdf') { const { structure: _structure, ...identity } = snapshot; return identity; }
    const { structure: _structure, document, ...identity } = snapshot;
    return { ...identity, ...(document ? { document: { kind: document.kind, parser: document.parser,
      ...(document.pageCount === undefined ? {} : { pageCount: document.pageCount }),
      ...(document.sourceSnapshotId ? { sourceSnapshotId: document.sourceSnapshotId } : {}),
      ...(document.source ? { source: document.source } : {}) } } : {}) };
  };
  const project = (value: FetchResult): unknown => {
    if (value.status !== 'ok') return value;
    const { pageImage, pageImages, snapshot, sourceSnapshot, ...metadata } = value;
    const images = new Map<string, number>();
    const image = (value: NonNullable<Extract<FetchResult, { status: 'ok' }>['pageImage']>) => {
      const { data, ...imageMetadata } = value;
      const key = `${value.mimeType}:${data}`;
      const partIndex = images.get(key) ?? parts.length;
      if (!images.has(key)) { parts.push({ kind: 'media', media: { media_type: value.mimeType, data_base64: data } }); images.set(key, partIndex); }
      return { ...imageMetadata, partIndex };
    };
    return { ...metadata, ...(snapshot ? { snapshot: snapshotRef(snapshot) } : {}),
      ...(sourceSnapshot && sourceSnapshot.snapshotId !== snapshot?.snapshotId ? { sourceSnapshot: snapshotRef(sourceSnapshot) } : {}),
      ...(pageImage ? { pageImage: image(pageImage) } : {}),
      ...(pageImages ? { pageImages: pageImages.map(image) } : {}) };
  };
  const searchProjection = (value: WebSearchResult) => {
    // Per-query observations carry distinct citations. Do not repeat the same
    // bodies in an additional merged list or disclose the full route catalogue.
    const { results: _merged, connections, ...metadata } = value;
    return { ...metadata, ...(!value.items.length && connections ? { connections } : {}),
      items: value.items.map(item => item.fetch ? { ...item, fetch: project(item.fetch) } : { ...item,
        ...(item.results ? { results: item.results.map(hit => {
          const { excerpts, ...metadata } = hit;
          const characters = Array.from(hit.snippet);
          const displayed = hit.source && characters.length > 1600 ? characters.slice(0, 1600).join('') : hit.snippet;
          return { ...metadata, snippet: displayed, ...(excerpts ? { excerptsCount: excerpts.length } : {}),
            ...(displayed !== hit.snippet ? { preview: { truncated: true, characters: 1600, totalCharacters: characters.length },
              nextRead: { snapshotId: hit.source!.snapshot.snapshotId } } : {}) };
        }) } : {}) }) };
  };
  const data = 'items' in result ? searchProjection(result) : project(result);
  return { data: parseVarinToolJson(data), parts };
}
function receipt(value: FetchResult | WebSearchResult): ToolExecutionReceipt {
  const successful = 'items' in value ? Boolean(value.connections && !value.items.length) || value.items.some(item => ['ok', 'empty', 'partial'].includes(item.status))
    : value.status === 'ok' || value.status === 'redirect-cross-host';
  return { executor_stopped: true, completion: { kind: 'result', outcome: successful ? 'succeeded' : 'failed', effect: 'none', content: webOutput(value) } };
}

export interface WebRuntimeOptions {
  runtime: Pick<AgentRuntimeClient, 'familyList' | 'run' | 'launch'>;
  webFetch: ReturnType<typeof createWebFetch>;
  documentReader: DocumentReader;
  alternateDocumentReader?: AlternateDocumentReader;
  documentSources?: DocumentSources;
  materials: WebMaterialStore;
  assistance?: ReturnType<typeof createWebRetrievalAssistance>;
  collections?: ReturnType<typeof createMaterialCollections>;
  fetch: typeof globalThis.fetch;
  readAuth(): unknown | Promise<unknown>;
  /** Read current user/trusted-project assets, without opening a Pi AgentSession. */
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
}
export function createWebRuntime(options: WebRuntimeOptions) {
  const readMaterial = (request: DocumentReadRequest, context: DocumentReaderContext, sources?: DocumentMaterialSources) =>
    readDocumentMaterial(options.documentReader, request, context, sources, options.alternateDocumentReader);
  const scope = async (identity: ThreadIdentity, signal?: AbortSignal) => {
    if (identity.runtime !== 'agent' || !identity.threadId || !identity.branchId) throw new HarnessServiceError('forbidden', 'A real Thread and branch are required');
    const family = await options.runtime.familyList({ callerThreadId: identity.threadId, includeSelf: true }, signal);
    const branch = family.members.find(member => member.threadId === identity.threadId)?.branches.find(branch => branch.branchId === identity.branchId);
    if (!branch) throw new HarnessServiceError('forbidden', 'The material reader branch does not belong to this Thread');
    const workspaceId = threadMaterialScope(family.rootThreadId);
    const authority: ThreadMaterialAuthority = { kind: 'thread', owningWorkspaceId: workspaceId, threadId: identity.threadId };
    return { workspaceId, authority, branch };
  };
  const invocationScope = async (invocation: ToolInvocationAuthority, signal: AbortSignal) => {
    const run = await options.runtime.run(invocation.runId, signal);
    if (run.thread_id !== invocation.threadId) throw new HarnessServiceError('forbidden', 'The original material invocation changed');
    return scope({ runtime: 'agent', threadId: invocation.threadId, branchId: run.branch_id }, signal);
  };
  const context = (owner: { workspaceId: string; authority: ThreadMaterialAuthority }, config: WebConfiguration, signal: AbortSignal): DocumentReaderContext => ({
    workspaceId: owner.workspaceId, authority: owner.authority, signal,
    domainPolicy: domains(config), engineOptions: config.documentReading,
  });
  const fetchPage = async (request: WebFetchRequest, owner: { workspaceId: string; authority: ThreadMaterialAuthority }, config: WebConfiguration, signal: AbortSignal, invocation?: ToolInvocationAuthority): Promise<FetchResult> => {
    const citation = request.ref ? parseWebSourceCitation(request.ref) : null;
    if (request.ref && !citation) throw new HarnessServiceError('invalid-params', 'webfetch ref requires a retained web source citation; use document_read for document attachment refs');
    if (citation && request.snapshotId && request.snapshotId !== citation.snapshotId) throw new HarnessServiceError('invalid-params', 'The source reference and snapshot identify different observations');
    if (citation) request = { ...request, snapshotId: citation.snapshotId,
      ...(!request.position && citation.startLine ? { position: { kind: 'lines', startLine: citation.startLine, ...(citation.endLine ? { endLine: citation.endLine } : {}) } as const } : {}) };
    if (request.snapshotId && invocation) {
      const retained = await options.materials.read(owner.workspaceId, request.snapshotId, owner.authority, { byteRange: { offset: 0, length: 0 }, signal,
        ...(citation?.contentHash ? { expectedContentHash: citation.contentHash } : {}) });
      if (!retained && options.documentSources?.retainMaterial) {
        const run = await options.runtime.run(invocation.runId, signal);
        if (run.thread_id !== invocation.threadId) throw new HarnessServiceError('forbidden', 'The source reader invocation changed');
        await options.documentSources.retainMaterial({ runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id }, request.snapshotId, signal);
        await options.materials.read(owner.workspaceId, request.snapshotId, owner.authority, { byteRange: { offset: 0, length: 0 }, signal,
          ...(citation?.contentHash ? { expectedContentHash: citation.contentHash } : {}) });
      }
    }
    if (request.render === true && config.web.settings?.render !== true) return Promise.resolve({ status: 'renderer-unavailable', url: request.url ?? '', reason: 'disabled' });
    const result = await options.webFetch.fetch(request, { ...context(owner, config, signal), render: request.render === true,
      allowRenderFallback: config.web.settings?.render === true,
      ...(options.alternateDocumentReader ? { alternateDocumentReader: options.alternateDocumentReader } : {}),
      ...(request.question && invocation && config.assistance && config.web.settings?.readingAssistance === true && options.assistance
        ? { selectPassages: input => options.assistance!.selectPassages(input, { invocation, configuration: config.assistance! }) } : {}) });
    if (citation && result.status === 'ok') {
      const total = result.completeness?.display.totalLines ?? result.range?.totalLines;
      if (total !== undefined && ((citation.startLine ?? 1) > total || (citation.endLine ?? 1) > total)) return { status: 'position-not-found', snapshotId: citation.snapshotId, detail: 'The citation range is outside the retained source representation' };
    }
    return sourceCitation(result);
  };
  const search = createWebSearchService<{ owner: { workspaceId: string; authority: ThreadMaterialAuthority }; config: WebConfiguration; signal: AbortSignal; invocation: ToolInvocationAuthority }>(
    async ctx => ctx.config.web.searchError ? { unavailable: true, hint: ctx.config.web.searchError }
      : resolveConfiguredSearchProvider({ settings: ctx.config.web.settings?.search,
        auth: ctx.config.web.settings?.search ? await options.readAuth() : {}, fetch: options.fetch }),
    async ctx => domains(ctx.config),
    { resolveSourcePreferences: async ctx => ctx.config.web.settings?.sourcePreferences ?? {},
      fetchUrl: (url, ctx) => fetchPage({ url }, ctx.owner, ctx.config, ctx.signal),
      selectConnection: (input, ctx) => options.assistance && ctx.config.assistance
        ? options.assistance.selectConnection(input, { invocation: ctx.invocation, configuration: ctx.config.assistance })
        : Promise.resolve({ reason: 'Search assistance is unavailable; using the configured route.' }),
    },
  );
  const inputMaterials: ThreadInputMaterials = async (identity, references, signal) => {
    const selected = parseThreadMaterials(references)!;
    const owner = await scope(identity, signal);
    const retained = [];
    for (const selectedRef of selected) {
      signal?.throwIfAborted();
      // The same material ACL that document_read uses must authorize each retained source.
      // A client-provided snapshot ID or a copied prompt never grants access.
      const found = await options.materials.read(owner.workspaceId, selectedRef.snapshotId, owner.authority,
        { byteRange: { offset: 0, length: 0 }, ...(signal ? { signal } : {}) });
      if (!found?.ref.document?.source || !(DOCUMENT_MIME_TYPES as readonly string[]).includes(found.ref.document.source.contentType)) {
        throw new HarnessServiceError('forbidden', 'The attached document is unavailable to this Thread');
      }
      retained.push(found.ref);
    }
    return retained;
  };
  const user: ThreadMaterialsAPI = {
    async collection(identity, request, signal = new AbortController().signal) {
      const fields = request?.action === 'inspect' ? ['action', 'collectionId'] : ['action', 'collectionId', 'targetThreadId', 'key'];
      if (!object(request) || !['inspect', 'share'].includes(request.action) || Object.keys(request).some(key => !fields.includes(key))
        || typeof request.collectionId !== 'string' || !request.collectionId.trim()
        || request.action === 'share' && (typeof request.targetThreadId !== 'string' || !request.targetThreadId.trim() || typeof request.key !== 'string' || !request.key.trim()))
        throw new HarnessServiceError('invalid-params', 'Select an original collection and a related recipient');
      const owner = await scope(identity, signal);
      if (!options.collections) throw new HarnessServiceError('unavailable', 'Material collections are unavailable');
      if (request.action === 'inspect') return options.collections.inspect(request.collectionId, { authority: owner.authority, signal });
      return (await options.collections.execute({ action: 'share', collectionId: request.collectionId, targetThreadId: request.targetThreadId }, {
        authority: owner.authority, signal, origin: `user-material-share:${JSON.stringify([identity.threadId, identity.branchId, request.key])}`,
        threadsRelated: async (from, to, workspace) => {
          if (from !== identity.threadId || workspace !== owner.workspaceId) return false;
          const family = await options.runtime.familyList({ callerThreadId: from, includeSelf: true }, signal);
          return threadMaterialScope(family.rootThreadId) === workspace && family.members.some(member => member.threadId === to);
        },
      })).result;
    },
    async upload(identity, request, signal = new AbortController().signal) {
      if (!object(request) || Object.keys(request).some(key => !['filename', 'mimeType', 'data'].includes(key))
        || typeof request.filename !== 'string' || !request.filename.trim() || /[\\/]/.test(request.filename)
        || [...request.filename].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || !DOCUMENT_MIME_TYPES.includes(request.mimeType) || typeof request.data !== 'string' || !request.data.length) {
        throw new HarnessServiceError('invalid-params', 'Upload a PDF, DOCX, XLSX or PPTX with its filename, MIME type and original base64 bytes');
      }
      const owner = await scope(identity, signal);
      const source = Buffer.from(request.data, 'base64');
      if (source.toString('base64') !== request.data || (request.mimeType === 'application/pdf'
        ? !source.subarray(0, 1024).includes(Buffer.from('%PDF-')) : source[0] !== 0x50 || source[1] !== 0x4b)) {
        throw new HarnessServiceError('invalid-params', 'The upload does not contain the selected document format');
      }
      const runId = owner.branch.activeRunId ?? owner.branch.latestRun?.runId;
      const launch = runId ? await options.runtime.launch(runId, signal) : null;
      const config = capture(await options.settings(launch?.selection.source ?? null));
      signal.throwIfAborted();
      const sourceHash = createHash('sha256').update(source).digest('hex');
      const captured = { source,
        sourceUrl: `thread-upload:${encodeURIComponent(identity.threadId)}/${sourceHash}/${encodeURIComponent(request.filename)}`,
        contentType: request.mimeType, title: request.filename };
      return request.mimeType === 'application/pdf'
        ? options.documentReader.ingest(captured, context(owner, config, signal), { view: 'overview' })
        : await options.alternateDocumentReader?.({ view: 'overview' }, context(owner, config, signal), captured)
          ?? { status: 'failed', url: captured.sourceUrl, reason: 'The Office document reader is unavailable' };
    },
    async read(identity, request, signal = new AbortController().signal) {
      decode('read', request);
      if (!request.snapshotId || 'path' in request || 'artifact' in request) throw new HarnessServiceError('invalid-params', 'Select a retained Thread material snapshot');
      const owner = await scope(identity, signal);
      const runId = owner.branch.activeRunId ?? owner.branch.latestRun?.runId;
      const launch = runId ? await options.runtime.launch(runId, signal) : null;
      // User reads recheck current policy; no stale tool binding comes from UI.
      const config = capture(await options.settings(launch?.selection.source ?? null));
      signal.throwIfAborted();
      let retained = await options.materials.read(owner.workspaceId, request.snapshotId, owner.authority, { byteRange: { offset: 0, length: 0 }, signal });
      if (!retained && options.documentSources?.retainMaterial) {
        await options.documentSources.retainMaterial(identity, request.snapshotId, signal);
        retained = await options.materials.read(owner.workspaceId, request.snapshotId, owner.authority, { byteRange: { offset: 0, length: 0 }, signal });
      }
      return retained?.ref.document
        ? readMaterial(request, context(owner, config, signal))
        : fetchPage(request, owner, config, signal);
    },
    async readSource(selection, request, signal = new AbortController().signal) {
      decode('read', request);
      if (!request.path || 'artifact' in request || 'snapshotId' in request) throw new HarnessServiceError('invalid-params', 'Select a document in the original Run source');
      const owner = await scope(selection, signal);
      if (!options.documentSources) throw new HarnessServiceError('unavailable', 'Source document reading is unavailable');
      const original = await options.documentSources.path(selection, request.path, signal);
      const launch = await options.runtime.launch(selection.sourceRunId, signal);
      const config = capture(await options.settings(launch?.selection.source ?? null));
      signal.throwIfAborted();
      return readMaterial(request, context(owner, config, signal), { readPath: async () => original });
    },
    async readArtifact(selection: ThreadResearchSelection, request: ThreadMaterialArtifactReadRequest, signal = new AbortController().signal) {
      decode('read', request);
      if (!request.artifact || 'path' in request || 'snapshotId' in request) throw new HarnessServiceError('invalid-params', 'Select an original experiment artifact');
      const owner = await scope(selection, signal);
      if (!options.documentSources) throw new HarnessServiceError('unavailable', 'Experiment document reading is unavailable');
      // Resolve the selected research scope before reading source-specific settings.
      // The original artifact iterator starts only when the shared reader consumes it.
      const original = await options.documentSources.artifact(selection, request.artifact, signal);
      const launch = await options.runtime.launch(selection.sourceRunId, signal);
      const config = capture(await options.settings(launch?.selection.source ?? null));
      signal.throwIfAborted();
      return readMaterial(request, context(owner, config, signal), {
        readArtifact: async () => original,
      });
    },
  };
  const capability: HostCapabilityHandler = async (method, value, call) => {
    const { selected, input } = decode(method, value);
    return runToolDomainCall(call, { domain: WEB_CAPABILITY, toolName: selected.declaration.tool!.name,
      operation: selected.declaration.tool!.operation, arguments: input }, async invocation => {
      try {
        const config = configuration(invocation.configurationIdentity);
        if (config.disabledTools.includes(invocation.toolName)) throw new HarnessServiceError('forbidden', 'This Web tool is disabled in the accepted settings');
        const owner = await invocationScope(invocation, call.signal);
        if (method === 'collections') {
          if (!options.collections) throw new HarnessServiceError('unavailable', 'Material collections are unavailable');
          const original = await options.collections.execute(input as unknown as MaterialsCollectionParams, {
            authority: owner.authority, signal: call.signal, origin: invocation.operationId,
            fetchUrl: async request => {
              const fetched = await fetchPage(request, owner, config, call.signal);
              return fetched.status === 'ok' ? { status: fetched.status, ...(fetched.snapshot ? { snapshot: fetched.snapshot } : {}), finalUrl: fetched.finalUrl,
                ...(fetched.title ? { title: fetched.title } : {}) }
                : { status: fetched.status };
            },
            threadsRelated: async (from, to, workspace) => {
              if (from !== invocation.threadId || workspace !== owner.workspaceId) return false;
              const family = await options.runtime.familyList({ callerThreadId: from, includeSelf: true }, call.signal);
              return threadMaterialScope(family.rootThreadId) === workspace && family.members.some(member => member.threadId === to);
            },
          });
          return { executor_stopped: true, completion: { kind: 'result',
            outcome: original.result.status === 'ok' ? 'succeeded' : 'failed', effect: original.effect,
            content: { data: parseVarinToolJson(original.result), parts: [] } } };
        }
        let result = method === 'search' ? await search.handle(input as WebSearchRequest, { owner, config, signal: call.signal, invocation })
          : method === 'fetch' ? await fetchPage(input as WebFetchRequest, owner, config, call.signal, invocation)
            : await readMaterial(input as unknown as DocumentReadRequest,
              context(owner, config, call.signal), options.documentSources?.tool(invocation));
        if ('items' in result) {
          // Retain each actual observation before projecting it. A failed material
          // write must not discard a completed search or claim a readable source.
          for (const item of result.items) {
            if (item.fetch) item.fetch = sourceCitation(item.fetch);
            for (const hit of item.results ?? []) {
              if (call.signal.aborted) break;
              try { hit.source = await captureSearchSource(options.materials, hit, owner.authority, {
                providerId: item.providerId ?? result.providerId, ...(item.connectionId ? { connectionId: item.connectionId } : {}),
                ...(item.query ? { query: item.query } : {}), ...((item.objective ?? result.objective) ? { objective: (item.objective ?? result.objective)! } : {}), operationId: invocation.operationId,
              }, call.signal); } catch { hit.sourceError = 'The source observation could not be retained; the search result remains available.'; }
            }
          }
          const searchResult = result;
          if (searchResult.results) searchResult.results = searchResult.results.map(hit => {
            const observed = searchResult.items.flatMap(item => item.results ?? []).find(item => item.url === hit.url && item.snippet === hit.snippet);
            return observed?.source ? { ...hit, source: observed.source } : hit;
          });
        } else result = sourceCitation(result);
        if (call.signal.aborted) return { executor_stopped: true, completion: { kind: 'result', outcome: 'cancelled', effect: 'none', content: webOutput(result) } };
        const attachments: OutputPart<IncomingMedia>[] = [];
        const snapshots = new Set<string>();
        const include = (value: FetchResult) => { if (value.status === 'ok') {
          if (value.snapshot) snapshots.add(value.snapshot.snapshotId);
          if (value.sourceSnapshot) snapshots.add(value.sourceSnapshot.snapshotId);
        } };
        if ('items' in result) for (const item of result.items) {
          if (item.fetch) include(item.fetch);
          for (const hit of item.results ?? []) if (hit.source) snapshots.add(hit.source.snapshot.snapshotId);
        } else include(result);
        if (options.documentSources) for (const snapshotId of snapshots) {
          try {
            const attachment = await options.documentSources.attachment(invocation, snapshotId, call.signal);
            if (attachment) {
              attachments.push({ kind: 'attachment', attachment });
              if ('items' in result) for (const item of result.items) for (const hit of item.results ?? []) if (hit.source?.snapshot.snapshotId === snapshotId) hit.source.deliveryStatus = 'ready';
            }
          } catch {
            const detail = 'Source delivery could not be prepared. The retained citation remains readable in this Thread; include its varin-material URL in typed attachments to retry explicit sharing.';
            if ('items' in result) for (const item of result.items) for (const hit of item.results ?? []) if (hit.source?.snapshot.snapshotId === snapshotId) hit.source.deliveryStatus = 'unavailable';
            if ('items' in result) result.notices = [...(result.notices ?? []), detail];
            else if (result.status === 'ok') result = { ...result, detail: [result.detail, detail].filter(Boolean).join(' ') };
          }
        }
        const completed = receipt(result);
        if (completed.completion.kind === 'result') {
          completed.completion.content.parts.push(...attachments);
          if (call.signal.aborted) completed.completion.outcome = 'cancelled';
        }
        return completed;
      } catch (error) {
        if (error instanceof WebAssistanceIndeterminateError) return { executor_stopped: false, completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
          content: { data: { status: 'unavailable', error: error.message, code: 'assistance-indeterminate' }, parts: [] } } };
        if (error instanceof MaterialCollectionMutationError) return { executor_stopped: error.effect !== 'unknown',
          completion: { kind: 'result', outcome: error.effect === 'unknown' ? 'indeterminate' : 'failed', effect: error.effect,
            content: { data: { status: 'failed', error: error.message }, parts: [] } } };
        // Owners await their own material commits and the last shared producer.
        // This callback's settlement is actual drain, not an observer abort race.
        return { executor_stopped: true, completion: { kind: 'result', outcome: call.signal.aborted ? 'cancelled' : 'failed', effect: 'none',
          content: { data: { status: call.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error),
            ...(error instanceof HarnessServiceError ? { code: error.harnessCode } : {}) }, parts: [] } } };
      }
    });
  };
  const prepareConfiguration = async (run: ExtensionToolRun, required: readonly ExtensionToolBinding[], previous?: ExtensionToolConfiguration): Promise<ExtensionToolConfiguration> => {
    // Recovery keeps the exact credential-free accepted configuration. Credentials
    // are resolved from their current owner at the actual search dispatch.
    const captured = required.length ? null : await options.settings(run.source).then(async snapshot => {
      const value = capture(snapshot);
      return { ...value, version: 2 as const, ...(options.assistance ? { assistance: await options.assistance.capture(snapshot.global.harness) } : {}) };
    }).then(
      value => ({ value }), error => ({ error }),
    );
    return extendToolConfiguration(previous, (descriptor, original) => {
      if (!WEB_TOOL_DECLARATIONS.some(value => value.id === descriptor.id && value.version === descriptor.version)) return previous?.(descriptor, original) ?? original ?? null;
      if (original !== undefined) { configuration(original); return original; }
      if (!captured) throw new Error('The original Web configuration was not retained');
      if ('error' in captured) throw captured.error;
      return JSON.stringify(captured.value);
    }, descriptor => {
      if (!WEB_TOOL_DECLARATIONS.some(value => value.id === descriptor.id && value.version === descriptor.version)) return undefined;
      if (!captured || 'error' in captured) return undefined;
      if (captured.value.disabledTools.includes(descriptor.tool!.name)) return false;
      // Missing search settings means the product-provided anonymous route.
      // Explicit disabling and invalid assets must never turn into that default.
      const search = captured.value.web.settings?.search;
      const configured = search === undefined ? undefined : parseHarnessWebSearchSettings(search);
      return descriptor.tool!.name !== 'websearch' || (!captured.value.web.searchError
        && (configured === undefined || Boolean(configured && configured.enabled !== false && configured.connections.some(connection => connection.enabled))));
    });
  };
  const snapshotCapability = createMaterialToolOwner(options.materials, async (invocation, signal) => (await invocationScope(invocation, signal)).authority);
  const retainScholarlySources = async (invocation: ToolInvocationAuthority, papers: ScholarlyPaper[], signal: AbortSignal) => {
    const owner = await invocationScope(invocation, signal);
    const parts: OutputPart<IncomingMedia>[] = [];
    for (const paper of papers) {
      if (signal.aborted) break;
      try {
        paper.source = await captureScholarlySource(options.materials, paper, owner.authority, invocation.operationId, signal);
        const attachment = await options.documentSources?.attachment(invocation, paper.source.snapshot.snapshotId, signal);
        if (attachment) { parts.push({ kind: 'attachment', attachment }); paper.source.deliveryStatus = 'ready'; }
      } catch {
        if (paper.source) paper.source.deliveryStatus = 'unavailable';
        paper.sourceError = 'The metadata result remains available, but its retained source or typed delivery could not be prepared.';
      }
    }
    return parts;
  };
  return { user, capability, prepareConfiguration, snapshotCapability, inputMaterials, retainScholarlySources, close: () => search.dispose() };
}
