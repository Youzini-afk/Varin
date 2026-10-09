/** Pi's MCP presentation/extension hooks delegate every privileged operation to the Host owner. */
import type { LoadedMcpConfig, McpConnectionHandle, McpExtensionOwner, McpServerConnection, McpServerEntry } from '@earendil-works/pi-coding-agent';
import type { McpOwnerConnectionSnapshot, McpOwnerEntry, McpOwnerRequest } from '@varin/protocol';
import type { HostServicesBridge } from './harness/host-services-bridge.js';

type CallOptions = Parameters<McpServerConnection['callTool']>[2];
export interface HostMcpOwner extends McpExtensionOwner { prepare(): Promise<void>; isSelected(): boolean }
export function createHostMcpOwner(bridge: Pick<HostServicesBridge, 'request'>, onConfig?: (config: LoadedMcpConfig) => void): HostMcpOwner {
  let scope: string | undefined;
  let closed = false;
  let epoch = 0;
  let prepare: (() => Promise<void>) | undefined;
  const connections = new Set<RemoteConnection>();
  const request = (params: McpOwnerRequest, signal?: AbortSignal) => bridge.request('mcp.owner', params, { timeoutMs: 0, ...(signal ? { signal } : {}) });
  const currentScope = () => { if (!scope || closed) throw new Error('MCP owner scope is closed'); return scope; };
  const capture = () => ({ scope: currentScope(), epoch });
  const assertCurrent = (ticket: { scope: string; epoch: number }) => {
    if (closed || ticket.epoch !== epoch || ticket.scope !== scope) throw new Error('MCP owner generation changed');
  };
  class RemoteConnection implements McpConnectionHandle {
    #snapshot: McpOwnerConnectionSnapshot;
    #released = false;
    constructor(readonly ticket: { scope: string; epoch: number }, snapshot: McpOwnerConnectionSnapshot, readonly callbacks: Parameters<McpExtensionOwner['createConnection']>[1], readonly originalEntry: McpServerEntry) { this.#snapshot = snapshot; }
    get handle() { return this.#snapshot.handle; }
    get entry() { return this.#snapshot.entry as unknown as McpServerEntry; }
    get name() { return this.entry.name; }
    get state() { return this.#released ? 'closed' as const : this.#snapshot.state; }
    get error() { return this.#snapshot.error; }
    get tools() { return this.#snapshot.tools as McpServerConnection['tools']; }
    get hasResources() { return this.#snapshot.hasResources; }
    get resources() { return this.#snapshot.resources as McpServerConnection['resources']; }
    get resourceTemplates() { return this.#snapshot.resourceTemplates as McpServerConnection['resourceTemplates']; }
    get instructions() { return this.#snapshot.instructions; }
    get timeoutMs() { return this.#snapshot.timeoutMs; }
    get oauthUrl() { return this.#snapshot.oauthUrl; }
    get credentialRevision() { return this.#snapshot.credentialRevision; }
    apply(snapshot: McpOwnerConnectionSnapshot) {
      try { this.assertOpen(); } catch (error) {
        // A reconnect/auth response may own a newly acquired Host handle even after this UI
        // generation ended. Release only that original scope; never borrow the replacement.
        void request({ operation: 'release', scope: this.ticket.scope, handle: snapshot.handle }).catch(() => undefined);
        throw error;
      }
      const changed = this.#snapshot.handle !== snapshot.handle || JSON.stringify(this.#snapshot.schemaVersions) !== JSON.stringify(snapshot.schemaVersions)
        || JSON.stringify(this.#snapshot.entry.config) !== JSON.stringify(snapshot.entry.config)
        || this.#snapshot.instructions !== snapshot.instructions || this.#snapshot.hasResources !== snapshot.hasResources;
      this.#snapshot = snapshot;
      if (changed) this.callbacks.onTools(this);
      this.assertOpen();
      this.callbacks.onChange(this);
    }
    assertOpen() { if (this.#released || !connections.has(this)) throw new Error('MCP connection lease is released'); assertCurrent(this.ticket); }
    retire() { this.#released = true; }
    async refresh() {
      this.assertOpen();
      const result = await request({ operation: 'snapshot', scope: this.ticket.scope, handle: this.handle });
      this.assertOpen();
      if (!result.connection) throw new Error('MCP owner returned no connection');
      if (result.connection.error === 'mcp-credential-revoked') {
        const rebound = await request({ operation: 'connect', scope: this.ticket.scope, entry: this.originalEntry as unknown as McpOwnerEntry });
        if (!rebound.connection) throw new Error('MCP owner returned no rebound connection');
        this.apply(rebound.connection);
      } else this.apply(result.connection);
    }
    async getClient() { await this.refresh(); if (this.state !== 'connected') throw new Error(this.error ?? 'MCP connection is not ready'); return this; }
    caller(tool: string) {
      // Capture at tool registration, rather than using a later mutable discovery snapshot.
      const schemaVersion = this.#snapshot.schemaVersions[tool];
      const handle = this.handle;
      return { callTool: async (name: string, args: Record<string, unknown>, options: CallOptions) => {
        this.assertOpen(); if (name !== tool || !schemaVersion) throw new Error('MCP declaration is not bound');
        const result = await request({ operation: 'callTool', scope: this.ticket.scope, handle, tool, schemaVersion, arguments: args }, options.signal);
        return result.value as Awaited<ReturnType<McpServerConnection['callTool']>>;
      } };
    }
    callTool(name: string, args: Record<string, unknown>, options: CallOptions) { return this.caller(name).callTool(name, args, options); }
    async readResource(uri: string, options: CallOptions) {
      this.assertOpen(); return (await request({ operation: 'readResource', scope: this.ticket.scope, handle: this.handle, uri }, options.signal)).value as Awaited<ReturnType<McpServerConnection['readResource']>>;
    }
    async resourcesPage(cursor: string | undefined, options: CallOptions) {
      this.assertOpen(); return (await request({ operation: 'resourcesPage', scope: this.ticket.scope, handle: this.handle, ...(cursor ? { cursor } : {}) }, options.signal)).value as Awaited<ReturnType<McpServerConnection['resourcesPage']>>;
    }
    async resourceTemplatesPage(cursor: string | undefined, options: CallOptions) {
      this.assertOpen(); return (await request({ operation: 'resourceTemplatesPage', scope: this.ticket.scope, handle: this.handle, ...(cursor ? { cursor } : {}) }, options.signal)).value as Awaited<ReturnType<McpServerConnection['resourceTemplatesPage']>>;
    }
    async allResources(options: CallOptions) {
      this.assertOpen(); return (await request({ operation: 'allResources', scope: this.ticket.scope, handle: this.handle }, options.signal)).value as Awaited<ReturnType<McpServerConnection['allResources']>>;
    }
    async allResourceTemplates(options: CallOptions) {
      this.assertOpen(); return (await request({ operation: 'allResourceTemplates', scope: this.ticket.scope, handle: this.handle }, options.signal)).value as Awaited<ReturnType<McpServerConnection['allResourceTemplates']>>;
    }
    async reconnect() {
      this.assertOpen();
      const result = await request({ operation: 'reconnect', scope: this.ticket.scope, handle: this.handle });
      if (!result.connection) throw new Error('MCP owner returned no connection'); this.apply(result.connection);
      if (this.state !== 'connected') throw new Error(this.error ?? 'MCP connection failed');
    }
    async signOut() { await owner.signOut(this); }
    async close() {
      if (this.#released) return; this.#released = true; connections.delete(this);
      if (!closed && epoch === this.ticket.epoch && scope === this.ticket.scope) await request({ operation: 'release', scope: this.ticket.scope, handle: this.handle });
    }
  }
  const remote = (connection: McpConnectionHandle) => { if (!(connection instanceof RemoteConnection) || !connections.has(connection)) throw new Error('MCP connection belongs to another owner'); connection.assertOpen(); return connection; };
  const owner: HostMcpOwner = {
    onPrepare: start => { prepare = start; },
    isSelected: () => prepare !== undefined,
    prepare: async () => { if (!prepare) throw new Error('MCP session is not ready'); await prepare(); },
    async loadConfig() {
      if (scope && !closed) await owner.close(); closed = false;
      const current = ++epoch;
      const opened = await request({ operation: 'open' });
      if (!opened.scope || !opened.config) throw new Error('MCP owner returned no configuration');
      if (current !== epoch || closed) {
        await request({ operation: 'close', scope: opened.scope });
        throw new Error('MCP session changed during preparation');
      }
      scope = opened.scope; const config = opened.config as unknown as LoadedMcpConfig; onConfig?.(config); return config;
    },
    async createConnection(entry, callbacks) {
      const ticket = capture();
      const result = await request({ operation: 'connect', scope: ticket.scope, entry: entry as unknown as McpOwnerEntry });
      try { assertCurrent(ticket); } catch (error) {
        if (result.connection) await request({ operation: 'release', scope: ticket.scope, handle: result.connection.handle }).catch(() => undefined);
        throw error;
      }
      if (!result.connection) throw new Error('MCP owner returned no connection');
      const connection = new RemoteConnection(ticket, result.connection, callbacks, entry); connections.add(connection);
      callbacks.onTools(connection); connection.assertOpen(); callbacks.onChange(connection); return connection;
    },
    toolCaller: (connection, tool) => remote(connection).caller(tool),
    async updateConfig(entry, patch) {
      const ticket = capture();
      await request({ operation: 'updateConfig', scope: ticket.scope, name: entry.name, projectOverride: Boolean(entry.override), patch });
      assertCurrent(ticket);
    },
    async refresh() { await Promise.all([...connections].map(connection => connection.refresh())); },
    async signIn(connection, prompt) {
      const selected = remote(connection);
      const ticket = selected.ticket;
      const started = await request({ operation: 'authStart', scope: ticket.scope, handle: selected.handle });
      try { assertCurrent(ticket); } catch (error) {
        if (started.auth) await request({ operation: 'authCancel', scope: ticket.scope, flow: started.auth.flow }).catch(() => undefined);
        throw error;
      }
      if (!started.auth) throw new Error('MCP owner returned no sign-in flow');
      const flow = started.auth.flow; const controller = new AbortController();
      let prompted = false; let finished = false;
      try {
        for (let auth = started.auth; ;) {
          assertCurrent(ticket);
          if (auth.state === 'succeeded') {
            finished = true;
            const rebound = await request({ operation: 'connect', scope: ticket.scope, entry: selected.originalEntry as unknown as McpOwnerEntry });
            if (!rebound.connection) throw new Error('MCP owner returned no signed-in connection');
            selected.apply(rebound.connection); return;
          }
          if (auth.state === 'failed') { finished = true; throw new Error(auth.error ?? 'MCP sign-in failed'); }
          if (auth.authorizationUrl && !prompted) {
            prompted = true; prompt.showAuthorizationUrl(new URL(auth.authorizationUrl));
            void prompt.promptForRedirectUrl(controller.signal).then(async redirectUrl => {
              assertCurrent(ticket);
              if (!controller.signal.aborted) await request({ operation: 'authReply', scope: ticket.scope, flow, ...(redirectUrl ? { redirectUrl } : {}) });
            }).catch(() => { if (!controller.signal.aborted) void request({ operation: 'authCancel', scope: ticket.scope, flow }).catch(() => undefined); });
          }
          const result = await request({ operation: 'authPoll', scope: ticket.scope, flow }, controller.signal);
          if (!result.auth) throw new Error('MCP owner returned no sign-in state'); auth = result.auth;
        }
      } finally {
        controller.abort();
        if (!finished) await request({ operation: 'authCancel', scope: ticket.scope, flow }).catch(() => undefined);
      }
    },
    async signOut(connection) {
      const selected = remote(connection);
      const ticket = selected.ticket;
      const result = await request({ operation: 'signOut', scope: ticket.scope, handle: selected.handle });
      assertCurrent(ticket);
      // Old native and Pi calls were revoked. Rebind this manager to a fresh unsigned generation.
      const rebound = await request({ operation: 'connect', scope: ticket.scope, entry: selected.originalEntry as unknown as McpOwnerEntry });
      if (rebound.connection) selected.apply(rebound.connection);
      return result.value === true;
    },
    async close() {
      if (closed) return; epoch++; prepare = undefined; const handle = scope; closed = true; scope = undefined; for (const connection of connections) connection.retire(); connections.clear();
      if (handle) await request({ operation: 'close', scope: handle });
    },
  };
  return owner;
}
