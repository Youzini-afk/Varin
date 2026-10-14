import type { AgentSettingsSnapshot } from '@varin/application-client';
/** Native invocation and public-reader adapters into the existing Web/material owners. */
import { isDeepStrictEqual } from 'node:util';
import type { ThreadIdentity, ThreadMaterialsAPI, ThreadMaterialArtifactReadRequest, ThreadResearchSelection } from '@varin/application-client';
import { WEB_CAPABILITY, WEB_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { compileToolJsonSchema } from '../models/schema.js';
import {
  resolveHarnessDocumentReadingSettings,
  type DocumentReadRequest, type FetchResult, type HarnessDocumentReadingSettings, type HarnessWebDomainPolicy,
  type WebFetchRequest, type WebSearchRequest, type WebSearchResult,
  type MaterialsCollectionParams,
} from '@varin/protocol';
import type { DocumentReader, DocumentReaderContext } from '../harness/document-reading.js';
import { readDocumentMaterial } from '../harness/document-material.js';
import { resolveHarnessWebBinding, resolveHarnessMaterialWebPolicy, type HarnessWebBinding } from '../harness/harness-web-settings.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { createWebFetch } from '../harness/web-fetch.js';
import type { ThreadMaterialAuthority, WebMaterialStore } from '../harness/web-materials.js';
import { createWebSearchService, parseSearchProviderSettings, resolveConfiguredSearchProvider } from '../harness/web-search.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExtensionToolConfiguration, ExtensionToolRun } from './extension-tool-owner.js';
import { createMaterialToolOwner } from './material-tool-owner.js';
import { threadMaterialScope } from './material-storage.js';
import type { ExtensionToolBinding, LaunchSource, OutputBody, IncomingMedia, OutputPart } from './protocol.generated.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { DocumentSources } from './document-sources.js';
import { MaterialCollectionMutationError, type createMaterialCollections } from '../harness/material-collections.js';

export { WEB_CAPABILITY };
const declarations = new Map(WEB_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.web.'.length),
  { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
interface WebConfiguration {
  version: 1;
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
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'web', 'documentReading', 'disabledTools'].includes(key))
    || !object(value.web) || typeof value.web.generation !== 'string' || !object(value.web.settings)
    || !object(value.web.settings.domains) || !strings(value.web.settings.domains.block)
    || value.web.settings.domains.allow !== undefined && !strings(value.web.settings.domains.allow)
    || value.web.settings.render !== undefined && typeof value.web.settings.render !== 'boolean'
    || value.web.settings.search !== undefined && !parseSearchProviderSettings(value.web.settings.search)
    || value.web.searchError !== undefined && typeof value.web.searchError !== 'string'
    || !strings(value.disabledTools)) throw invalid();
  const documentReading = resolveHarnessDocumentReadingSettings(value.documentReading);
  if (!isDeepStrictEqual(documentReading, value.documentReading)) throw invalid();
  return { version: 1, web: value.web as unknown as HarnessWebBinding, documentReading, disabledTools: value.disabledTools };
}
function decode(method: string, value: unknown) {
  const selected = declarations.get(method);
  if (!selected || !selected.validate(value)) throw new HarnessServiceError('invalid-params',
    'Arguments do not match the Web capability. Select exactly one document source; a reader-model prompt is unsupported.');
  return { selected, input: parseVarinToolJson(value) };
}

/** Only the original producer knows which fields carry pixels. Keep all other
 * domain metadata intact, including unknown/partial errors and source identity. */
export function webOutput(result: FetchResult | WebSearchResult): OutputBody<IncomingMedia> {
  const parts: OutputPart<IncomingMedia>[] = [];
  const project = (value: FetchResult): unknown => {
    if (value.status !== 'ok') return value;
    const { pageImage, pageImages, ...metadata } = value;
    const images = new Map<string, number>();
    const image = (value: NonNullable<Extract<FetchResult, { status: 'ok' }>['pageImage']>) => {
      const { data, ...imageMetadata } = value;
      const key = `${value.mimeType}:${data}`;
      const partIndex = images.get(key) ?? parts.length;
      if (!images.has(key)) { parts.push({ kind: 'media', media: { media_type: value.mimeType, data_base64: data } }); images.set(key, partIndex); }
      return { ...imageMetadata, partIndex };
    };
    return { ...metadata, ...(pageImage ? { pageImage: image(pageImage) } : {}),
      ...(pageImages ? { pageImages: pageImages.map(image) } : {}) };
  };
  const data = 'items' in result
    ? { ...result, items: result.items.map(item => item.fetch ? { ...item, fetch: project(item.fetch) } : item) }
    : project(result);
  return { data: parseVarinToolJson(data), parts };
}
function receipt(value: FetchResult | WebSearchResult): ToolExecutionReceipt {
  const successful = 'items' in value ? value.items.some(item => ['ok', 'empty', 'partial'].includes(item.status))
    : value.status === 'ok' || value.status === 'redirect-cross-host';
  return { executor_stopped: true, completion: { kind: 'result', outcome: successful ? 'succeeded' : 'failed', effect: 'none', content: webOutput(value) } };
}

