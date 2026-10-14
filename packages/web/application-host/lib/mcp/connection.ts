/** One immutable server definition owns its preparation, client and independent directories. */
import { DEFAULT_REQUEST_TIMEOUT_MSEC, type ClientCapabilities, type AuthProvider } from '@modelcontextprotocol/client';
import { isModernMcpVersion } from './headers.js';
import { McpClient, type McpRequestOptions, type Tool, type Resource, type ResourceTemplate } from './client.js';
import { StdioTransport, StreamableHttpTransport, type McpTransport } from './transport.js';
import type { McpServerEntry } from './configuration.js';
import { resolve } from 'node:path';
import { McpOAuthCredentialStore, mcpAuthProvider, type McpOAuthSettings } from './auth.js';
export { signInMcpServer, type McpSignInPrompt } from './auth.js';
export type McpTransportFactory = (entry: McpServerEntry, cwd: string, authProvider: AuthProvider | undefined) => McpTransport;
const resolveValue = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
  const resolved = process.env[name]; if (resolved === undefined) throw new Error(`MCP environment variable is missing: ${name}`); return resolved;
});
export const mcpOAuthUrl = (entry: McpServerEntry): string | undefined => {
  const config = entry.config;
  return 'url' in config && !config.auth && !Object.keys(config.headers ?? {}).some(name => name.toLowerCase() === 'authorization') ? config.url : undefined;
};
export function createDefaultTransport(entry: McpServerEntry, cwd: string, authProvider?: AuthProvider, fetchImpl?: typeof fetch): McpTransport {
  const config = entry.config;
  if ('command' in config) return new StdioTransport({ command: resolveValue(config.command), args: config.args?.map(resolveValue) ?? [], cwd: config.cwd ? resolve(cwd, resolveValue(config.cwd)) : cwd,
    ...(config.env ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolveValue(value)])) } : {}) });
  return new StreamableHttpTransport(config.url, { ...(config.headers ? { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolveValue(value)])) } : {}),
    ...(authProvider ? { authProvider } : {}), ...(fetchImpl ? { fetch: (url, init) => fetchImpl(url, init) } : {}) });
}
type Options = {
  entry: McpServerEntry; cwd: string; createTransport: McpTransportFactory; credentials: McpOAuthCredentialStore;
  fetch?: typeof globalThis.fetch;
  providerToken?(provider: string): Promise<string | undefined>;
  onTools(connection: McpServerConnection): void; onChange?(connection: McpServerConnection): void;
  clientCapabilities?: ClientCapabilities; onClientCreated?(client: McpClient): void;
};
type CallOptions = McpRequestOptions & { beforeDispatch?: () => void | Promise<void> };
export class McpServerConnection {
  readonly entry: McpServerEntry;
  state: 'connecting' | 'connected' | 'disconnected' | 'needs-auth' | 'failed' | 'closed' = 'disconnected';
  error: string | undefined;
  tools: Tool[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  prompts: { name: string; description?: string; arguments?: unknown[] }[] = [];
  readonly directoriesReady = new Set<'tools' | 'resources' | 'resourceTemplates' | 'prompts'>();
  hasResources = false;
  instructions: string | undefined;
  challenge: unknown;
  readonly #shutdown = new AbortController();
  #client: McpClient | undefined;
  #opening: Promise<McpClient> | undefined;
  #toolsReady: { client: McpClient; work: Promise<void> } | undefined;
  readonly #directories = new Set<Promise<void>>();
  constructor(readonly options: Options) { this.entry = structuredClone(options.entry); }
  get name() { return this.entry.name; }
  get timeoutMs() { return this.entry.config.timeout === undefined ? DEFAULT_REQUEST_TIMEOUT_MSEC : this.entry.config.timeout * 1000; }
  get oauthUrl(): string | undefined {
    return mcpOAuthUrl(this.entry);
  }
  oauthSettings(): McpOAuthSettings {
    const settings = 'url' in this.entry.config ? { ...this.entry.config.oauth } : {};
    if (settings.clientSecret !== undefined) settings.clientSecret = resolveValue(settings.clientSecret);
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
      opened.onClose(() => { if (this.#client === opened && !this.#shutdown.signal.aborted) { this.#client = undefined; this.state = 'disconnected'; this.options.onChange?.(this); } });
      await opened.connect(transport, this.#shutdown.signal);
      this.#shutdown.signal.throwIfAborted();
      this.#client = opened;
      this.hasResources = !!opened.serverCapabilities?.resources;
      this.directoriesReady.clear();
      this.instructions = opened.instructions;
      opened.onNotification('notifications/tools/list_changed', () => { this.#track(this.#refreshTools(opened)); });
      opened.onNotification('notifications/resources/list_changed', () => { this.#track(this.#refreshResources(opened)); });
      opened.onNotification('notifications/prompts/list_changed', () => { this.#track(this.#refreshPrompts(opened)); });
      if (isModernMcpVersion(opened.protocolVersion)) {
        const capabilities = opened.serverCapabilities;
        const filter = { ...(capabilities?.tools?.listChanged ? { toolsListChanged: true } : {}),
          ...(capabilities?.resources?.listChanged ? { resourcesListChanged: true } : {}),
          ...(capabilities?.prompts?.listChanged ? { promptsListChanged: true } : {}) };
        if (Object.keys(filter).length) this.#track(opened.listen(filter, this.#shutdown.signal).then(() => {}));
      }
      if (this.hasResources) this.#track(this.#refreshResources(opened));
      else { this.resources = []; this.resourceTemplates = []; this.directoriesReady.add('resources'); this.directoriesReady.add('resourceTemplates'); }
      if (opened.serverCapabilities?.prompts) this.#track(this.#refreshPrompts(opened));
      else { this.prompts = []; this.directoriesReady.add('prompts'); }
      // Tool callers wait only for their tools. Resources/prompts cannot delay this publication.
      await this.#refreshTools(opened);
      this.state = 'connected'; this.options.onChange?.(this);
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
  #refreshTools(client: McpClient) {
    if (this.#toolsReady?.client === client) return this.#toolsReady.work;
    const work = (async () => {
      const tools = client.serverCapabilities?.tools ? await client.listTools({ signal: this.#shutdown.signal, timeoutMs: this.timeoutMs }) : [];
      if (this.#client !== client) return;
      this.tools = tools; this.directoriesReady.add('tools'); this.options.onTools(this);
    })();
    const pending = { client, work };
    this.#toolsReady = pending;
    void work.then(() => { if (this.#toolsReady === pending) this.#toolsReady = undefined; }, () => { if (this.#toolsReady === pending) this.#toolsReady = undefined; });
    return work;
  }
  async #refreshResources(client: McpClient) {
    const [resources, templates] = await Promise.allSettled([client.listResources({ signal: this.#shutdown.signal, timeoutMs: this.timeoutMs }), client.listResourceTemplates({ signal: this.#shutdown.signal, timeoutMs: this.timeoutMs })]);
    if (this.#client !== client) return;
    if (resources.status === 'fulfilled') { this.resources = resources.value; this.directoriesReady.add('resources'); }
    if (templates.status === 'fulfilled') { this.resourceTemplates = templates.value; this.directoriesReady.add('resourceTemplates'); }
    this.options.onChange?.(this);
  }
  async #refreshPrompts(client: McpClient) {
    const prompts = await client.listPrompts({ signal: this.#shutdown.signal, timeoutMs: this.timeoutMs });
    if (this.#client !== client) return;
    this.prompts = prompts; this.directoriesReady.add('prompts'); this.options.onChange?.(this);
  }
  async requestOnce<T>(run: (client: McpClient) => Promise<T>) { return run(await this.getClient()); }
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.callTool(name, args, options); }); }
  async readResource(uri: string, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.readResource(uri, options); }); }
  async resourcesPage(cursor: string | undefined, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResourcesPage(cursor, options); }); }
  async resourceTemplatesPage(cursor: string | undefined, options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResourceTemplatesPage(cursor, options); }); }
  async allResources(options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResources(options); }); }
  async allResourceTemplates(options: CallOptions) { return this.requestOnce(async client => { await options.beforeDispatch?.(); return client.listResourceTemplates(options); }); }
  async reconnect() { const old = this.#client; this.#client = undefined; await old?.close(); await this.getClient(); }
  async signOut() { await this.#client?.close(); this.#client = undefined; this.state = 'needs-auth'; }
  async close() {
    this.#shutdown.abort();
    await this.#opening?.catch(() => undefined);
    await this.#client?.close();
    await Promise.allSettled([...this.#directories]);
    this.#client = undefined; this.state = 'closed';
  }
}
