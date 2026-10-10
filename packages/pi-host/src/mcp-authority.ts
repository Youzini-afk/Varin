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
import type { McpOwnerConfig, McpOwnerConnectionSnapshot, McpOwnerEntry, McpConfiguration, McpProvenance } from '@varin/protocol';
import { ConfigTextFileEditor, resolveConfigDocumentPath } from './config-text-file-editor.js';
import { ConfigWatchManager } from './config-watch-manager.js';

export interface McpAuthorityScope {
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
export interface McpAuthorityOptions {
  providerToken?: (scope: McpAuthorityScope, provider: string) => Promise<string | undefined>;
  credentialScope?: (scope: McpAuthorityScope, provider: string) => Promise<{
    reference: string; generation: number; authority?: string; account?: string;
  }>;
  /** Test/embedding transport seam. Production defaults to the SDK's stdio/HTTP transports. */
  createTransport?: McpTransportFactory;
}
export interface McpAuthorityTool {
  name: string;
  server: string;
  tool: string;
  schemaVersion: string;
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
  /** Frozen configuration dependencies, checked before opening any selected transport.
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
  assertCallable(name: string, schemaVersion: string): void;
  revocationSignal(name: string, schemaVersion: string): AbortSignal;
  validateArguments(name: string, schemaVersion: string, arguments_: unknown): void;
  callTool(name: string, arguments_: Record<string, unknown>, options: { schemaVersion: string; signal: AbortSignal; beforeDispatch?: () => void | Promise<void> }): ReturnType<McpServerConnection['callTool']>;
  release(): void;
}
/** A pre-dispatch rejection is safe to record as no effect; an entered transport is uncertain. */
export class McpAuthorityError extends Error {
  constructor(readonly code: string, readonly dispatched = false) { super(code); this.name = 'McpAuthorityError'; }
}
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
  shutdown: AbortController;
}
interface ConnectionRecord {
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
  return { ...input, agentDir: resolve(input.agentDir), configCwd: resolve(input.configCwd), executionCwd: resolve(input.executionCwd) };
}
function scopeKey(scope: McpAuthorityScope): string {
  return stable([scope.agentDir, scope.configCwd, scope.executionCwd, scope.environmentId, scope.executionScope, scope.projectTrusted]);
}
function configuration(scope: McpAuthorityScope): McpConfiguration {
  return { agent_dir: scope.agentDir, config_cwd: scope.configCwd, project_trusted: scope.projectTrusted };
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
    const config = loadMcpConfig({ agentDir: scope.agentDir, cwd: scope.configCwd, projectTrusted: scope.projectTrusted });
    if (configRevision !== this.#configRevision(scope)) fail('mcp-config-changed');
    const record: ScopeRecord = { handle: randomUUID(), scope, key, config, configRevision, entries: new Map(config.servers.map(entry => [entry.name, entry])), definitions: new Map(), connections: new Map(), released: false, inflight: 0, shutdown: new AbortController() };
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

  async acquire(scope: McpAuthorityScope, options: McpAuthorityAcquireOptions): Promise<McpAuthorityLease> {
    const opened = this.open(scope);
    const record = this.#scope(opened.scope);
    const abort = () => this.closeScope(opened.scope);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      if (record.released) fail('mcp-preparation-cancelled');
      if (options.provenance) {
        if (options.provenance.execution_scope !== record.scope.executionScope
          || stable(options.provenance.configuration) !== stable(configuration(record.scope))) fail('mcp_configuration_source_changed');
        for (const [name, selected] of Object.entries(options.provenance.servers)) {
          const entry = record.entries.get(name);
          if (!entry || entry.config.enabled === false) fail('mcp_saved_definition_unavailable');
          if (this.#configurationIdentity(record, entry) !== selected.definition_version) {
            // An accepted delegation can use the original retained definition after ordinary
            // configuration replacement. Source, revocation and execution scope remain owned
            // here; no persisted copy or latest-definition substitution is introduced.
            const original = [...this.#scopes.values()].find(candidate => candidate !== record && !candidate.released
              && candidate.scope.executionScope === record.scope.executionScope
              && stable(configuration(candidate.scope)) === stable(configuration(record.scope))
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
            executionScope: connection.scope.executionScope, inputSchema: structuredClone(tool.inputSchema),
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
      const discover = async (server: string, signal: AbortSignal): Promise<readonly McpAuthorityTool[]> => {
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
        return freeze(project(connection));
      };
      const readiness = this.#inspectScope(record, selected);
      return {
        implementationIdentity: createHash('sha256').update(stable([record.key,handles.map(connection=>connection.handle).sort(),
          [...record.entries.values()].map(entry=>this.#configurationIdentity(record,entry)).sort()])).digest('hex'),
        binding: freeze({ provenance: { execution_scope: record.scope.executionScope, configuration: configuration(record.scope), servers: Object.fromEntries(
          [...record.entries.values()].filter(entry => entry.config.enabled !== false && entry.config.exposure !== 'hidden').map(entry => [entry.name, {
            definition_version: this.#configurationIdentity(record, entry), resource_key: this.#resourceKey(record, entry),
          }])) }, reference: `mcp-owner:${createHash('sha256').update(record.key).digest('hex')}`,
          generation: 1 + Number.parseInt(createHash('sha256').update(stable([record.key,
            [...record.entries.values()].map(entry => ({ name: entry.name, identity: this.#configurationIdentity(record, entry) })).sort((a, b) => a.name.localeCompare(b.name)),
            tools])).digest('hex').slice(0, 12), 16),
          tools, readiness, servers: readiness.servers,
          serverSelections: [...record.entries.values()].map(entry=>({name:entry.name,configurationVersion:this.#configurationIdentity(record,entry),
            hiddenTools:Object.entries(entry.config.toolExposure ?? {}).filter(([,exposure])=>exposure==='hidden').map(([name])=>name)})) }),
        inspect: () => { if (released || record.released) fail('mcp-lease-released'); return this.#inspectScope(record, selected); },
        discover,
        prepareTool: async (server, tool, schemaVersion, signal) => {
          const declarations = await discover(server, signal);
          const target = declarations.find(candidate => candidate.tool === tool);
          if (!target || target.schemaVersion !== schemaVersion) fail('mcp-schema-generation-mismatch');
          assert(target.name, schemaVersion); return target;
        },
        assertCallable: (name, schemaVersion) => { assert(name, schemaVersion); },
        revocationSignal: (name, schemaVersion) => assert(name,schemaVersion).connection.shutdown.signal,
        validateArguments,
        callTool: async (name, args, options) => {
          validateArguments(name, options.schemaVersion, args);
          const target = assert(name, options.schemaVersion);
          return this.callTool(record.handle, target.connection.handle, target.tool.name, options.schemaVersion, args, options.signal, options.beforeDispatch);
        },
        release: () => { if (!released) { released = true; this.closeScope(record.handle); } },
      };
    } catch (error) { this.closeScope(record.handle); throw error; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }

  async connect(scopeHandle: string, requested: McpOwnerEntry): Promise<McpOwnerConnectionSnapshot> {
    const scope = this.#scope(scopeHandle);
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
    if (existing?.key === key && !existing.revoked) {
      await existing.ready;
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
          createTransport: this.#options.createTransport ?? runtime.createDefaultTransport,
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
          entry, connection, references: 0, retired: false, revoked: false, shutdown: new AbortController(),
          credentialRevision: 0, oauthGrant: this.#oauthGrant(scope.scope, connection), provider, providerGrant, validators: new Map() };
        this.#pool.set(key, record);
        const selected = record;
        record.ready = connection.getClient().then(() => {
          if (selected.revoked) return;
          const selectionKey = stable([selected.scopeKey, selected.entry.name]);
          const previous = this.#selected.get(selectionKey);
          this.#selected.set(selectionKey, selected);
          if (previous && previous !== selected) { previous.retired = true; this.#collect(previous); }
        }).catch(() => undefined).finally(() => {
          // Initialization may create OAuth discovery state. No tool declaration has been leased yet.
          if (!selected.revoked) selected.oauthGrant = this.#oauthGrant(selected.scope, connection);
        }); // The explicit connection state preserves auth/connection failures.
      }
    }
    if (existing && existing !== record) this.#releaseConnection(scope, existing);
    if (scope.connections.get(entry.name) !== record) { record.references++; scope.connections.set(entry.name, record); }
    await record.ready;
    return this.snapshot(scopeHandle, record.handle);
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

  async callTool(scopeHandle: string, handle: string, tool: string, schemaVersion: string, args: Record<string, unknown>, signal: AbortSignal, beforeDispatch?: () => void | Promise<void>): ReturnType<McpServerConnection['callTool']> {
    const scope = this.#scope(scopeHandle); const record = this.#connection(scope, handle);
    this.#assertConnection(scope, record, tool, schemaVersion);
    const definition = record.connection.tools.find(candidate => candidate.name === tool)!;
    let validate = record.validators.get(schemaVersion);
    if (!validate) { validate = compile(definition); record.validators.set(schemaVersion, validate); }
    if (validate(args) !== true) fail('mcp-arguments-invalid');
    if (signal.aborted) fail('mcp-call-cancelled');
    scope.inflight++;
    try {
    await this.#assertCredential(record);
    // getClient may reconnect. Revalidate the exact declaration after it settles, before dispatch.
    try { await record.connection.getClient(); } catch { fail('mcp-connection-unavailable'); }
    this.#assertConnection(scope, record, tool, schemaVersion);
    if (signal.aborted) fail('mcp-call-cancelled');
    let dispatched = false;
    try { return await record.connection.callTool(tool, args, {
      signal: AbortSignal.any([signal, record.shutdown.signal, scope.shutdown.signal]), timeoutMs: record.connection.timeoutMs,
      beforeDispatch: async () => {
        await this.#assertCredential(record);
        await beforeDispatch?.();
        await this.#assertCredential(record);
        this.#assertConnection(scope, record, tool, schemaVersion);
        if (signal.aborted || record.shutdown.signal.aborted || scope.shutdown.signal.aborted) fail('mcp-call-cancelled');
        dispatched = true;
      },
    }); }
    catch (error) {
      if (!dispatched && error instanceof McpAuthorityError) throw error;
      throw new McpAuthorityError(signal.aborted || record.shutdown.signal.aborted || scope.shutdown.signal.aborted ? 'mcp-call-interrupted' : 'mcp-call-failed', dispatched);
    }
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
    scope.released = true; scope.shutdown.abort(); this.#scopes.delete(handle);
    this.#drainScope(scope);
  }
  disposeSession(sessionId: string): void { for (const scope of this.#scopes.values()) if (scope.scope.sessionId === sessionId) this.closeScope(scope.handle); }
  async close(): Promise<void> {
    this.#closed = true; this.#configWatches.close(); this.#fileWatches.clear(); this.#subscribers.clear();
    for (const scope of [...this.#scopes.values()]) this.closeScope(scope.handle);
    const records = [...this.#pool.values()]; for (const record of records) this.#revoke(record);
    await Promise.all(this.#closings); this.#pool.clear(); this.#selected.clear();
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
    return `mcp:${createHash('sha256').update(stable([scope.scope.agentDir, scope.scope.configCwd, scope.scope.executionCwd, scope.scope.environmentId, entry.name])).digest('hex')}`;
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
    return createHash('sha256').update(stable([tool, record.configIdentity, record.oauthGrant, record.providerGrant ?? null])).digest('hex');
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
    const closing = record.connection.close().catch(() => undefined).finally(() => this.#closings.delete(closing));
    record.closing = closing;
    this.#closings.add(closing);
  }
}

export { mcpHostAgentDir, mcpHostProjectTrusted, readMcpHostPermissionPolicy } from './mcp-host-configuration.js';
export { McpCompositions } from './mcp-compositions.js';
export type { McpCompositionScope, McpCompositionSelection } from './mcp-compositions.js';
