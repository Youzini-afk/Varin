import { McpAuthorityError, McpTaskRequestError, McpSamplingRejectedError } from './mcp-errors.js';
/** Shared Application Host MCP authority. Pi and native runtimes lease these same connections. */
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ValidateFunction } from 'ajv';
import { compileToolJsonSchema } from './tool-schema.js';
import { applyEdits, modify } from 'jsonc-parser';
import {
  FileAuthStorageBackend, McpOAuthCredentialStore, createMcpToolName, getMcpToolExposure,
  loadMcpConfig, loadMcpRuntime, validateMcpServerConfig,
  type LoadedMcpConfig, type McpServerConnection, type McpServerEntry, type McpTransportFactory,
  type McpSignInPrompt,
} from '@earendil-works/pi-coding-agent';
import type { McpOwnerConfig, McpOwnerConnectionSnapshot, McpOwnerEntry, McpServerOwner, McpProvenance, SourceResourceOwner } from '@varin/protocol';
import { ConfigTextFileEditor, resolveConfigDocumentPath } from './config-text-file-editor.js';
import { ConfigWatchManager } from './config-watch-manager.js';
import { McpSessionExpiredError, McpError, type McpClient, type McpRequestOptions, type McpRequestHandlerContext } from '@earendil-works/pi-mcp';
export { StdioTransport, StreamableHttpTransport, McpMessageTooLargeError, McpConnectionClosedError, parseJsonRpcMessage } from '@earendil-works/pi-mcp';
export type { StdioTransportOptions, McpTransport, JsonRpcMessage } from '@earendil-works/pi-mcp';
import { serviceKind, validateServiceResult, validatePromptArguments, type McpAuthorityService, type McpAuthorityPrompt, type McpPromptDeclaration, type McpServiceKind, type McpServiceRequest, type McpServiceResult } from './mcp-native-protocol.js';
import { taskCapabilities, taskSupport, requiresMcpTask, validateTaskResponse, validateTaskResult, object as taskObject, type McpTaskLease, type McpEndpoint, type McpTaskSupport, type McpTaskResponse } from './mcp-tasks.js';
import { decodeElicitationRequest, decodeUrlElicitationError } from './mcp-interactions.js';
export { decodeElicitationRequest, validateElicitationResponse, decodeUrlElicitationError } from './mcp-interactions.js';
import type { ExecutorOwner, McpInteractionBinding, McpElicitationResponse, McpElicitationPresentation } from '@varin/protocol';
import type { McpResourceChange, McpResourceObserver, McpResourceRelease } from './mcp-resources.js';
export type { McpResourceChange, McpResourceObserver, McpResourceCleanup, McpResourceRelease } from './mcp-resources.js';
export { requiresMcpTask } from './mcp-tasks.js';
export type { McpTaskLease, McpEndpoint, McpTaskResponse } from './mcp-tasks.js';
export type { McpAuthorityService, McpAuthorityPrompt, McpServiceKind, McpServiceRequest, McpServiceResult } from './mcp-native-protocol.js';

export interface McpAuthorityScope {
  /** Actual configuration/transport authority; supplied by the trusted host. */
  resourceOwner: SourceResourceOwner;
  /** Original managed Source permit, absent for local scopes. */
  sourceAuthority?: NonNullable<McpServerOwner['source_authority']>;
  /** Closed contribution selection; omitted for the Host's ordinary combined scope. */
  configurationScopes?: readonly ('global' | 'project' | 'extension')[];
  agentDir: string;
  /** Admitted original project location. Never a materialized work branch. */
  configCwd: string;
  /** Actual stdio process cwd, including an isolated materialized work branch when applicable. */
  executionCwd: string;
  environmentId: string;
  executionScope: 'global' | 'workspace';
  projectTrusted: boolean;
  sessionId: string;
}
export interface McpInteractionOrigin { operationId: string; executionOwner: ExecutorOwner }
export interface McpInteractionRequest {
  binding: McpInteractionBinding;
  request: Record<string, unknown>;
  signal: AbortSignal;
  assertLive(): Promise<void>;
  beforeResponse: McpRequestHandlerContext['beforeResponse'];
  onResponseSettled: McpRequestHandlerContext['onResponseSettled'];
  onComplete(callback: () => void, unavailable?: () => void): () => void;
}
export type McpInteractionReceiver = (request: McpInteractionRequest) => Promise<McpElicitationResponse>;
export { McpSamplingRejectedError } from './mcp-errors.js';
export type McpSamplingReceiver = (request: McpInteractionRequest) => Promise<import("@varin/protocol").McpSamplingResult>;
export interface McpErrorInteractionItem {
  binding: McpInteractionBinding;
  presentation: Extract<McpElicitationPresentation, {mode: 'url'}>;
  signal: AbortSignal;
  assertLive(): Promise<void>;
  onComplete(callback: () => void, unavailable?: () => void): () => void;
}
export interface McpErrorInteraction {
  /** Complete original error body, shared by all of this response's URLs. */
  request: Record<string, unknown>;
  items: McpErrorInteractionItem[];
}
export type McpErrorInteractionReceiver = (error: McpErrorInteraction) => void;

