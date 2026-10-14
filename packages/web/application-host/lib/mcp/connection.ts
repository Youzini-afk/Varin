/** One immutable server definition owns its preparation, client and independent directories. */
import { DEFAULT_REQUEST_TIMEOUT_MSEC, type ClientCapabilities, type AuthProvider } from '@modelcontextprotocol/client';
import { isModernMcpVersion } from './headers.js';
import { McpClient, type McpRequestOptions, type Tool, type Resource, type ResourceTemplate } from './client.js';
import { StdioTransport, StreamableHttpTransport, McpSessionExpiredError, type McpTransport } from './transport.js';
import { mcpEnvironmentBindings, mcpEnvironmentCurrent, type McpServerEntry } from './configuration.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { McpOAuthCredentialStore, mcpAuthProvider, type McpOAuthSettings } from './auth.js';
export { signInMcpServer, type McpSignInPrompt } from './auth.js';
export type McpTransportFactory = (entry: McpServerEntry, cwd: string, authProvider: AuthProvider | undefined) => McpTransport;
const environments = new WeakMap<McpServerEntry, Readonly<Record<string, string | undefined>>>();
const resolveValue = (value: string, environment: Readonly<Record<string, string | undefined>> = process.env) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
  const resolved = environment[name]; if (resolved === undefined) throw new Error(`MCP environment variable is missing: ${name}`); return resolved;
});
export const mcpOAuthUrl = (entry: McpServerEntry): string | undefined => {
  const config = entry.config;
  return 'url' in config && !config.auth && !Object.keys(config.headers ?? {}).some(name => name.toLowerCase() === 'authorization') ? config.url : undefined;
};
export function createDefaultTransport(entry: McpServerEntry, cwd: string, authProvider?: AuthProvider, fetchImpl?: typeof fetch): McpTransport {
  const config = entry.config;
  const resolveEnvironment = (value: string) => resolveValue(value, environments.get(entry) ?? process.env);
  if ('command' in config) return new StdioTransport({ command: resolveEnvironment(config.command), args: config.args?.map(resolveEnvironment) ?? [], cwd: config.cwd ? resolve(cwd, resolveEnvironment(config.cwd)) : cwd,
    ...(config.env ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolveEnvironment(value)])) } : {}) });
  return new StreamableHttpTransport(config.url, { ...(config.headers ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolveEnvironment(value)])) } : {}),
    ...(authProvider ? { authProvider } : {}), ...(fetchImpl ? { fetch: (url, init) => fetchImpl(url, init) } : {}) });
}
type Options = {
  entry: McpServerEntry; cwd: string; createTransport: McpTransportFactory; credentials: McpOAuthCredentialStore;
  fetch?: typeof globalThis.fetch;
  providerToken?(provider: string): Promise<string | undefined>;
  onTools(connection: McpServerConnection): void; onChange?(connection: McpServerConnection): void;
  clientCapabilities?: ClientCapabilities; onClientCreated?(client: McpClient): void;
};
export type McpDirectoryKind = 'tools' | 'resources' | 'resourceTemplates' | 'prompts';
export type McpDirectoryState = 'unprepared' | 'refreshing' | 'ready' | 'failed' | 'needs-auth';
type CallOptions = McpRequestOptions & { beforeDispatch?: () => void | Promise<void> };
export class McpServerConnection {
  readonly entry: McpServerEntry;
  readonly environmentBindings: Readonly<Record<string, string | undefined>>;
  readonly environmentIdentity: string | undefined;
  state: 'connecting' | 'connected' | 'disconnected' | 'needs-auth' | 'failed' | 'closed' = 'disconnected';
  error: string | undefined;
  tools: Tool[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  prompts: { name: string; description?: string; arguments?: unknown[] }[] = [];
  readonly directoriesReady = new Set<McpDirectoryKind>();
  readonly directoryStates: Record<McpDirectoryKind, McpDirectoryState> = { tools: 'unprepared', resources: 'unprepared', resourceTemplates: 'unprepared', prompts: 'unprepared' };
  hasResources = false;
  instructions: string | undefined;
  challenge: unknown;
  readonly #shutdown = new AbortController();
  #client: McpClient | undefined;
  #opening: Promise<McpClient> | undefined;
  #clientLifetime: AbortController | undefined;
  readonly #directoryWork = new Map<McpDirectoryKind, { client: McpClient; work: Promise<void>; dirty: boolean }>();
  readonly #directories = new Set<Promise<void>>();
  constructor(readonly options: Options) {
    this.entry = structuredClone(options.entry);
    this.environmentBindings = mcpEnvironmentBindings(this.entry);
    this.environmentIdentity = Object.keys(this.environmentBindings).length ? randomUUID() : undefined;
    environments.set(this.entry, this.environmentBindings);
  }
  get environmentCurrent() { return mcpEnvironmentCurrent(this.environmentBindings); }
  get name() { return this.entry.name; }
  get timeoutMs() { return this.entry.config.timeout === undefined ? DEFAULT_REQUEST_TIMEOUT_MSEC : this.entry.config.timeout * 1000; }
  get oauthUrl(): string | undefined {
    return mcpOAuthUrl(this.entry);
  }
  oauthSettings(): McpOAuthSettings {
    const settings = 'url' in this.entry.config ? { ...this.entry.config.oauth } : {};
    if (settings.clientSecret !== undefined) settings.clientSecret = resolveValue(settings.clientSecret, this.environmentBindings);
    return settings;
  }
  async getClient(): Promise<McpClient> {
    this.#shutdown.signal.throwIfAborted();
    if (this.#client?.connectionState === 'connected') return this.#client;
    if (!this.#opening) {
      const work = this.#open(); this.#opening = work;
      void work.then(() => { if (this.#opening === work) this.#opening = undefined; }, () => { if (this.#opening === work) this.#opening = undefined; });
    }
    return this.#opening;
  }
  async #open() {
    this.state = 'connecting'; this.error = undefined; this.options.onChange?.(this);
    let client: McpClient | undefined;
    try {
      const config = this.entry.config;
      const provider = 'url' in config ? config.auth?.provider : undefined;
      const authorization: AuthProvider | undefined = provider ? { token: () => this.options.providerToken?.(provider) ?? Promise.resolve(undefined) }
        : this.oauthUrl ? mcpAuthProvider(this.name, this.oauthUrl, this.options.credentials, this.oauthSettings(), this.options.fetch) : undefined;
      const transport = this.options.createTransport(this.entry, this.options.cwd, authorization);
      const opened = new McpClient({ name: 'Varin', version: '1', ...(this.options.clientCapabilities ? { capabilities: this.options.clientCapabilities } : {}) });
      client = opened;
      this.options.onClientCreated?.(opened);
      opened.onClose(() => this.#disconnected(opened));
      opened.onError(error => { if (error instanceof McpSessionExpiredError) { this.#disconnected(opened); this.#track(opened.close()); } });
      await opened.connect(transport, this.#shutdown.signal);
      this.#shutdown.signal.throwIfAborted();
      this.#client = opened;
      this.#clientLifetime = new AbortController();
      this.hasResources = !!opened.serverCapabilities?.resources;
      this.directoriesReady.clear();
      for (const kind of Object.keys(this.directoryStates) as McpDirectoryKind[]) this.directoryStates[kind] = 'unprepared';
      this.instructions = opened.instructions;
      opened.onNotification('notifications/tools/list_changed', () => { this.#track(this.#refreshDirectory(opened, 'tools', true)); });
      opened.onNotification('notifications/resources/list_changed', () => {
        this.#track(this.#refreshDirectory(opened, 'resources', true));
        this.#track(this.#refreshDirectory(opened, 'resourceTemplates', true));
      });
      opened.onNotification('notifications/prompts/list_changed', () => { this.#track(this.#refreshDirectory(opened, 'prompts', true)); });
      if (isModernMcpVersion(opened.protocolVersion)) {
        const capabilities = opened.serverCapabilities;
        const filter = { ...(capabilities?.tools?.listChanged ? { toolsListChanged: true } : {}),
          ...(capabilities?.resources?.listChanged ? { resourcesListChanged: true } : {}),
          ...(capabilities?.prompts?.listChanged ? { promptsListChanged: true } : {}) };
        if (Object.keys(filter).length) this.#track(opened.listen(filter, this.#clientSignal()).then(() => {}));
      }
      // A handshake publishes the connection. Every directory owns a separate preparation
      // and commit; callers join only the declarations their operation actually needs.
      this.state = 'connected';
      for (const kind of Object.keys(this.directoryStates) as McpDirectoryKind[]) this.#track(this.#refreshDirectory(opened, kind));
      this.options.onChange?.(this);
      return opened;
    } catch (error) {
      await client?.close();
      if (this.#client === client) this.#client = undefined;
      this.state = this.#shutdown.signal.aborted ? 'closed' : error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403) ? 'needs-auth' : 'failed';
      this.error = this.state === 'needs-auth' ? 'MCP sign-in required' : 'MCP connection unavailable';
      this.challenge = error && typeof error === 'object' && 'wwwAuthenticate' in error ? error.wwwAuthenticate : undefined;
      this.options.onChange?.(this); throw error;
    }
  }
  #track(work: Promise<void>) {
    this.#directories.add(work);
    void work.then(() => this.#directories.delete(work), () => { this.#directories.delete(work); this.options.onChange?.(this); });
  }
  #clientSignal() { return AbortSignal.any([this.#shutdown.signal, this.#clientLifetime!.signal]); }
  #disconnected(client: McpClient) {
    if (this.#client !== client) return;
    this.#client = undefined;
    this.#clientLifetime?.abort();
    this.directoriesReady.clear();
    for (const kind of Object.keys(this.directoryStates) as McpDirectoryKind[]) this.directoryStates[kind] = 'unprepared';
    this.state = this.#shutdown.signal.aborted ? 'closed' : 'disconnected';
    this.options.onChange?.(this);
  }
  #refreshDirectory(client: McpClient, kind: McpDirectoryKind, changed = false): Promise<void> {
    if (this.#client !== client) return Promise.resolve();
    const existing = this.#directoryWork.get(kind);
    if (existing?.client === client) {
      if (changed) existing.dirty = true;
      return existing.work;
    }
    const pending = { client, work: Promise.resolve(), dirty: false };
    const signal = this.#clientSignal();
    const work = Promise.resolve().then(async () => {
      do {
        pending.dirty = false;
        this.directoriesReady.delete(kind);
        this.directoryStates[kind] = 'refreshing';
        this.options.onChange?.(this);
        const options = { signal, timeoutMs: this.timeoutMs };
        const available = kind === 'resources' || kind === 'resourceTemplates' ? this.hasResources : !!client.serverCapabilities?.[kind];
        const values = !available ? [] : kind === 'tools' ? await client.listTools(options)
          : kind === 'resources' ? await client.listResources(options)
          : kind === 'resourceTemplates' ? await client.listResourceTemplates(options) : await client.listPrompts(options);
        if (this.#client !== client) return;
        // A list-change received during pagination invalidates the whole candidate. Do not
        // transiently publish an older list after the newer notification.
        if (pending.dirty) continue;
        if (kind === 'tools') this.tools = values as Tool[];
        else if (kind === 'resources') this.resources = values as Resource[];
        else if (kind === 'resourceTemplates') this.resourceTemplates = values as ResourceTemplate[];
        else this.prompts = values as typeof this.prompts;
        this.directoriesReady.add(kind);
        this.directoryStates[kind] = 'ready';
        if (kind === 'tools') this.options.onTools(this);
        this.options.onChange?.(this);
      } while (pending.dirty);
    }).catch(error => {
      if (this.#client === client) {
        this.directoriesReady.delete(kind);
        const needsAuth = !!error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403);
        this.directoryStates[kind] = needsAuth ? 'needs-auth' : 'failed';
        if (needsAuth && 'wwwAuthenticate' in error) this.challenge = error.wwwAuthenticate;
        this.options.onChange?.(this);
      }
      throw error;
    });
    pending.work = work;
    this.#track(work);
    this.#directoryWork.set(kind, pending);
    void work.then(() => { if (this.#directoryWork.get(kind) === pending) this.#directoryWork.delete(kind); },
      () => { if (this.#directoryWork.get(kind) === pending) this.#directoryWork.delete(kind); });
    return work;
  }
  async getToolsClient(): Promise<McpClient> {
    const client = await this.getClient();
    if (!this.directoriesReady.has('tools')) await this.#refreshDirectory(client, 'tools');
    if (this.#client !== client || client.connectionState !== 'connected') throw new Error('MCP connection unavailable');
    return client;
  }
  async requestOnce<T>(run: (client: McpClient) => Promise<T>) { return run(await this.getClient()); }
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions) { await this.getToolsClient(); return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.callTool(name, args, options); }); }
  async readResource(uri: string, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.readResource(uri, options); }); }
  async resourcesPage(cursor: string | undefined, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResourcesPage(cursor, options); }); }
  async resourceTemplatesPage(cursor: string | undefined, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResourceTemplatesPage(cursor, options); }); }
  async allResources(options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResources(options); }); }
  async allResourceTemplates(options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResourceTemplates(options); }); }
  async reconnect() { const old = this.#client; if (old) this.#disconnected(old); await old?.close(); await this.getClient(); }
  async signOut() { await this.#client?.close(); this.#client = undefined; this.state = 'needs-auth'; }
  async close() {
    this.#shutdown.abort();
    await this.#opening?.catch(() => undefined);
    await this.#client?.close();
    await Promise.allSettled([...this.#directories]);
    this.#client = undefined; this.state = 'closed';
  }
}