export interface WebRuntimeOptions {
  runtime: Pick<AgentRuntimeClient, 'familyList' | 'run' | 'launch'>;
  webFetch: ReturnType<typeof createWebFetch>;
  documentReader: DocumentReader;
  documentSources?: DocumentSources;
  materials: WebMaterialStore;
  collections?: ReturnType<typeof createMaterialCollections>;
  fetch: typeof globalThis.fetch;
  readAuth(): unknown | Promise<unknown>;
  /** Read current user/trusted-project assets, without opening a Pi AgentSession. */
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
}
export function createWebRuntime(options: WebRuntimeOptions) {
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
  const fetchPage = (request: WebFetchRequest, owner: { workspaceId: string; authority: ThreadMaterialAuthority }, config: WebConfiguration, signal: AbortSignal): Promise<FetchResult> => {
    if (request.render === true && config.web.settings?.render !== true) return Promise.resolve({ status: 'renderer-unavailable', url: request.url ?? '', reason: 'disabled' });
    return options.webFetch.fetch(request, { ...context(owner, config, signal), render: request.render === true, issueReceipt: false });
  };
  const search = createWebSearchService<{ owner: { workspaceId: string; authority: ThreadMaterialAuthority }; config: WebConfiguration; signal: AbortSignal }>(
    async ctx => ctx.config.web.searchError ? { unavailable: true, hint: ctx.config.web.searchError }
      : resolveConfiguredSearchProvider({ settings: ctx.config.web.settings?.search,
        auth: ctx.config.web.settings?.search ? await options.readAuth() : {}, fetch: options.fetch }),
    async ctx => domains(ctx.config),
    { fetchUrl: (url, ctx) => fetchPage({ url }, ctx.owner, ctx.config, ctx.signal) },
  );
  const user: ThreadMaterialsAPI = {
    async read(identity, request, signal = new AbortController().signal) {
      decode('read', request);
      if (!request.snapshotId || 'path' in request || 'artifact' in request) throw new HarnessServiceError('invalid-params', 'Select a retained Thread material snapshot');
      const owner = await scope(identity, signal);
      const runId = owner.branch.activeRunId ?? owner.branch.latestRun?.runId;
      const launch = runId ? await options.runtime.launch(runId, signal) : null;
      // User reads recheck current policy; no stale tool binding comes from UI.
      const config = capture(await options.settings(launch?.selection.source ?? null));
      signal.throwIfAborted();
      return options.documentReader.read(request, context(owner, config, signal));
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
      return readDocumentMaterial(options.documentReader, request, context(owner, config, signal), { readPath: async () => original });
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
      return readDocumentMaterial(options.documentReader, request, context(owner, config, signal), {
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
        const result = method === 'search' ? await search.handle(input as WebSearchRequest, { owner, config, signal: call.signal })
          : method === 'fetch' ? await fetchPage(input as WebFetchRequest, owner, config, call.signal)
            : await readDocumentMaterial(options.documentReader, input as unknown as DocumentReadRequest,
              context(owner, config, call.signal), options.documentSources?.tool(invocation));
        if (call.signal.aborted) return { executor_stopped: true, completion: { kind: 'result', outcome: 'cancelled', effect: 'none', content: webOutput(result) } };
        return receipt(result);
      } catch (error) {
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
    const captured = required.length ? null : await options.settings(run.source).then(capture).then(
      value => ({ value }), error => ({ error }),
    );
    return (descriptor, original) => {
      if (!WEB_TOOL_DECLARATIONS.some(value => value.id === descriptor.id && value.version === descriptor.version)) return previous?.(descriptor, original) ?? original ?? null;
      if (original !== undefined) { configuration(original); return original; }
      if (!captured) throw new Error('The original Web configuration was not retained');
      if ('error' in captured) throw captured.error;
      return JSON.stringify(captured.value);
    };
  };
  const snapshotCapability = createMaterialToolOwner(options.materials, async (invocation, signal) => (await invocationScope(invocation, signal)).authority);
  const decisionMaterials = async (invocation: ToolInvocationAuthority, signal: AbortSignal) => {
    const owner = await invocationScope(invocation, signal);
    const retained = new Map<string, string>();
    return { authority: owner.authority,
      readCandidateText: async (request: { snapshotId: string; startLine?: number; endLine?: number }, authority: import('../harness/web-materials.js').WebSnapshotReadAuthority, readSignal: AbortSignal) => {
        if (!isDeepStrictEqual(authority, owner.authority)) throw new HarnessServiceError('forbidden', 'Original decision material authority changed');
        const domainPolicy = resolveHarnessMaterialWebPolicy(await options.settings(invocation.source));
        const result = await options.webFetch.fetch({ snapshotId: request.snapshotId, view: 'text',
          ...(request.startLine === undefined ? {} : { position: { kind: 'lines' as const, startLine: request.startLine, ...(request.endLine === undefined ? {} : { endLine: request.endLine }) } }) }, { workspaceId: owner.workspaceId, authority: owner.authority, signal: readSignal, domainPolicy, issueReceipt: false });
        if (result.status === 'ok' && result.snapshot) {
          retained.set(result.snapshot.snapshotId, result.snapshot.contentHash);
          if (result.snapshot.snapshotId !== request.snapshotId) {
            const original = await options.materials.read(owner.workspaceId, request.snapshotId, owner.authority, {
              byteRange: { offset: 0, length: 0 }, signal: readSignal,
            });
            if (!original) throw new HarnessServiceError('forbidden', 'The original decision candidate is no longer readable');
            retained.set(request.snapshotId, original.ref.contentHash);
          }
        }
        return result;
      },
      assertReadable: async () => {
        for (const [snapshotId, contentHash] of retained) {
          const result = await options.materials.read(owner.workspaceId, snapshotId, owner.authority, {
            byteRange: { offset: 0, length: 0 }, expectedContentHash: contentHash, signal,
          });
          if (!result) throw new HarnessServiceError('forbidden', 'A decision material is no longer readable under this Thread authority');
        }
      },
    };
  };
  return { user, capability, prepareConfiguration, snapshotCapability, decisionMaterials };
}