export interface McpAuthorityOptions {
  interactions?: (request: McpInteractionRequest, scope: McpAuthorityScope) => ReturnType<McpInteractionReceiver>;
  sampling?: (request: McpInteractionRequest, scope: McpAuthorityScope) => ReturnType<McpSamplingReceiver>;
  interactionErrors?: (error: McpErrorInteraction, scope: McpAuthorityScope) => void;
  providerToken?: (scope: McpAuthorityScope, provider: string) => Promise<string | undefined>;
  credentialScope?: (scope: McpAuthorityScope, provider: string) => Promise<{
    reference: string; generation: number; authority?: string; account?: string;
  }>;
  /** Test/embedding transport seam. Production defaults to the SDK's stdio/HTTP transports. */
  createTransport?: McpTransportFactory;
  /** Trusted Host adapter over the SDK's not-yet-started transport for this exact scope. */
  adaptTransport?: (scope: McpAuthorityScope, transport: ReturnType<McpTransportFactory>) => ReturnType<McpTransportFactory>;
}
export interface McpAuthorityTool {
  name: string;
  server: string;
  tool: string;
  schemaVersion: string;
  taskSupport: McpTaskSupport;
  taskCapable: boolean;
  resourceKey: string;
  configurationScope: 'global' | 'project' | 'extension';
  executionScope: 'global' | 'workspace';
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  description: string;
  exposure: 'direct' | 'codemode' | 'deferred';
  /** Remote annotations are descriptive only; authorization always classifies MCP as unknown. */
  annotations?: Record<string, unknown>;
}
export interface McpAuthorityServerReadiness {
  name: string;
  description: string;
  resourceKey: string;
  hasDirectTools: boolean;
  exposure: 'direct' | 'codemode' | 'deferred' | 'hidden';
  configurationScope: 'global' | 'project' | 'extension';
  executionScope: 'global' | 'workspace';
  status: 'disabled' | 'unprepared' | 'connecting' | 'connected' | 'disconnected' | 'needs-auth' | 'failed' | 'closed' | 'stale';
  cachedToolCount: number;
  connectedToolCount: number;
  selected: boolean;
}
export interface McpAuthorityInspection {
  configErrorCount: number;
  configuredServerCount: number;
  connectedServerCount: number;
  cachedToolCount: number;
  servers: readonly McpAuthorityServerReadiness[];
}
export interface McpAuthorityAcquireOptions {
  /** Deliberate dependency selection. Empty means no MCP dependency; never connect all implicitly. */
  servers: readonly string[];
  /** Frozen owner and configuration dependencies, checked before opening any selected transport.
   * Execution location remains the new scope's own authority. */
  provenance?: McpProvenance;
  signal?: AbortSignal;
}
export interface McpAuthorityBinding {
  provenance: McpProvenance;
  reference: string;
  generation: number;
  tools: readonly McpAuthorityTool[];
  readiness: McpAuthorityInspection;
  servers: readonly McpAuthorityServerReadiness[];
  serverSelections: readonly { name: string; configurationVersion: string; hiddenTools: readonly string[] }[];
}
export type McpChange = { kind: 'configuration' | 'credentials' } | { kind: 'tools'; server: string };
export interface McpAuthorityLease {
  readonly binding: McpAuthorityBinding;
  readonly implementationIdentity: string;
  inspect(): McpAuthorityInspection;
  /** Explicit scoped discovery; no other configured server is started. */
  discover(server: string, signal: AbortSignal): Promise<readonly McpAuthorityTool[]>;
  /** Rebind a persisted concrete target only when the exact expected declaration is still present. */
  prepareTool(server: string, tool: string, schemaVersion: string, signal: AbortSignal): Promise<McpAuthorityTool>;
  discoverServices(server: string, signal: AbortSignal): Promise<readonly McpAuthorityService[]>;
  prepareService(server: string, kind: McpServiceKind, schemaVersion: string, signal: AbortSignal): Promise<McpAuthorityService>;
  preparePrompt(server: string, name: string, schemaVersion: string, signal: AbortSignal): Promise<McpAuthorityPrompt>;
  assertService(service: McpAuthorityService): void;
  serviceRevocationSignal(service: McpAuthorityService): AbortSignal;
  validateServiceRequest(service: McpAuthorityService, request: McpServiceRequest): void;
  requestService(service: McpAuthorityService, request: McpServiceRequest, options: { signal: AbortSignal; beforeDispatch?: () => void | Promise<void>; interaction?: McpInteractionOrigin }): Promise<McpServiceResult>;
  assertCallable(name: string, schemaVersion: string): void;
  revocationSignal(name: string, schemaVersion: string): AbortSignal;
  validateArguments(name: string, schemaVersion: string, arguments_: unknown): void;
  callTool(name: string, arguments_: Record<string, unknown>, options: { schemaVersion: string; signal: AbortSignal; beforeDispatch?: () => void | Promise<void>; interaction?: McpInteractionOrigin }): ReturnType<McpServerConnection['callTool']>;
  resourceEndpoint(service:McpAuthorityService):McpEndpoint;
  observeResource(service:McpAuthorityService, uri:string, options:{signal:AbortSignal;beforeDispatch?:()=>void|Promise<void>;onChange:(change:McpResourceChange)=>void;interaction?:McpInteractionOrigin}):Promise<McpResourceObserver>;
  /** Original operation identity for retaining execution authority before Task dispatch. */
  taskOwner(server: string, endpoint: McpEndpoint | undefined, signal: AbortSignal, origin?: McpInteractionOrigin): Promise<McpTaskLease>;
  release(): void;
}
/** Authority-owned scope drainage, distinct from a composed snapshot's reference release. */
export interface McpAuthorityOwnedLease extends McpAuthorityLease {
  /** Wait for this scope's preparations, retained holders and last-reference SDK closes.
   * SDK settlement is not a Storage native process-tree stop receipt. */
  releaseAndDrain(): Promise<void>;
}
interface Drain {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
function drain(): Drain {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  // Ordinary release remains fire-and-forget. Keep the original outcome for explicit drainage.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export { McpAuthorityError, McpTaskRequestError } from './mcp-errors.js';
type ConfigPatch = { enabled?: boolean; exposure?: 'direct' | 'codemode' | 'deferred' | 'hidden' };
interface SourceWatch { keys: Set<string>; ready: Promise<string> }
type McpTool = McpServerConnection['tools'][number];
interface ScopeRecord {
  handle: string;
  scope: McpAuthorityScope;
  key: string;
  config: LoadedMcpConfig;
  configRevision: string;
  entries: Map<string, McpServerEntry>;
  definitions: Map<string, string>;
  connections: Map<string, ConnectionRecord>;
  released: boolean;
  inflight: number;
  preparations: number;
  closings: Set<Promise<void>>;
  drain: Drain;
  closeError?: unknown;
  retainedHolders: number;
  closeRequested: boolean;
  shutdown: AbortController;
}
interface ResourceHolder { active:boolean; scope:ScopeRecord; change:(change:McpResourceChange)=>void }
interface ResourceGroup { client:McpClient; uri:string; holders:Set<ResourceHolder>; acknowledgement:Promise<Record<string,unknown>>; subscribed:boolean; receivedResponse:boolean; protocolError?:Record<string,unknown>; interactionProblem?:string; closing?:Promise<McpResourceRelease> }
interface InteractionHolder { scope: ScopeRecord; origin: McpInteractionOrigin; controller: AbortController }
interface ConnectionRecord {
  clientId?: string;
  rpcInteractions: Map<string | number, InteractionHolder>;
  taskInteractions: Map<string, Set<InteractionHolder>>;
  elicitationComplete: Map<string, {kind:'active';complete():void;invalidate():void} | {kind:'ambiguous'}>;
  completionDisposers: Set<() => void>;
  handle: string;
  generation: number;
  key: string;
  configIdentity: string;
  scopeKey: string;
  scope: McpAuthorityScope;
  entry: McpServerEntry;
  connection: McpServerConnection;
  references: number;
  retired: boolean;
  revoked: boolean;
  revocationReason?: string;
  shutdown: AbortController;
  ready?: Promise<void>;
  closing?: Promise<void>;
  credentialRevision: number;
  oauthGrant: string;
  provider: string | undefined;
  providerGrant: string | undefined;
  tokenObservation?: string;
  validators: Map<string, ValidateFunction>;
  declarations?: string;
  nativeClient?: McpClient;
  prompts: Map<string, McpPromptDeclaration>;
  promptRevision: number;
  taskListeners: Set<(taskId:string, unsupported?:boolean)=>void>;
  resourceGroups:Map<string,ResourceGroup>;
  nativeDisposers:Array<()=>void>;
}
function fail(code: string): never { throw new McpAuthorityError(code); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function publicEntry(entry: McpServerEntry): McpOwnerEntry {
  // Transport configuration/credentials stay with their owner. Pi only needs presentation/exposure.
  const config = entry.config;
  const common = { enabled: config.enabled, exposure: config.exposure, toolExposure: config.toolExposure,
    description: config.description, timeout: config.timeout };
  let transport: Record<string, unknown>;
  if ('url' in config) {
    const url = new URL(config.url); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    transport = { url: url.toString() };
  } else transport = { command: config.command };
  return { name: entry.name, source: entry.source, ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.override ? { override: entry.override } : {}), config: { ...common, ...transport } };
}
function normalizeScope(input: McpAuthorityScope): McpAuthorityScope {
  if (!input.agentDir || !input.configCwd || !input.executionCwd || !input.environmentId || !input.sessionId) fail('mcp-scope-invalid');
  if (!input.resourceOwner || (input.resourceOwner.kind !== 'local' && (input.resourceOwner.kind !== 'managed_host'
    || !input.resourceOwner.hostId || !input.resourceOwner.connectionId || !input.resourceOwner.endpointIdentity))) fail('mcp-scope-invalid');
  if (input.configurationScopes?.some(scope => !['global', 'project', 'extension'].includes(scope))) fail('mcp-scope-invalid');
  return { ...input, ...(input.configurationScopes ? { configurationScopes: Object.freeze([...new Set(input.configurationScopes)].sort()) } : {}), resourceOwner: freeze(structuredClone(input.resourceOwner)), agentDir: resolve(input.agentDir), configCwd: resolve(input.configCwd), executionCwd: resolve(input.executionCwd) };
}
function scopeKey(scope: McpAuthorityScope): string {
  return stable([scope.resourceOwner, scope.sourceAuthority ?? null, scope.configurationScopes ?? null, scope.agentDir, scope.configCwd, scope.executionCwd, scope.environmentId, scope.executionScope, scope.projectTrusted]);
}
function configuration(scope: McpAuthorityScope): McpServerOwner['configuration'] {
  return { agent_dir: scope.agentDir, config_cwd: scope.configCwd, project_trusted: scope.projectTrusted };
}
function serverOwner(scope: McpAuthorityScope): McpServerOwner {
  return { resource_owner: scope.resourceOwner, source_authority: scope.sourceAuthority ?? null, configuration: configuration(scope), execution_scope: scope.executionScope };
}
function compile(tool: McpTool): ValidateFunction {
  try { return compileToolJsonSchema(tool.inputSchema); }
  catch { return fail('mcp-schema-unsupported'); }
}

export class McpAuthority {
  readonly #options: McpAuthorityOptions;
  readonly #scopes = new Map<string, ScopeRecord>();
  readonly #pool = new Map<string, ConnectionRecord>();
  readonly #closings = new Set<Promise<void>>();
  readonly #selected = new Map<string, ConnectionRecord>();
  readonly #credentials = new Map<string, McpOAuthCredentialStore>();
  readonly #observations = new Map<string, { status: McpAuthorityServerReadiness['status']; toolCount: number }>();
  readonly #subscribers = new Map<string, { scope: McpAuthorityScope; listeners: Set<(change: McpChange) => void>; files: string[] }>();
  readonly #fileWatches = new Map<string, SourceWatch>();
  readonly #configWatches = new ConfigWatchManager(subscription => {
    if (subscription.target.kind !== 'document') return;
    for (const key of this.#fileWatches.get(subscription.target.path)?.keys ?? []) this.#changed(key,
      { kind: subscription.target.path === join(this.#subscribers.get(key)!.scope.agentDir, 'mcp-auth.json') ? 'credentials' : 'configuration' });
  });
  #generation = 0;
  #closed = false;
  constructor(options: McpAuthorityOptions = {}) { this.#options = options; }

  /** Subscribers share watches for the actual configuration sources; no per-request probes. */
  async subscribe(input: McpAuthorityScope, listener: (change: McpChange) => void): Promise<() => void> {
    if (this.#closed) fail('mcp-owner-closed');
    const scope = normalizeScope(input); const key = scopeKey(scope);
    let group = this.#subscribers.get(key);
    if (!group) {
      const files = [join(scope.agentDir, 'mcp.json'), join(scope.agentDir, 'mcp-auth.json'),
        ...(scope.projectTrusted ? [join(scope.configCwd, '.pi/mcp.json')] : [])];
      group = { scope, listeners: new Set(), files };
      this.#subscribers.set(key, group);
      for (const file of files) {
        let entry = this.#fileWatches.get(file);
        if (!entry) {
          const owned: SourceWatch = { keys: new Set(),
            ready: this.#configWatches.watch({ kind: 'document', path: file, scope: 'global' }, [file]).then(subscription => {
              if (this.#closed || this.#fileWatches.get(file) !== owned) this.#configWatches.unwatch(subscription.watchId);
              return subscription.watchId;
            }) };
          entry = owned;
          this.#fileWatches.set(file, entry);
        }
        entry.keys.add(key);
      }
    }
    group.listeners.add(listener);
    let released = false;
    const release = () => {
      if (released) return; released = true;
      group!.listeners.delete(listener);
      if (group!.listeners.size || this.#subscribers.get(key) !== group) return;
      this.#subscribers.delete(key);
      for (const file of group!.files) {
        const watch = this.#fileWatches.get(file); watch?.keys.delete(key);
        if (watch && !watch.keys.size) {
          this.#fileWatches.delete(file);
          void watch.ready.then(id => { this.#configWatches.unwatch(id); }, () => undefined);
        }
      }
    };
    try { await Promise.all(group.files.map(file => this.#fileWatches.get(file)!.ready)); }
    catch (error) { release(); throw error; }
    if (this.#closed) { release(); fail('mcp-owner-closed'); }
    return release;
  }
  #changed(key: string, change: McpChange = { kind: 'configuration' }): void {
    queueMicrotask(() => {
      if (this.#closed) return;
      for (const listener of this.#subscribers.get(key)?.listeners ?? []) { try { listener(change); } catch { /* Observers cannot interrupt the authority. */ } }
    });
  }

  open(input: McpAuthorityScope): { scope: string; config: McpOwnerConfig } {
    if (this.#closed) fail('mcp-owner-closed');
    const scope = normalizeScope(input);
    const key = scopeKey(scope);
    const configRevision = this.#configRevision(scope);
    const loaded = loadMcpConfig({ agentDir: scope.agentDir, cwd: scope.configCwd, projectTrusted: scope.projectTrusted });
    const config = scope.configurationScopes ? { ...loaded,
      servers: loaded.servers.filter((entry: McpServerEntry) => scope.configurationScopes!.includes(entry.override ? 'project' : entry.scope ?? 'global')) } : loaded;
    if (configRevision !== this.#configRevision(scope)) fail('mcp-config-changed');
    const record: ScopeRecord = { handle: randomUUID(), scope, key, config, configRevision, entries: new Map(config.servers.map(entry => [entry.name, entry])), definitions: new Map(), connections: new Map(), released: false, inflight: 0, preparations: 0, closings: new Set(), drain: drain(), retainedHolders: 0, closeRequested: false, shutdown: new AbortController() };
    for (const entry of record.entries.values()) record.definitions.set(entry.name, this.#configurationIdentity(record, entry));
    if (configRevision !== this.#configRevision(scope)) fail('mcp-config-changed');
    // Disable/removal is revocation, not an ordinary replacement that may keep old leases alive.
    if (config.errors.length === 0) for (const connection of this.#pool.values()) {
      if (connection.scopeKey !== key || connection.entry.scope === 'extension') continue;
      const selected = record.entries.get(connection.entry.name);
      if (!selected || selected.config.enabled === false) this.#revoke(connection);
    }
    this.#scopes.set(record.handle, record);
    return { scope: record.handle, config: { ...config, errors: config.errors.map(() => 'MCP configuration error; inspect the configured mcp.json'), servers: config.servers.map(publicEntry) } };
  }

  /** Read configuration and existing discovery facts without starting a transport. */
  inspect(scope: McpAuthorityScope): McpAuthorityInspection {
    const opened = this.open(scope);
    try { return this.#inspectScope(this.#scope(opened.scope), new Set()); }
    finally { this.closeScope(opened.scope); }
  }

  async acquire(scope: McpAuthorityScope, options: McpAuthorityAcquireOptions): Promise<McpAuthorityOwnedLease> {
    const opened = this.open(scope);
    const record = this.#scope(opened.scope);
    const abort = () => this.closeScope(opened.scope);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      if (record.released) fail('mcp-preparation-cancelled');
      if (options.provenance) {
        for (const [name, selected] of Object.entries(options.provenance.servers)) {
          if (stable(selected.owner) !== stable(serverOwner(record.scope))) fail('mcp_configuration_source_changed');
          const entry = record.entries.get(name);
          if (!entry || entry.config.enabled === false) fail('mcp_saved_definition_unavailable');
          if (this.#configurationIdentity(record, entry) !== selected.definition_version) {
            // An accepted delegation can use the original retained definition after ordinary
            // configuration replacement. Source, revocation and execution scope remain owned
            // here; no persisted copy or latest-definition substitution is introduced.
            const original = [...this.#scopes.values()].find(candidate => candidate !== record && !candidate.released
              && stable(serverOwner(candidate.scope)) === stable(selected.owner)
              && candidate.definitions.get(name) === selected.definition_version
              && candidate.entries.has(name)
              && this.#resourceKey(candidate, candidate.entries.get(name)!) === selected.resource_key
              && !candidate.connections.get(name)?.revoked);
            if (!original) fail('mcp_saved_definition_unavailable');
            record.entries.set(name, original.entries.get(name)!);
            record.definitions.set(name, selected.definition_version);
          }
        }
        // This lease can discover only its admitted dependencies. Other scopes retain their
        // full configuration and connection ownership; narrowing never revokes a sibling.
        record.entries = new Map([...record.entries].filter(([name]) => name in options.provenance!.servers));
      }
      const selected = new Set(options.servers);
      if (record.config.errors.length && selected.size > 0) fail('mcp-config-invalid');
      if ([...selected].some(name => !record.entries.has(name))) fail('mcp-selected-server-not-configured');
      const entries = [...record.entries.values()].filter(entry => selected.has(entry.name));
      if (entries.some(entry => entry.config.enabled === false)) fail('mcp-selected-server-disabled');
      await Promise.all(entries.map(entry => this.connect(record.handle, publicEntry(entry))));
      if (record.released) fail('mcp-preparation-cancelled');
      const handles = [...record.connections.values()];
      if (handles.some(connection => connection.connection.state === 'needs-auth')) fail('mcp-server-needs-auth');
      if (handles.some(connection => connection.connection.state !== 'connected')) fail('mcp-connection-unavailable');
      const pinned = new Map<string, { connection: ConnectionRecord; tool: McpTool; descriptor: McpAuthorityTool; validate: ValidateFunction }>();
      const project = (connection: ConnectionRecord): McpAuthorityTool[] => {
        connection.declarations = stable(connection.connection.tools);
        const declarations = [...connection.connection.tools].sort((a, b) => a.name.localeCompare(b.name));
        const plain = declarations.map(tool => createMcpToolName(connection.entry.name, tool.name));
        const claimed = new Set<string>();
        const tools: McpAuthorityTool[] = [];
        for (const tool of declarations) {
          const exposure = getMcpToolExposure(connection.entry.config, tool.name);
          if (exposure === 'hidden') continue;
          const name = createMcpToolName(connection.entry.name, tool.name, candidate => claimed.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate));
          claimed.add(name);
          const schemaVersion = this.#toolVersion(connection, tool);
          let validate = connection.validators.get(schemaVersion);
          if (!validate) { validate = compile(tool); connection.validators.set(schemaVersion, validate); }
          const descriptor: McpAuthorityTool = freeze({ name, server: connection.entry.name, tool: tool.name, schemaVersion,
            resourceKey: this.#resourceKey(record, connection.entry), configurationScope: connection.entry.scope ?? 'global',
            executionScope: connection.scope.executionScope, inputSchema: structuredClone(tool.inputSchema), taskSupport: taskSupport(tool), taskCapable: taskCapabilities(connection.nativeClient).call,
            description: tool.description ?? '', exposure,
            ...(tool.outputSchema ? { outputSchema: structuredClone(tool.outputSchema) } : {}),
            ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}) });
          pinned.set(name, { connection, tool: structuredClone(tool), descriptor, validate });
          tools.push(descriptor);
        }
        return tools;
      };
      const tools = handles.flatMap(project).sort((a,b)=>a.name.localeCompare(b.name));
      let released = false;
      const assert = (name: string, schemaVersion: string) => {
        if (released || record.released) fail('mcp-lease-released');
        const target = pinned.get(name);
        if (!target || target.descriptor.schemaVersion !== schemaVersion) fail('mcp-schema-generation-mismatch');
        this.#assertConnection(record, target.connection, target.tool.name, schemaVersion);
        return target;
      };
      const validateArguments = (name: string, schemaVersion: string, args: unknown) => {
        const target = assert(name, schemaVersion);
        if (target.validate(args) !== true) fail('mcp-arguments-invalid');
      };
      const prepareServer = async (server: string, signal: AbortSignal): Promise<ConnectionRecord> => {
        if (released || record.released) fail('mcp-lease-released');
        if (signal.aborted) fail('mcp-preparation-cancelled');
        const entry = record.entries.get(server);
        if (!entry || entry.scope === 'extension') fail('mcp-selected-server-not-configured');
        if (entry.config.enabled === false) fail('mcp-selected-server-disabled');
        const pending = this.connect(record.handle, publicEntry(entry));
        // A cancelled observer does not close another Run's shared preparation/transport.
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new McpAuthorityError('mcp-preparation-cancelled')); };
          signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
          pending.then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
        });
        if (released || record.released || signal.aborted) fail('mcp-preparation-cancelled');
        const connection = record.connections.get(server);
        if (!connection || connection.connection.state !== 'connected') fail('mcp-connection-unavailable');
        this.#assertConnection(record, connection, undefined, undefined, true);
        return connection;
      };
      const discover = async (server: string, signal: AbortSignal) => freeze(project(await prepareServer(server, signal)));
      const discoverServices = async (server: string, signal: AbortSignal) => {
        const connection = await prepareServer(server, signal);
        const client = await this.#nativeClient(connection);
        this.#assertConnection(record, connection);
        return freeze((['resources', 'prompts'] as const).flatMap(kind => client.serverCapabilities?.[kind]
          ? [this.#service(record, connection, kind)] : []));
      };
      const serviceConnection = (service: McpAuthorityService) => {
        if (released || record.released) fail('mcp-lease-released');
        const connection = record.connections.get(service.server);
        if (!connection || service.resourceKey !== this.#resourceKey(record, connection.entry)) fail('mcp-service-unbound');
        this.#assertConnection(record, connection);
        if (this.#service(record, connection, service.kind).schemaVersion !== service.schemaVersion) fail('mcp-schema-generation-mismatch');
        return connection;
      };
      const validateRequest = (service: McpAuthorityService, request: McpServiceRequest) => {
        const connection = serviceConnection(service);
        if (serviceKind(request.operation) !== service.kind) fail('mcp-service-operation-invalid');
        if (request.operation === 'prompts/get') {
          const prompt = connection.prompts.get(request.prompt.name);
          if (!prompt || stable(request.prompt.service) !== stable(service)
            || this.#promptVersion(service, prompt) !== request.prompt.schemaVersion) fail('mcp-schema-generation-mismatch');
          try { validatePromptArguments(prompt, request.arguments); } catch { fail('mcp-prompt-arguments-invalid'); }
        } else if (request.operation === 'resources/read') {
          if (typeof request.uri !== 'string' || !request.uri) fail('mcp-resource-uri-required');
        } else if (request.cursor !== undefined && typeof request.cursor !== 'string') fail('mcp-cursor-invalid');
      };
      const requestService = async (service: McpAuthorityService, request: McpServiceRequest, options: {signal: AbortSignal; beforeDispatch?: () => void | Promise<void>; interaction?: McpInteractionOrigin}) => {
        validateRequest(service, request);
        const connection = serviceConnection(service);
        const result = await this.#requestService(record, connection, service, request, options, () => validateRequest(service, request));
        return result;
      };
      const readiness = this.#inspectScope(record, selected);
      return {
        implementationIdentity: createHash('sha256').update(stable([record.key,handles.map(connection=>connection.handle).sort(),
          [...record.entries.values()].map(entry=>this.#configurationIdentity(record,entry)).sort()])).digest('hex'),
        binding: freeze({ provenance: { servers: Object.fromEntries(
          [...record.entries.values()].filter(entry => entry.config.enabled !== false && entry.config.exposure !== 'hidden').map(entry => [entry.name, {
            owner: serverOwner(record.scope), definition_version: this.#configurationIdentity(record, entry), resource_key: this.#resourceKey(record, entry),
          }])) }, reference: `mcp-owner:${createHash('sha256').update(record.key).digest('hex')}`,
          generation: 1 + Number.parseInt(createHash('sha256').update(stable([record.key,
            [...record.entries.values()].map(entry => ({ name: entry.name, identity: this.#configurationIdentity(record, entry) })).sort((a, b) => a.name.localeCompare(b.name)),
            tools])).digest('hex').slice(0, 12), 16),
          tools, readiness, servers: readiness.servers,
          serverSelections: [...record.entries.values()].map(entry=>({name:entry.name,configurationVersion:this.#configurationIdentity(record,entry),
            hiddenTools:Object.entries(entry.config.toolExposure ?? {}).filter(([,exposure])=>exposure==='hidden').map(([name])=>name)})) }),
        inspect: () => { if (released || record.released) fail('mcp-lease-released'); return this.#inspectScope(record, selected); },
        discover,
        discoverServices,
        prepareService: async (server, kind, version, signal) => {
          const services = await discoverServices(server, signal);
          const service = services.find(value => value.kind === kind);
          if (!service) fail('mcp-service-unsupported');
          if (service.schemaVersion !== version) fail('mcp-schema-generation-mismatch');
          serviceConnection(service); return service;
        },
        preparePrompt: async (server, name, version, signal) => {
          const services = await discoverServices(server, signal);
          const service = services.find(value => value.kind === 'prompts');
          if (!service) fail('mcp-service-unsupported');
          const connection = serviceConnection(service);
          const cached = connection.prompts.get(name);
          if (cached) {
            const schemaVersion = this.#promptVersion(service, cached);
            if (schemaVersion !== version) fail('mcp-schema-generation-mismatch');
            return freeze({ service, name, schemaVersion, declaration: structuredClone(cached) });
          }
          // Restart or list-change invalidation: rebind through current protocol declarations.
          let cursor: string | undefined;
          const cursors = new Set<string>();
          do {
            const page = await requestService(service, { operation: 'prompts/list', ...(cursor === undefined ? {} : {cursor}) }, { signal });
            const prompt = (page.result.prompts as McpPromptDeclaration[]).find(value => value.name === name);
            if (prompt) {
              const schemaVersion = this.#promptVersion(service, prompt);
              if (schemaVersion !== version) fail('mcp-schema-generation-mismatch');
              return freeze({ service, name, schemaVersion, declaration: structuredClone(prompt) });
            }
            cursor = page.result.nextCursor as string | undefined;
            if (cursor !== undefined && cursors.has(cursor)) fail('mcp-pagination-cursor-repeated');
            if (cursor !== undefined) cursors.add(cursor);
          } while (cursor !== undefined);
          connection.prompts.delete(name);
          return fail('mcp-prompt-unavailable');
        },
        assertService: service => { serviceConnection(service); },
        serviceRevocationSignal: service => serviceConnection(service).shutdown.signal,
        validateServiceRequest: validateRequest,
        requestService,
        prepareTool: async (server, tool, schemaVersion, signal) => {
          const declarations = await discover(server, signal);
          const target = declarations.find(candidate => candidate.tool === tool);
          if (!target || target.schemaVersion !== schemaVersion) fail('mcp-schema-generation-mismatch');
          assert(target.name, schemaVersion); return target;
        },
        assertCallable: (name, schemaVersion) => { assert(name, schemaVersion); },
        revocationSignal: (name, schemaVersion) => assert(name,schemaVersion).connection.shutdown.signal,
        validateArguments,
        resourceEndpoint: service => this.#endpoint(record,serviceConnection(service)),
        observeResource: async (service,uri,options) => {
          const connection=await prepareServer(service.server, options.signal);
          return this.#observeResource(record,connection,service,uri,options);
        },
        taskOwner: async (server, endpoint, signal) => {
          const connection = await prepareServer(server, signal);
          const actual = this.#endpoint(record, connection);
          if (endpoint && stable(actual) !== stable(endpoint)) fail('mcp-task-owner-changed');
          return this.#taskLease(record, connection, actual);
        },
        callTool: async (name, args, options) => {
          validateArguments(name, options.schemaVersion, args);
          const target = assert(name, options.schemaVersion);
          return this.callTool(record.handle, target.connection.handle, target.tool.name, options.schemaVersion, args, options.signal, options.beforeDispatch, options.interaction);
        },
        release: () => { if (!released) { released = true; this.closeScope(record.handle); } },
        releaseAndDrain: () => { released = true; this.closeScope(record.handle); return record.drain.promise; },
      };
    } catch (error) { this.closeScope(record.handle); await record.drain.promise; throw error; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }

  async connect(scopeHandle: string, requested: McpOwnerEntry): Promise<McpOwnerConnectionSnapshot> {
    const scope = this.#scope(scopeHandle);
    scope.preparations++;
    try {
    let entry = scope.entries.get(requested.name);
    if (!entry) {
      if (requested.scope !== 'extension' || !requested.source) fail('mcp-server-not-configured');
      const config = validateMcpServerConfig(requested.name, requested.config);
      if (typeof config === 'string') fail('mcp-extension-config-invalid');
      entry = { name: requested.name, config, source: requested.source, scope: 'extension' };
      scope.entries.set(entry.name, entry);
      scope.definitions.set(entry.name, this.#configurationIdentity(scope, entry));
    }
    if (entry.config.enabled === false) fail('mcp-server-disabled');
    if (entry.scope !== 'extension') {
      const live = loadMcpConfig({ agentDir: scope.scope.agentDir, cwd: scope.scope.configCwd, projectTrusted: scope.scope.projectTrusted });
      if (live.errors.length) fail('mcp-config-invalid');
      const configured = live.servers.find(candidate => candidate.name === entry.name);
      if (!configured || configured.config.enabled === false) fail('mcp-server-disabled');
    }
    const key = this.#connectionKey(scope, entry);
    const existing = scope.connections.get(entry.name);
    if (existing && !existing.revoked) await this.#assertCredential(existing).catch(() => undefined);
    this.#scope(scopeHandle);
    if (existing?.key === key && !existing.revoked) {
      await existing.ready;
      this.#scope(scopeHandle);
      if (existing.connection.state !== 'connected') await existing.connection.getClient().catch(() => undefined);
      return this.snapshot(scopeHandle, existing.handle);
    }
    let record = this.#pool.get(key);
    if (!record || record.revoked) {
      const provider = 'url' in entry.config ? entry.config.auth?.provider : undefined;
      if (provider && !this.#options.credentialScope) fail('mcp-provider-credential-authority-required');
      const providerGrant = provider ? stable(await this.#options.credentialScope!(scope.scope, provider)) : undefined;
      const runtime = await loadMcpRuntime();
      this.#scope(scopeHandle);
      // Concurrent preparation shares the same connection after the lazy module resolves.
      record = this.#pool.get(key);
      if (!record || record.revoked) {
        const connection = new runtime.McpServerConnection({ entry, cwd: scope.scope.executionCwd,
          ...((this.#options.interactions || this.#options.sampling) ? { clientCapabilities: { ...(this.#options.interactions ? { elicitation: { form: {}, url: {} } } : {}), ...(this.#options.sampling ? { sampling: {} } : {}) } } : {}),
          onClientCreated: client => { const current = this.#pool.get(key); if (current?.connection === connection) this.#observeNativeClient(current, client); },
          createTransport: (...args) => {
            const transport = (this.#options.createTransport ?? runtime.createDefaultTransport)(...args);
            return this.#options.adaptTransport ? this.#options.adaptTransport(scope.scope, transport) : transport;
          },
          credentials: this.#store(scope.scope.agentDir),
          providerToken: async requestedProvider => {
            if (!provider || requestedProvider !== provider || !this.#options.credentialScope) fail('mcp-provider-credential-authority-required');
            if (stable(await this.#options.credentialScope(scope.scope, provider)) !== providerGrant) fail('mcp-credential-revoked');
            const token = await this.#options.providerToken?.(scope.scope, provider);
            if (stable(await this.#options.credentialScope(scope.scope, provider)) !== providerGrant) fail('mcp-credential-revoked');
            return token;
          },
          log: new runtime.McpServerLog(join(scope.scope.agentDir, 'mcp.log')),
          onTools: () => {
            // Initial discovery belongs to the preparation already awaiting this connection.
            // Only changes to declarations actually leased by a consumer invalidate that scope.
            const selected = this.#pool.get(key);
            if (!selected?.declarations || selected.revoked || selected.connection !== connection) return;
            const next = stable(connection.tools);
            if (next !== selected.declarations) { selected.declarations = next; this.#changed(scope.key,{kind:'tools',server:entry.name}); }
          },
        });
        record = { handle: randomUUID(), generation: ++this.#generation, key, configIdentity: this.#configurationIdentity(scope, entry), scopeKey: scope.key, scope: scope.scope,
          entry, connection, rpcInteractions: new Map(), taskInteractions: new Map(), elicitationComplete: new Map(), completionDisposers:new Set(), references: 0, retired: false, revoked: false, shutdown: new AbortController(),
          credentialRevision: 0, oauthGrant: this.#oauthGrant(scope.scope, connection), provider, providerGrant, validators: new Map(), prompts: new Map(), promptRevision: 0, taskListeners: new Set(), resourceGroups:new Map(), nativeDisposers:[] };
        this.#pool.set(key, record);
        const selected = record;
        record.ready = connection.getClient().then(client => {
          this.#observeNativeClient(selected, client);
          if (selected.revoked || selected.closing) return;
          const selectionKey = stable([selected.scopeKey, selected.entry.name]);
          const previous = this.#selected.get(selectionKey);
          this.#selected.set(selectionKey, selected);
          if (previous && previous !== selected) { previous.retired = true; this.#collect(previous); }
        }).catch(() => undefined).finally(() => {
          // Initialization may create OAuth discovery state. No tool declaration has been leased yet.
          if (!selected.revoked && !selected.closing) selected.oauthGrant = this.#oauthGrant(selected.scope, connection);
        }); // The explicit connection state preserves auth/connection failures.
      }
    }
    if (existing && existing !== record) this.#releaseConnection(scope, existing);
    if (scope.connections.get(entry.name) !== record) { record.references++; scope.connections.set(entry.name, record); }
    await record.ready;
    return this.snapshot(scopeHandle, record.handle);
    } finally { scope.preparations--; this.#drainScope(scope); }
  }

  snapshot(scopeHandle: string, handle: string): McpOwnerConnectionSnapshot {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle); const connection = record.connection;
    if (record.oauthGrant !== this.#oauthGrant(record.scope, connection)) this.#revoke(record, 'mcp-credential-revoked');
    const tokenObservation = connection.oauthUrl ? stable(this.#store(scope.scope.agentDir).tokens(connection.name, connection.oauthUrl) ?? null) : '';
    if (record.tokenObservation !== tokenObservation) { record.tokenObservation = tokenObservation; record.credentialRevision++; }
    return { handle: record.handle, generation: record.generation, entry: publicEntry(record.entry), state: connection.state,
      ...(record.revoked ? { error: record.revocationReason ?? 'mcp-owner-revoked' } : connection.error ? { error: connection.state === 'needs-auth' ? 'MCP sign-in required' : 'MCP connection unavailable; inspect the owner log' } : {}),
      tools: record.revoked ? [] : structuredClone(connection.tools), schemaVersions: Object.fromEntries(connection.tools.map(tool => [tool.name, this.#toolVersion(record, tool)])),
      hasResources: connection.hasResources, resources: structuredClone(connection.resources), resourceTemplates: structuredClone(connection.resourceTemplates),
      ...(connection.instructions ? { instructions: connection.instructions } : {}), timeoutMs: connection.timeoutMs,
      ...(connection.oauthUrl ? { oauthUrl: publicEntry(record.entry).config.url as string } : {}), credentialRevision: String(record.credentialRevision) };
  }

  async callTool(scopeHandle: string, handle: string, tool: string, schemaVersion: string, args: Record<string, unknown>, signal: AbortSignal, beforeDispatch?: () => void | Promise<void>, interaction?: McpInteractionOrigin): ReturnType<McpServerConnection['callTool']> {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle);
    this.#assertConnection(scope, record, tool, schemaVersion);
    const definition = record.connection.tools.find(candidate => candidate.name === tool)!;
    if (requiresMcpTask({taskSupport:taskSupport(definition),taskCapable:taskCapabilities(record.nativeClient).call})) fail('mcp-task-required-use-mcp-start-task');
    let validate = record.validators.get(schemaVersion);
    if (!validate) { validate = compile(definition); record.validators.set(schemaVersion, validate); }
    if (validate(args) !== true) fail('mcp-arguments-invalid');
    if (signal.aborted) fail('mcp-call-cancelled');
    scope.inflight++;
    try {
    await this.#assertCredential(record);
    // getClient may reconnect. Revalidate the exact declaration after it settles, before dispatch.
    try { await this.#nativeClient(record); } catch { fail('mcp-connection-unavailable'); }
    this.#assertConnection(scope, record, tool, schemaVersion);
    if (signal.aborted) fail('mcp-call-cancelled');
    let dispatched = false, receivedResponse = false, protocolError: Record<string, unknown> | undefined, interactionProblem: string | undefined;
    try { return await record.connection.requestOnce(async client => {
      this.#observeNativeClient(record, client);
      await this.#assertCredential(record);
      await beforeDispatch?.();
      await this.#assertCredential(record);
      this.#assertConnection(scope, record, tool, schemaVersion);
      if (signal.aborted || record.shutdown.signal.aborted || scope.shutdown.signal.aborted) fail('mcp-call-cancelled');
      dispatched = true;
      return client.callTool(tool, args, {
        signal: AbortSignal.any([signal, record.shutdown.signal, scope.shutdown.signal]), timeoutMs: record.connection.timeoutMs,
        ...this.#interactionRequestOptions(scope, record, 'tools/call', interaction, (received,error,problem) => {receivedResponse ||= received;protocolError ??= error;interactionProblem ??= problem;}),
      });
    }); }
    catch (error) {
      if (!dispatched && error instanceof McpAuthorityError) throw error;
      if (error instanceof McpSessionExpiredError) throw new McpAuthorityError('mcp-session-expired', dispatched, 'session_expired');
      throw new McpAuthorityError(signal.aborted || record.shutdown.signal.aborted || scope.shutdown.signal.aborted ? 'mcp-call-interrupted' : 'mcp-call-failed', dispatched, receivedResponse ? 'rpc_response' : 'unknown', protocolError ?? (error instanceof McpError ? {code:error.code,message:error.message,...(error.data === undefined ? {} : {data:error.data})} : undefined),interactionProblem);
    }
    } finally { scope.inflight--; this.#drainScope(scope); }
  }

  async #nativeClient(record: ConnectionRecord): Promise<McpClient> {
    let client: McpClient;
    try { client = await record.connection.getClient(); } catch { return fail('mcp-connection-unavailable'); }
    this.#observeNativeClient(record, client);
    return client;
  }
  #observeNativeClient(record: ConnectionRecord, client: McpClient): void {
    if (record.nativeClient === client) return;
    for(const dispose of record.nativeDisposers.splice(0))dispose();
    for(const group of record.resourceGroups.values())for(const holder of group.holders)if(holder.active)holder.change({kind:"gap"});
    record.resourceGroups.clear();
    for (const holder of record.rpcInteractions.values()) holder.controller.abort('rpc_closed');
    record.rpcInteractions.clear();
    for(const dispose of record.completionDisposers)dispose();
    record.elicitationComplete.clear();
    record.clientId = randomUUID();
    record.nativeClient = client;
    record.prompts.clear();
    record.promptRevision++;
    record.nativeDisposers.push(client.onNotification('notifications/resources/updated', params => {
      if(record.nativeClient!==client||record.revoked||!taskObject(params)||typeof params.uri!=='string'||!params.uri)return;
      // Capture only the listeners which actually existed on this client when it received the fact.
      const targets=[...record.resourceGroups.values()].filter(group=>group.client===client)
        .flatMap(group=>[...group.holders].filter(holder=>holder.active).map(holder=>({uri:group.uri,holder})));
      // No body I/O or consumer code runs on the SDK's synchronous notification reader.
      queueMicrotask(()=>{void (async()=>{
        await this.#assertCredential(record);
        if(record.nativeClient!==client||record.revoked)return;
        for(const {uri,holder} of targets){
          if(!holder.active)continue;
          try{this.#assertConnection(holder.scope,record);holder.change(params.uri===uri?{kind:'updated',notification:params}:{kind:'unresolved_association'});}
          catch{holder.change({kind:'unavailable',problem:'mcp-resource-owner-unavailable'});}
        }
      })().catch(()=>{if(record.nativeClient!==client)return;for(const {holder} of targets)if(holder.active)holder.change({kind:'unavailable',problem:'mcp-resource-owner-unavailable'});});});
    }));
    record.nativeDisposers.push(client.onClose(()=>{if(record.nativeClient!==client)return;for(const dispose of record.completionDisposers)dispose();record.elicitationComplete.clear();for(const group of record.resourceGroups.values())for(const holder of group.holders)if(holder.active)holder.change({kind:'gap'});}));
    client.onNotification('notifications/tasks/status', params => {
      if (record.nativeClient !== client || !taskObject(params) || typeof params.taskId !== 'string') return;
      for (const listener of record.taskListeners) listener(params.taskId);
    });
    client.setRequestHandler('elicitation/create', (params, context) => this.#receiveInteraction(record, client, params, context));
    client.setRequestHandler('sampling/createMessage', (params, context) => this.#receiveSampling(record, client, params, context));
    record.nativeDisposers.push(client.onNotification('notifications/elicitation/complete', params => {
      if (record.nativeClient !== client || record.revoked || !taskObject(params) || typeof params.elicitationId !== 'string') return;
      const watch = record.elicitationComplete.get(params.elicitationId);
      if (!watch || watch.kind === 'ambiguous') return;
      record.elicitationComplete.delete(params.elicitationId);
      watch.complete();
    }));
    client.onNotification('notifications/prompts/list_changed', () => {
      if (record.nativeClient !== client) return;
      record.prompts.clear();
      record.promptRevision++;
    });
  }
  #interactionRequestOptions(scope: ScopeRecord, record: ConnectionRecord, method: string,
    origin?: McpInteractionOrigin, settled?: (receivedResponse: boolean, error?: Record<string, unknown>, problem?: string) => void,
    taskId?: string): McpRequestOptions {
    const client = record.nativeClient;
    return {
      onRequestId: id => {
        if (!origin || (!this.#options.interactions && !this.#options.sampling)) return;
        if (client !== record.nativeClient || record.rpcInteractions.has(id)) throw new McpAuthorityError('mcp_interaction_owner_unavailable');
        record.rpcInteractions.set(id, { scope, origin, controller: new AbortController() });
      },
      onResponseError: (id, raw) => {
        settled?.(true, raw);
        if (!origin || raw.code !== -32042) return;
        let problem: string | undefined;
        try {
          problem = this.#options.interactionErrors && client === record.nativeClient && client
            ? this.#receiveErrorInteraction(scope, record, client, origin, id, method, raw, taskId)
            : 'mcp_interaction_owner_unavailable';
        } catch { problem = 'mcp_interaction_owner_unavailable'; }
        if (problem) settled?.(true, raw, problem);
      },
      onRequestSettled: (id, receivedResponse) => {
        settled?.(receivedResponse);
        if (record.nativeClient !== client) return;
        const holder = record.rpcInteractions.get(id);
        record.rpcInteractions.delete(id);
        holder?.controller.abort('rpc_closed');
      },
    };
  }
  #receiveErrorInteraction(scope: ScopeRecord, record: ConnectionRecord, client: McpClient,
    origin: McpInteractionOrigin, outgoingRequestId: string | number, method: string,
    raw: Record<string, unknown>, taskId?: string): string | undefined {
    if (client.protocolVersion !== '2025-11-25' || !client.options.capabilities?.elicitation?.url) return 'mcp_interaction_owner_unavailable';
    let presentations: ReturnType<typeof decodeUrlElicitationError>;
    try { presentations = decodeUrlElicitationError(raw); } catch { return 'mcp_url_elicitation_invalid'; }
    // No guessing or cross-Thread broadcast when a peer reuses an active identity.
    const conflicts=presentations.filter(p=>record.elicitationComplete.has(p.elicitationId));
    if(conflicts.length){
      // A future ID-only notification could refer to either RPC. Withdraw the old
      // association as well; retaining it would guess that the first request completed.
      for(const p of conflicts)this.#conflictElicitation(record,p.elicitationId);
      return 'mcp_elicitation_identity_conflict';
    }
    const signal = AbortSignal.any([record.shutdown.signal, scope.shutdown.signal]);
    const endpoint = this.#endpoint(scope, record), connectionId = record.clientId!;
    const assertLive = async () => {
      signal.throwIfAborted(); await this.#assertCredential(record); this.#assertConnection(scope, record);
      if (record.nativeClient !== client || record.clientId !== connectionId || client.connectionState !== 'connected'
        || stable(this.#endpoint(scope, record)) !== stable(endpoint)) throw new McpAuthorityError('mcp_interaction_owner_unavailable');
      signal.throwIfAborted();
    };
    const watches = presentations.map(p => this.#completionWatch(scope, record, client, p.elicitationId));
    try {
      this.#options.interactionErrors!({request: raw, items: presentations.map((presentation, index) => ({
        binding: {...origin, endpoint, connectionId, source: {kind:'rpc_error', outgoingRequestId, method,
          elicitationId: presentation.elicitationId, ...(taskId === undefined ? {} : {taskId})}},
        presentation, signal, assertLive, onComplete: (callback, unavailable) => watches[index]!.observe(() => {
          callback();
          if (taskId !== undefined) for (const listener of record.taskListeners) listener(taskId);
        }, unavailable),
      }))}, scope.scope);
    } catch { for (const watch of watches) watch.dispose(); return 'mcp_interaction_owner_unavailable'; }
    return undefined;
  }
  #conflictElicitation(record: ConnectionRecord, id: string): void {
    const current=record.elicitationComplete.get(id);
    if(current?.kind==='active')current.invalidate();
    // Only an actually ambiguous identity is retained for this client incarnation. A later
    // RPC cannot reclaim it and misinterpret an old ID-only completion as its own.
    record.elicitationComplete.set(id,{kind:'ambiguous'});
  }
  #completionWatch(scope: ScopeRecord, record: ConnectionRecord, client: McpClient, id: string) {
    if(record.elicitationComplete.has(id)){this.#conflictElicitation(record,id);throw new McpError(-32602,'Elicitation identity is already in use');}
    scope.retainedHolders++;
    let released=false, completed=false, lost=false;
    let callback: (() => void) | undefined, unavailable: (() => void) | undefined;
    const dispose=()=>{if(released)return;released=true;
      if(record.elicitationComplete.get(id)===registration)record.elicitationComplete.delete(id);
      record.completionDisposers.delete(invalidate);record.shutdown.signal.removeEventListener('abort',invalidate);scope.shutdown.signal.removeEventListener('abort',invalidate);scope.retainedHolders--;
      if(scope.closeRequested&&!scope.retainedHolders)this.closeScope(scope.handle);};
    const invalidate=()=>{if(released)return;lost=true;dispose();unavailable?.();};
    const deliver=()=>{void this.#assertCredential(record).then(()=>{
      this.#assertConnection(scope,record);
      if(!released&&record.nativeClient===client&&!record.revoked){completed=true;callback?.();}
    }).catch(invalidate).finally(dispose);};
    const registration={kind:'active' as const,complete:deliver,invalidate};record.elicitationComplete.set(id,registration);record.completionDisposers.add(invalidate);
    record.shutdown.signal.addEventListener('abort',invalidate,{once:true});scope.shutdown.signal.addEventListener('abort',invalidate,{once:true});
    if(record.shutdown.signal.aborted || scope.shutdown.signal.aborted)invalidate();
    return {dispose, observe:(done:()=>void, invalid?:()=>void)=>{
      callback=done;unavailable=invalid;
      if(completed)queueMicrotask(done);else if(lost&&invalid)queueMicrotask(invalid);
      return dispose;
    }};
  }
  async #receiveInteraction(record: ConnectionRecord, client: McpClient, params: unknown, context: McpRequestHandlerContext): Promise<McpElicitationResponse> {
    if (!this.#options.interactions || !client.options.capabilities?.elicitation)
      throw new McpError(-32601, 'Client capability is not supported');
    let decoded; try { decoded = decodeElicitationRequest(params); } catch { throw new McpError(-32602, 'Elicitation request is invalid'); }
    const { binding, signal, assertLive, scope } = await this.#associateRequest(record, client, params, context);
    return this.#options.interactions({ binding, request: decoded.request, signal, assertLive,
      beforeResponse: context.beforeResponse, onResponseSettled: context.onResponseSettled,
      onComplete: (callback, unavailable) => {
        if (decoded.presentation.mode !== 'url') return () => {};
        const id = decoded.presentation.elicitationId;
        return this.#completionWatch(scope, record, client, id).observe(callback, unavailable);
      },
    }, scope.scope);
  }
  async #receiveSampling(record: ConnectionRecord, client: McpClient, params: unknown, context: McpRequestHandlerContext): Promise<import('@varin/protocol').McpSamplingResult> {
    if (!this.#options.sampling || !client.options.capabilities?.sampling) throw new McpError(-32601, 'Client capability is not supported');
    if (!taskObject(params)) throw new McpError(-32602, 'Sampling params must be an object');
    const { binding, signal, assertLive, scope } = await this.#associateRequest(record, client, params, context);
    try {
      return await this.#options.sampling({ binding, request: structuredClone(params), signal, assertLive,
        beforeResponse: context.beforeResponse, onResponseSettled: context.onResponseSettled, onComplete: () => () => {} }, scope.scope);
    } catch (error) {
      if (error instanceof McpSamplingRejectedError) throw new McpError(-1, error.message);
      throw error;
    }
  }
  async #associateRequest(record: ConnectionRecord, client: McpClient, params: unknown, context: McpRequestHandlerContext) {
    const meta = taskObject(params) && taskObject(params._meta) ? params._meta : undefined;
    const related = meta?.['io.modelcontextprotocol/related-task'];
    let holder: InteractionHolder | undefined, relation: Extract<McpInteractionBinding['source'], {kind:'server_request'}>['relation'];
    if (related !== undefined) {
      if (!taskObject(related) || typeof related.taskId !== 'string') throw new McpError(-32602, 'Task association is invalid');
      const holders = [...(record.taskInteractions.get(related.taskId) ?? [])].filter(h => !h.controller.signal.aborted);
      if (!holders.length || holders.some(h => stable(h.origin) !== stable(holders[0]!.origin)))
        throw new McpError(-32000, 'MCP interaction has no unambiguous original Task');
      holder = holders[0]; relation = { kind: 'task', taskId: related.taskId };
    } else {
      if (context.relatedRequestId !== undefined) holder = record.rpcInteractions.get(context.relatedRequestId);
      if (!holder) throw new McpError(-32000, 'MCP interaction cannot be associated with its original call');
      relation = { kind: 'rpc_response_stream', outgoingRequestId: context.relatedRequestId! };
    }
    const selected = holder!;
    const binding: McpInteractionBinding = { ...selected.origin, endpoint: this.#endpoint(selected.scope, record),
      connectionId: record.clientId!, source: {kind:'server_request', requestId: context.requestId, relation} };
    const signal = AbortSignal.any([context.signal, selected.controller.signal, record.shutdown.signal, selected.scope.shutdown.signal]);
    const assertLive = async () => {
      signal.throwIfAborted();
      await this.#assertCredential(record);
      this.#assertConnection(selected.scope, record);
      if (record.nativeClient !== client || record.clientId !== binding.connectionId || client.connectionState !== 'connected'
        || stable(this.#endpoint(selected.scope, record)) !== stable(binding.endpoint)) throw new McpAuthorityError('mcp_interaction_owner_unavailable');
      signal.throwIfAborted();
    };
    await assertLive();
    // This last check runs in the original SDK, directly before its one response send.
    context.beforeResponse(assertLive);
    return { binding, signal, assertLive, scope: selected.scope };
  }
  #endpoint(scope: ScopeRecord, record: ConnectionRecord): McpEndpoint {
    this.#assertConnection(scope, record);
    return {server:record.entry.name,resourceKey:this.#resourceKey(scope,record.entry),
      configurationVersion:record.configIdentity,
      credentialVersion:createHash('sha256').update(stable([record.oauthGrant,record.providerGrant ?? null])).digest('hex')};
  }
  #taskLease(scope: ScopeRecord, record: ConnectionRecord, endpoint: McpEndpoint): McpTaskLease {
    scope.retainedHolders++;
    let released = false;
    const listeners = new Set<(taskId:string, unsupported?:boolean)=>void>();
    const interactionRemovers = new Set<() => void>();
    const assert = async () => {
      if (released) fail('mcp-task-lease-released');
      await this.#assertCredential(record);
      if (stable(this.#endpoint(scope,record)) !== stable(endpoint)) fail('mcp-task-owner-changed');
    };
    const request = async (method:string, params:Record<string,unknown>, signal:AbortSignal,
      beforeDispatch?: (client:McpClient)=>void|Promise<void>, creationOrigin?: McpInteractionOrigin) => {
      let dispatched = false, receivedResponse = false, protocolError: Record<string, unknown> | undefined, interactionProblem: string | undefined;
      const taskId = typeof params.taskId === 'string' ? params.taskId : undefined;
      const holders = taskId === undefined ? [] : [...(record.taskInteractions.get(taskId) ?? [])].filter(h => !h.controller.signal.aborted);
      const interaction = creationOrigin ?? (holders.length && holders.every(h => stable(h.origin) === stable(holders[0]!.origin)) ? holders[0]!.origin : undefined);
      scope.inflight++;
      try {
        await assert();
        return await record.connection.requestOnce(async client => {
          this.#observeNativeClient(record,client);
          await assert();
          const capability = taskCapabilities(client);
          if (!(method === 'tools/call' ? capability.call : capability.supported) || method === 'tasks/cancel' && !capability.cancel) throw new McpTaskRequestError('mcp-task-capability-unsupported',false,'unsupported');
          await beforeDispatch?.(client);
          await assert();
          signal.throwIfAborted();
          dispatched = true;
          return await client.request(method,params,{signal:AbortSignal.any([signal,scope.shutdown.signal,record.shutdown.signal]),
            timeoutMs:method === 'tasks/result' ? 0 : record.connection.timeoutMs,
            ...this.#interactionRequestOptions(scope,record,method,interaction,(received,error,problem)=>{receivedResponse ||= received;protocolError ??= error;interactionProblem ??= problem;},taskId)});
        });
      } catch (error) {
        if (error instanceof McpTaskRequestError) throw error;
        if (error instanceof McpSessionExpiredError) throw new McpTaskRequestError('mcp-session-expired',dispatched,'transport',undefined,undefined,'session_expired');
        if (error instanceof McpAuthorityError && !dispatched) throw error;
        if (error instanceof McpError) throw new McpTaskRequestError('mcp-task-protocol-error',dispatched,'protocol',error.code,
          protocolError ?? {code:error.code,message:error.message,...(error.data === undefined ? {} : {data:error.data})},receivedResponse?'rpc_response':'unknown',interactionProblem);
        throw new McpTaskRequestError('mcp-task-request-unavailable',dispatched,'transport');
      } finally { scope.inflight--; this.#drainScope(scope); }
    };
    const taskResponse = (raw:unknown, taskId?:string, creation=false) => {
      let response: McpTaskResponse;
      try { response = validateTaskResponse(raw,creation); } catch { throw new McpTaskRequestError('mcp-task-response-invalid',true,'protocol'); }
      if (taskId !== undefined && response.task.taskId !== taskId) throw new McpTaskRequestError('mcp-task-identity-changed',true,'protocol');
      return response;
    };
    return {
      endpoint,
      bindInteraction: (taskId, origin) => {
        if (released || (!this.#options.interactions && !this.#options.sampling)) return () => {};
        const holder: InteractionHolder = { scope, origin, controller: new AbortController() };
        let holders = record.taskInteractions.get(taskId); if (!holders) { holders = new Set(); record.taskInteractions.set(taskId, holders); }
        holders.add(holder);
        const remove = (reason?: 'rpc_closed') => { holder.controller.abort(reason ?? 'owner_unavailable'); holders!.delete(holder);
          if (!holders!.size && record.taskInteractions.get(taskId) === holders) record.taskInteractions.delete(taskId); interactionRemovers.delete(remove); };
        interactionRemovers.add(remove); return remove;
      },
      start: async (name,args,options) => taskResponse(await request('tools/call',{name,arguments:args,task:options.ttl === undefined ? {} : {ttl:options.ttl}},options.signal,async () => {
        this.#assertConnection(scope,record,name,options.schemaVersion);
        const tool = record.connection.tools.find(tool=>tool.name === name)!;
        if (taskSupport(tool) === 'forbidden') throw new McpTaskRequestError('mcp-task-forbidden',false,'unsupported');
        const validate = record.validators.get(options.schemaVersion) ?? compile(tool);
        if (!validate(args)) fail('mcp-arguments-invalid');
        await options.beforeDispatch?.();
        this.#assertConnection(scope,record,name,options.schemaVersion);
      },options.interaction),undefined,true),
      get: async (taskId,signal) => taskResponse(await request('tasks/get',{taskId},signal),taskId),
      result: async (taskId,signal) => {
        const raw = await request('tasks/result',{taskId},signal);
        try { return validateTaskResult(raw,taskId); } catch { throw new McpTaskRequestError('mcp-task-result-invalid',true,'protocol'); }
      },
      cancel: async (taskId,signal) => {
        const response=taskResponse(await request('tasks/cancel',{taskId},signal),taskId);
        if(response.task.status!=='cancelled')throw new McpTaskRequestError('mcp-task-cancel-response-invalid',true,'protocol');
        return response;
      },
      onChange: listener => { listeners.add(listener);record.taskListeners.add(listener);return ()=>{listeners.delete(listener);record.taskListeners.delete(listener);}; },
      release: () => {
        if (released) return; released=true;
        for (const remove of interactionRemovers) remove();
        for (const listener of listeners) record.taskListeners.delete(listener);
        scope.retainedHolders--;
        if (scope.closeRequested && !scope.retainedHolders) this.closeScope(scope.handle);
      },
    };
  }

  async #observeResource(scope:ScopeRecord,record:ConnectionRecord,service:McpAuthorityService,uri:string,options:{signal:AbortSignal;beforeDispatch?:()=>void|Promise<void>;onChange:(change:McpResourceChange)=>void;interaction?:McpInteractionOrigin}):Promise<McpResourceObserver>{
    if(record.retired)fail('mcp-resource-owner-retired');
    if(service.kind!=='resources'||!uri)fail('mcp-resource-subscription-invalid');
    const endpoint=this.#endpoint(scope,record);
    scope.retainedHolders++;
    let released=false,holder:ResourceHolder|undefined,group:ResourceGroup|undefined;
    const release=()=>{if(released)return;released=true;scope.retainedHolders--;if(scope.closeRequested&&!scope.retainedHolders)this.closeScope(scope.handle);};
    let cleanup:Promise<McpResourceRelease>|undefined;
    const detach=(cleanupOptions?:{interaction:McpInteractionOrigin;signal:AbortSignal}):Promise<McpResourceRelease>=>{
      if(cleanup)return cleanup;
      if(holder){holder.active=false;group?.holders.delete(holder);}
      record.shutdown.signal.removeEventListener('abort',revoked);
      if(!group||group.holders.size){release();return cleanup=Promise.resolve({status:'shared'});}
      const selected=group;
      cleanup=(async():Promise<McpResourceRelease>=>{
        let receivedResponse=false, protocolError: Record<string, unknown> | undefined, interactionProblem: string | undefined;
        try{
          await selected.acknowledgement;
          // Never reconnect to clean an old client or substitute a later account.
          await this.#assertCredential(record);
          if(record.nativeClient!==selected.client||record.revoked||selected.client.connectionState!=='connected')return {status:'unknown'};
          const raw=await selected.client.request('resources/unsubscribe',{uri:selected.uri},{signal:cleanupOptions ? AbortSignal.any([record.shutdown.signal,cleanupOptions.signal]) : record.shutdown.signal,timeoutMs:record.connection.timeoutMs,...this.#interactionRequestOptions(scope,record,'resources/unsubscribe',cleanupOptions?.interaction,(received,error,problem)=>{receivedResponse ||= received;protocolError ??= error;interactionProblem ??= problem;})});
          return taskObject(raw)?{status:'acknowledged',acknowledgement:raw}:{status:'unknown'};
        }catch(error){return {status:'unknown',...(receivedResponse&&error instanceof McpError ? {protocolError:protocolError ?? {code:error.code,message:error.message,...(error.data===undefined?{}:{data:error.data})}} : {}),...(interactionProblem?{interactionProblem}:{})};}
        finally{if(record.resourceGroups.get(uri)===selected)record.resourceGroups.delete(uri);release();}
      })();
      selected.closing=cleanup;
      return cleanup;
    };
    const revoked=()=>{if(holder?.active)options.onChange({kind:'unavailable',problem:'mcp-resource-owner-revoked'});};
    try{
      await this.#assertCredential(record);
      await record.connection.requestOnce(async client=>{
        this.#observeNativeClient(record,client);await this.#assertCredential(record);
        await options.beforeDispatch?.();
        await this.#assertCredential(record);
        this.#assertConnection(scope,record);
        if(this.#service(scope,record,'resources').schemaVersion!==service.schemaVersion)fail('mcp-service-generation-mismatch');
        if(client.serverCapabilities?.resources?.subscribe!==true)fail('mcp-resource-subscribe-unsupported');
        options.signal.throwIfAborted();
        const previous=record.resourceGroups.get(uri);
        if(previous?.closing){
          await previous.closing;
          // The old unsubscribe may be slow. Authorization belongs to this new holder's
          // actual entry, not the earlier attempt which merely started waiting for it.
          await options.beforeDispatch?.();
          await this.#assertCredential(record);
          if(this.#service(scope,record,'resources').schemaVersion!==service.schemaVersion)fail('mcp-service-generation-mismatch');
          if(client.serverCapabilities?.resources?.subscribe!==true)fail('mcp-resource-subscribe-unsupported');
        }
        options.signal.throwIfAborted();this.#assertConnection(scope,record);
        if(record.retired||record.nativeClient!==client)fail('mcp-resource-client-retired');
        group=record.resourceGroups.get(uri);
        if(!group||group.client!==client){
          const fresh:ResourceGroup={client,uri,holders:new Set(),subscribed:false,receivedResponse:false,acknowledgement:Promise.resolve({})};
          group=fresh;record.resourceGroups.set(uri,fresh);
          fresh.acknowledgement=Promise.resolve().then(()=>client.request('resources/subscribe',{uri},{signal:record.shutdown.signal,timeoutMs:record.connection.timeoutMs,...this.#interactionRequestOptions(scope,record,'resources/subscribe',options.interaction,(received,error,problem)=>{fresh.receivedResponse ||= received;if(error)fresh.protocolError ??= error;if(problem)fresh.interactionProblem ??= problem;})})).then(raw=>{if(!taskObject(raw))throw new McpAuthorityError('mcp-resource-subscribe-response-invalid',true);fresh.subscribed=true;return raw;});
        }
        holder={active:true,scope,change:options.onChange};group.holders.add(holder);
        record.shutdown.signal.addEventListener('abort',revoked,{once:true});
        return await new Promise<Record<string,unknown>>((resolve,reject)=>{
          const abort=()=>{options.signal.removeEventListener("abort",abort);void detach();reject(new McpAuthorityError("mcp-resource-subscribe-interrupted",true));};
          options.signal.addEventListener("abort",abort,{once:true});if(options.signal.aborted)abort();
          group!.acknowledgement.then(value=>{options.signal.removeEventListener("abort",abort);resolve(value);},error=>{options.signal.removeEventListener("abort",abort);reject(error);});
        });
      });
      const acknowledgement=await group!.acknowledgement;
      return {endpoint,listenerId:randomUUID(),acknowledgement,detach};
    }catch(error){
      // Failed acquisition must also drain its original hidden URI-holder cleanup;
      // callers receive no observer handle with which to await that work later.
      if(holder)await detach();else release();
      if(error instanceof McpAuthorityError)throw error;
      throw new McpAuthorityError('mcp-resource-subscribe-unavailable',!!group,error instanceof McpSessionExpiredError ? 'session_expired' : group?.receivedResponse ? 'rpc_response' : 'unknown', group?.protocolError ?? (error instanceof McpError ? {code:error.code,message:error.message,...(error.data===undefined?{}:{data:error.data})} : undefined),group?.interactionProblem);
    }
  }

  #service(scope: ScopeRecord, record: ConnectionRecord, kind: McpServiceKind): McpAuthorityService {
    const client = record.nativeClient;
    if (!client?.serverCapabilities?.[kind]) return fail('mcp-service-unsupported');
    return { ...(kind==='resources'?{subscribe:client.serverCapabilities.resources?.subscribe===true}:{}), server: record.entry.name, kind, resourceKey: this.#resourceKey(scope, record.entry),
      schemaVersion: createHash('sha256').update(stable([kind, client.protocolVersion, client.serverCapabilities[kind],
        record.configIdentity, record.oauthGrant, record.providerGrant ?? null])).digest('hex') };
  }
  #promptVersion(service: McpAuthorityService, prompt: McpPromptDeclaration): string {
    return createHash('sha256').update(stable([service.schemaVersion, prompt])).digest('hex');
  }
  async #requestService(scope: ScopeRecord, record: ConnectionRecord, service: McpAuthorityService,
    request: McpServiceRequest, options: {signal: AbortSignal; beforeDispatch?: () => void | Promise<void>; interaction?: McpInteractionOrigin}, assertRequest: () => void): Promise<McpServiceResult> {
    let dispatched = false, receivedResponse = false, protocolError: Record<string, unknown> | undefined, interactionProblem: string | undefined;
    const signal = AbortSignal.any([options.signal, record.shutdown.signal, scope.shutdown.signal]);
    if (signal.aborted) fail('mcp-call-cancelled');
    scope.inflight++;
    try {
      await this.#assertCredential(record);
      return await record.connection.requestOnce(async client => {
        this.#observeNativeClient(record, client);
        await this.#assertCredential(record);
        await options.beforeDispatch?.();
        await this.#assertCredential(record);
        assertRequest();
        if (signal.aborted) fail('mcp-call-cancelled');
        const params = request.operation === 'resources/read' ? { uri: request.uri }
          : request.operation === 'prompts/get' ? { name: request.prompt.name, arguments: request.arguments }
          : request.cursor === undefined ? undefined : { cursor: request.cursor };
        // One entry into the original lifecycle, without transient or expired-session replay.
        const promptRevision = record.promptRevision;
        dispatched = true;
        const result = validateServiceResult(request.operation,
          await client.request(request.operation, params, { signal, timeoutMs: record.connection.timeoutMs, ...this.#interactionRequestOptions(scope, record, request.operation, options.interaction, (received,error,problem) => {receivedResponse ||= received;protocolError ??= error;interactionProblem ??= problem;}) }));
        if (request.operation === 'prompts/list') {
          const prompts = result.prompts as McpPromptDeclaration[];
          if (record.nativeClient === client && record.promptRevision === promptRevision) {
            for (const prompt of prompts) record.prompts.set(prompt.name, structuredClone(prompt));
          }
          return { result, promptVersions: prompts.map(prompt => ({ name: prompt.name, schemaVersion: this.#promptVersion(service, prompt) })) };
        }
        return { result };
      });
    } catch (error) {
      if (!dispatched && error instanceof McpAuthorityError) throw error;
      // This original transport brand proves the request has stopped, not absence of effects.
      // Do not infer this settlement from an HTTP status, remote result or error message.
      if (error instanceof McpSessionExpiredError) throw new McpAuthorityError('mcp-session-expired', dispatched, 'session_expired');
      throw new McpAuthorityError(signal.aborted ? 'mcp-call-interrupted' : 'mcp-call-failed', dispatched, receivedResponse ? 'rpc_response' : 'unknown', protocolError ?? (error instanceof McpError ? {code:error.code,message:error.message,...(error.data === undefined ? {} : {data:error.data})} : undefined),interactionProblem);
    } finally { scope.inflight--; this.#drainScope(scope); }
  }

  async resources(scopeHandle: string, handle: string, operation: 'readResource' | 'resourcesPage' | 'resourceTemplatesPage' | 'allResources' | 'allResourceTemplates', value: string | undefined, signal: AbortSignal): Promise<unknown> {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle); this.#assertConnection(scope, record);
    scope.inflight++;
    try {
    const options = { signal: AbortSignal.any([signal, record.shutdown.signal, scope.shutdown.signal]), timeoutMs: record.connection.timeoutMs,
      beforeDispatch: async () => {
        await this.#assertCredential(record); this.#assertConnection(scope, record);
        if (signal.aborted || scope.shutdown.signal.aborted) fail('mcp-call-cancelled');
      },
    };
    switch (operation) {
      case 'readResource': if (!value) fail('mcp-resource-uri-required'); return await record.connection.readResource(value, options);
      case 'resourcesPage': return await record.connection.resourcesPage(value, options);
      case 'resourceTemplatesPage': return await record.connection.resourceTemplatesPage(value, options);
      case 'allResources': return await record.connection.allResources(options);
      case 'allResourceTemplates': return await record.connection.allResourceTemplates(options);
    }
    } finally { scope.inflight--; this.#drainScope(scope); }
  }

  async reconnect(scopeHandle: string, handle: string): Promise<McpOwnerConnectionSnapshot> {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle); this.#assertConnection(scope, record, undefined, undefined, true);
    await record.connection.reconnect().catch(() => undefined);
    this.#changed(scope.key, { kind: 'tools', server: record.entry.name });
    return this.snapshot(scopeHandle, handle);
  }
  async signIn(scopeHandle: string, handle: string, prompt: McpSignInPrompt): Promise<void> {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle); this.#assertConnection(scope, record, undefined, undefined, true);
    const connection = record.connection; if (!connection.oauthUrl) fail('mcp-oauth-unavailable');
    const runtime = await loadMcpRuntime();
    const credentials = this.#store(scope.scope.agentDir);
    const store = credentials.forServer(connection.name, connection.oauthUrl);
    let expectedGrant = this.#oauthGrant(scope.scope, connection);
    const assertCurrent = () => {
      if (scope.released || this.#closed || expectedGrant !== this.#oauthGrant(scope.scope, connection)) fail('mcp-sign-in-superseded');
      if (record.entry.scope !== 'extension') {
        const config = loadMcpConfig({ agentDir: scope.scope.agentDir, cwd: scope.scope.configCwd, projectTrusted: scope.scope.projectTrusted });
        const entry = config.servers.find(candidate => candidate.name === record.entry.name);
        if (config.errors.length || !entry || entry.config.enabled === false) fail('mcp-sign-in-superseded');
      }
    };
    await runtime.signInMcpServer({ serverUrl: connection.oauthUrl,
      store: { load: () => { assertCurrent(); return store.load(); }, save: async state => {
        assertCurrent(); await store.save(state); expectedGrant = this.#oauthGrant(scope.scope, connection);
      } },
      settings: connection.oauthSettings(), ...(connection.challenge ? { challenge: connection.challenge } : {}), prompt });
    for (const candidate of this.#pool.values()) if (candidate.scope.agentDir === scope.scope.agentDir
      && candidate.entry.name === record.entry.name && candidate.connection.oauthUrl === connection.oauthUrl) this.#revoke(candidate);
  }

  async signOut(scopeHandle: string, handle: string): Promise<boolean> {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle);
    if (!record.connection.oauthUrl) return false;
    const removed = this.#store(scope.scope.agentDir).remove(record.connection.name, record.connection.oauthUrl);
    // Sign-out revokes every connection using this credential source, including other work branches.
    for (const candidate of this.#pool.values()) if (candidate.scope.agentDir === scope.scope.agentDir && candidate.entry.name === record.entry.name
      && candidate.connection.oauthUrl === record.connection.oauthUrl) this.#revoke(candidate);
    await record.connection.signOut(); return removed;
  }

  async updateConfig(scopeHandle: string, name: string, patch: ConfigPatch, projectOverride = false): Promise<void> {
    const scope = this.#scope(scopeHandle); const entry = scope.entries.get(name); if (!entry) fail('mcp-server-not-configured');
    if (Object.keys(patch).some(key => !['enabled', 'exposure'].includes(key)) || (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      || (patch.exposure !== undefined && !['direct', 'codemode', 'deferred', 'hidden'].includes(patch.exposure))) fail('mcp-config-patch-invalid');
    const override = projectOverride ? scope.config.projectConfig : entry.override;
    if (projectOverride && (!scope.scope.projectTrusted || !override)) fail('mcp-project-untrusted');
    if (entry.scope !== 'extension') {
      const project = Boolean(override || entry.scope === 'project');
      const location = await resolveConfigDocumentPath(project ? scope.scope.configCwd : scope.scope.agentDir,
        project ? '.pi/mcp.json' : 'mcp.json', { extensions: ['.json'] });
      const editor = new ConfigTextFileEditor(location.path, 'json'); const current = await editor.read(); let content = current.content;
      for (const [key, value] of Object.entries(patch)) content = applyEdits(content, modify(content, ['mcpServers', name, key],
        !override && ((key === 'enabled' && value === true) || (key === 'exposure' && value === 'codemode')) ? undefined : value,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await editor.update(content, current.revision);
    }
    const next = { ...entry, ...(override ? { override } : {}), config: { ...entry.config, ...patch } };
    scope.entries.set(name, next);
    for (const record of this.#pool.values()) {
      if (record.scopeKey !== scope.key || record.entry.name !== name) continue;
      if (patch.enabled === false) this.#revoke(record);
      else if (scope.connections.get(name) === record) record.entry = next;
    }
    this.#changed(scope.key);
  }

  releaseConnection(scopeHandle: string, handle: string): void {
    const scope = this.#scope(scopeHandle); this.#releaseConnection(scope, this.#connection(scope, handle));
  }
  closeScope(handle: string): void {
    const scope = this.#scopes.get(handle); if (!scope || scope.released) return;
    scope.closeRequested = true;
    if (scope.retainedHolders > 0 && !this.#closed) return;
    scope.released = true; scope.shutdown.abort();
    this.#drainScope(scope);
  }
  disposeSession(sessionId: string): void { for (const scope of this.#scopes.values()) if (scope.scope.sessionId === sessionId) this.closeScope(scope.handle); }
  async close(): Promise<void> {
    this.#closed = true; this.#configWatches.close(); this.#fileWatches.clear(); this.#subscribers.clear();
    const scopes = [...this.#scopes.values()];
    for (const scope of scopes) this.closeScope(scope.handle);
    const records = [...this.#pool.values()]; for (const record of records) this.#revoke(record);
    const settled = await Promise.allSettled([...scopes.map(scope => scope.drain.promise), ...this.#closings]);
    this.#pool.clear(); this.#selected.clear();
    const failure = settled.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  #fileRevision(paths: readonly string[]): string {
    return stable(paths.map(path => {
      try { const stat = statSync(path, { bigint: true }); return [path, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing']; fail('mcp-config-source-unavailable'); }
    }));
  }
  #configRevision(scope: McpAuthorityScope): string {
    return this.#fileRevision([join(scope.agentDir, 'mcp.json'), ...(scope.projectTrusted ? [join(scope.configCwd, '.pi/mcp.json')] : [])]);
  }
  #configurationIdentity(scope: ScopeRecord, entry: McpServerEntry): string {
    const frozen = scope.definitions.get(entry.name);
    if (frozen !== undefined) return frozen;
    const config = entry.config;
    const sensitive = 'url' in config
      ? Boolean(Object.keys(config.headers ?? {}).length || config.oauth?.clientSecret || new URL(config.url).username || new URL(config.url).password || new URL(config.url).search)
      : Boolean(Object.keys(config.env ?? {}).length);
    // Keep configured source/transport semantics, excluding credential-bearing values. Inline
    // secrets have no entry-local external edit revision; use their actual source file metadata.
    const transport = 'url' in config ? { ...publicEntry(entry).config, auth: config.auth,
      oauth: config.oauth ? { ...config.oauth, clientSecret: config.oauth.clientSecret === undefined ? undefined : '[credential-source]' } : undefined }
      : { ...publicEntry(entry).config, args: config.args, cwd: config.cwd, environmentNames: Object.keys(config.env ?? {}).sort() };
    // Definition identity follows its real configuration source, independently of a
    // connection's execution directory. Scope/resource identities below remain distinct.
    return createHash('sha256').update(stable([configuration(scope.scope), entry.name, entry.source, entry.override ?? null,
      transport, sensitive ? this.#fileRevision([entry.source, ...(entry.override ? [entry.override] : [])]) : null])).digest('hex');
  }
  #resourceKey(scope: ScopeRecord, entry: McpServerEntry): string {
    return `mcp:${createHash('sha256').update(stable([scope.scope.resourceOwner, scope.scope.agentDir, scope.scope.configCwd, scope.scope.executionCwd, scope.scope.environmentId, entry.name])).digest('hex')}`;
  }
  #connectionKey(scope: ScopeRecord, entry: McpServerEntry): string {
    return stable([scope.key, entry.name, entry.config, entry.scope === 'extension' ? [scope.scope.sessionId, entry.source] : entry.source]);
  }
  #inspectScope(scope: ScopeRecord, selected: ReadonlySet<string>): McpAuthorityInspection {
    const servers = [...scope.entries.values()].map((entry): McpAuthorityServerReadiness => {
      const current = this.#pool.get(this.#connectionKey(scope, entry));
      const observation = this.#observations.get(this.#connectionKey(scope, entry));
      const previous = this.#selected.get(stable([scope.key, entry.name]));
      const connection = current ?? previous;
      const status = entry.config.enabled === false ? 'disabled' : current?.revoked ? 'closed'
        : current ? current.connection.state : previous ? 'stale' : observation?.status ?? 'unprepared';
      return { name: entry.name, description: entry.config.description ?? '', resourceKey: this.#resourceKey(scope, entry),
        hasDirectTools: entry.config.exposure === 'direct' || Object.values(entry.config.toolExposure ?? {}).includes('direct'), exposure: entry.config.exposure ?? 'codemode',
        configurationScope: entry.scope ?? 'global', executionScope: scope.scope.executionScope, status,
        cachedToolCount: connection?.connection.tools.length ?? observation?.toolCount ?? 0,
        connectedToolCount: status === 'connected' ? current?.connection.tools.length ?? 0 : 0, selected: selected.has(entry.name) };
    });
    return freeze({ configErrorCount: scope.config.errors.length, configuredServerCount: servers.length,
      connectedServerCount: servers.filter(server => server.status === 'connected').length,
      cachedToolCount: servers.reduce((count, server) => count + server.cachedToolCount, 0), servers });
  }
  #drainScope(scope: ScopeRecord): void {
    if (!scope.released || scope.inflight > 0) return;
    for (const connection of [...scope.connections.values()]) this.#releaseConnection(scope, connection);
    if (scope.preparations || scope.closings.size) return;
    this.#scopes.delete(scope.handle);
    if (scope.closeError !== undefined) scope.drain.reject(scope.closeError);
    else scope.drain.resolve();
  }
  #scope(handle: string): ScopeRecord { const scope = this.#scopes.get(handle); if (!scope || scope.released) fail('mcp-scope-released'); return scope; }
  #connection(scope: ScopeRecord, handle: string): ConnectionRecord {
    const record = [...scope.connections.values()].find(candidate => candidate.handle === handle); if (!record) fail('mcp-connection-not-owned'); return record;
  }
  #store(agentDir: string): McpOAuthCredentialStore {
    let store = this.#credentials.get(agentDir); if (!store) { store = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(agentDir, 'mcp-auth.json')), agentDir); this.#credentials.set(agentDir, store); } return store;
  }
  #oauthGrant(scope: McpAuthorityScope, connection: McpServerConnection): string {
    return connection.oauthUrl ? stable(this.#store(scope.agentDir).binding(connection.name, connection.oauthUrl) ?? null) : 'none';
  }
  #toolVersion(record: ConnectionRecord, tool: McpTool): string {
    // Persisted target versions bind the declaration AND opaque credential grant, never a token.
    return createHash('sha256').update(stable([tool, taskCapabilities(record.nativeClient), record.nativeClient?.protocolVersion ?? null, record.configIdentity, record.oauthGrant, record.providerGrant ?? null])).digest('hex');
  }
  async #assertCredential(record: ConnectionRecord): Promise<void> {
    if (record.oauthGrant !== this.#oauthGrant(record.scope, record.connection)) { this.#revoke(record, 'mcp-credential-revoked'); fail('mcp-credential-revoked'); }
    if (record.provider && (!this.#options.credentialScope || stable(await this.#options.credentialScope(record.scope, record.provider)) !== record.providerGrant)) {
      this.#revoke(record, 'mcp-credential-revoked'); fail('mcp-credential-revoked');
    }
  }
  #assertConnection(scope: ScopeRecord, record: ConnectionRecord, tool?: string, schemaVersion?: string, discovery = false): void {
    if (scope.released || record.revoked || this.#closed) fail('mcp-owner-revoked');
    if (record.oauthGrant !== this.#oauthGrant(scope.scope, record.connection)) { this.#revoke(record, 'mcp-credential-revoked'); fail('mcp-credential-revoked'); }
    if (record.entry.scope !== 'extension') {
      const current = loadMcpConfig({ agentDir: scope.scope.agentDir, cwd: scope.scope.configCwd, projectTrusted: scope.scope.projectTrusted });
      if (current.errors.length) fail('mcp-config-invalid');
      const entry = current.servers.find(candidate => candidate.name === record.entry.name);
      if (!entry || entry.config.enabled === false) { this.#revoke(record); fail('mcp-owner-revoked'); }
      if (tool ? getMcpToolExposure(entry.config, tool) === 'hidden' : !discovery && entry.config.exposure === 'hidden') fail('mcp-tool-revoked');
    }
    if (tool) {
      const definition = record.connection.tools.find(candidate => candidate.name === tool);
      if (!definition || this.#toolVersion(record, definition) !== schemaVersion || getMcpToolExposure(record.entry.config, tool) === 'hidden') fail('mcp-schema-generation-mismatch');
    }
  }
  #revoke(record: ConnectionRecord, reason = 'mcp-owner-revoked'): void {
    if (record.revoked) return;
    record.revoked = true; record.revocationReason = reason; record.shutdown.abort();
    this.#closeConnection(record); this.#collect(record); this.#changed(record.scopeKey,
      {kind:reason==='mcp-credential-revoked'?'credentials':'configuration'});
  }
  #releaseConnection(scope: ScopeRecord, record: ConnectionRecord): void {
    if (scope.connections.get(record.entry.name) !== record) return;
    scope.connections.delete(record.entry.name); record.references--; this.#collect(record);
    // A sibling's live reference is not ours to stop or wait for. An already closing or
    // last-reference connection belongs to this scope's original drainage barrier.
    const closing = record.closing;
    if (closing && !scope.closings.has(closing)) {
      scope.closings.add(closing);
      void closing.then(() => {
        scope.closings.delete(closing); this.#drainScope(scope);
      }, error => {
        scope.closeError ??= error;
        scope.closings.delete(closing); this.#drainScope(scope);
      });
    }
  }
  #collect(record: ConnectionRecord): void {
    if (record.references > 0) return;
    // The pool is a shared owner, not a permanent daemon: the last lease reclaims the transport.
    this.#observations.set(record.key, { status: record.revoked ? 'closed' : record.connection.state === 'connected' ? 'unprepared' : record.connection.state, toolCount: record.connection.tools.length });
    if (this.#pool.get(record.key) === record) this.#pool.delete(record.key);
    const key = stable([record.scopeKey, record.entry.name]); if (this.#selected.get(key) === record) this.#selected.delete(key);
    this.#closeConnection(record);
  }
  #closeConnection(record: ConnectionRecord): void {
    if (record.closing) return;
    // SDK close waits for its opening connection, but internally suppresses some transport
    // failures. Its settlement is never promoted to native whole-process-tree evidence.
    const closing = Promise.resolve().then(() => record.connection.close()).catch(cause => {
      throw Object.assign(new McpAuthorityError('mcp-close-failed'), { cause });
    });
    record.closing = closing;
    this.#closings.add(closing);
    // Preserve a failed outcome for explicit drains/Host shutdown; never replace it with success.
    void closing.then(() => this.#closings.delete(closing), () => undefined);
  }
}

export { mcpHostAgentDir, mcpHostProjectTrusted, readMcpHostPermissionPolicy } from './mcp-host-configuration.js';
export { McpCompositions } from './mcp-compositions.js';
export type { McpCompositionScope, McpCompositionSelection } from './mcp-compositions.js';

export { composeMcpAuthorityLeases } from './mcp-lease-composition.js';
