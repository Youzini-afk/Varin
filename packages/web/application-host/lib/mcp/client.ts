/** Generic MCP codec with Varin's original dispatch/response and interaction bookkeeping. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, ProtocolError, isInputRequiredResult, type SubscriptionFilter, type ClientCapabilities, type CallToolResult, type Resource, type ResourceTemplateType as ResourceTemplate, type Tool, type Transport } from '@modelcontextprotocol/client';
import { isModernMcpVersion, mcpHeaderDeclarations, mcpArgumentHeaders } from './headers.js';
import { McpSessionExpiredError, type McpTransport } from './transport.js';
export { ProtocolError as McpError } from '@modelcontextprotocol/client';
export type { Tool, CallToolResult, Resource, ResourceTemplateType as ResourceTemplate } from '@modelcontextprotocol/client';
export interface McpRequestOptions {
  onRequestId?(id: string | number): void;
  onRequestSettled?(id: string | number, received: boolean): void;
  onResponseError?(id: string | number, error: Record<string, unknown>): void;
  signal?: AbortSignal; timeoutMs?: number;
  headers?: Record<string, string>;
}
export interface McpRequestHandlerContext {
  signal: AbortSignal; requestId: string | number; relatedRequestId?: string | number;
  beforeResponse(callback: () => void | Promise<void>): void;
  onResponseSettled(callback: (state: 'sent' | 'unknown' | 'not_sent') => void): void;
}
interface RequestContext { options: McpRequestOptions; id?: string | number; legs: Map<string | number, boolean>; controller: AbortController; transportError?: McpSessionExpiredError; continuation?: Incoming }
interface Incoming { relatedRequestId?: string | number; guards: (() => void | Promise<void>)[]; observers: ((state: 'sent' | 'unknown' | 'not_sent') => void)[] }
type RequestHandler = (params: unknown, context: McpRequestHandlerContext) => unknown | Promise<unknown>;
const passthrough = { '~standard': { version: 1 as const, vendor: 'varin', validate: (value: unknown) => ({ value }) } };
export class McpClient {
  readonly sdk: Client;
  readonly #current = new AsyncLocalStorage<RequestContext>();
  readonly #pending = new Map<string | number, RequestContext>();
  readonly #incoming = new Map<string | number, Incoming>();
  readonly #handlers = new Map<string, RequestHandler>();
  readonly #notifications = new Map<string, Set<(params: unknown) => void>>();
  readonly #tools = new Map<string, Tool>();
  readonly #resourceSubscriptions = new Map<string, Awaited<ReturnType<Client['listen']>>>();
  readonly #gaps = new Set<() => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #closes = new Set<() => void>();
  #state: 'idle' | 'connecting' | 'connected' | 'closed' = 'idle';
  #http = false;
  #closing: Promise<void> | undefined;
  #capabilities: ReturnType<Client['getServerCapabilities']>;
  #version: ReturnType<Client['getNegotiatedProtocolVersion']>;
  #instructions: string | undefined;
  constructor(readonly options: { name: string; version: string; capabilities?: ClientCapabilities; requestTimeoutMs?: number }) {
    this.sdk = new Client({ name: options.name, version: options.version }, { capabilities: options.capabilities ?? {},
      versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false } });
    this.sdk.onerror = error => this.#transportError(error);
    this.sdk.onclose = () => { this.#state = 'closed'; for (const listener of this.#closes) listener(); };
  }
  #transportError(error: Error) {
    // Expiration invalidates this client; it never retries the original request.
    if (error instanceof McpSessionExpiredError) this.#state = 'closed';
    for (const listener of this.#errors) listener(error);
    if (error instanceof McpSessionExpiredError) void this.close().catch(() => undefined);
  }
  get connectionState() { return this.#state; }
  get serverCapabilities() { return this.#capabilities ?? this.sdk.getServerCapabilities(); }
  get protocolVersion() { return this.#version ?? this.sdk.getNegotiatedProtocolVersion(); }
  get instructions() { return this.#instructions ?? this.sdk.getInstructions(); }
  async connect(transport: McpTransport, signal?: AbortSignal) {
    this.#state = 'connecting';
    this.#http = transport.hasPerRequestStream === true;
    const sdk = this.sdk;
    const disposers: (() => void)[] = [];
    const bridge: Transport = {
      ...(transport.hasPerRequestStream === undefined ? {} : { hasPerRequestStream: transport.hasPerRequestStream }),
      start: async () => {
        disposers.push(transport.onMessage((message, context) => {
          if ('id' in message && message.id !== undefined && message.id !== null) {
            if ('method' in message) this.#incoming.set(message.id, { ...(context?.relatedRequestId === undefined ? {} : { relatedRequestId: context.relatedRequestId }), guards: [], observers: [] });
            else {
              const pending = this.#pending.get(message.id);
              if (pending && !context?.syntheticResponse) {
                pending.legs.set(message.id, true);
                if ('error' in message) pending.options.onResponseError?.(message.id, message.error as unknown as Record<string, unknown>);
              }
            }
          }
          bridge.onmessage?.(message);
        }), transport.onError(error => bridge.onerror?.(error)), transport.onClose(() => bridge.onclose?.()));
        await transport.start();
      },
      setProtocolVersion: version => transport.setProtocolVersion?.(version),
      send: async (message, options) => {
        const current = this.#current.getStore();
        const response = 'id' in message && !('method' in message) ? this.#incoming.get(message.id!) : 'id' in message ? current?.continuation : undefined;
        if ('id' in message && 'method' in message) {
          if (current) { current.id = message.id; current.legs.set(message.id, false); this.#pending.set(message.id, current); current.options.onRequestId?.(message.id); }
        }
        let sent = false, entered = false;
        try {
          for (const guard of response?.guards ?? []) await guard();
          entered = true;
          await transport.send(message, { ...options, onRequestStreamEnd: () => {
            options?.onRequestStreamEnd?.();
            current?.controller.abort(new Error('MCP response stream ended before its result'));
          } });
          sent = true;
        } catch (error) {
          if (error instanceof McpSessionExpiredError) {
            if (current) current.transportError = error;
            this.#transportError(error);
          }
          throw error;
        } finally {
          if (response) {
            if ('id' in message && message.id !== undefined) this.#incoming.delete(message.id);
            if (current?.continuation === response) delete current.continuation;
            for (const observer of response.observers.splice(0)) observer(sent ? 'sent' : entered ? 'unknown' : 'not_sent');
          }
        }
      },
      close: async () => {
        try { await transport.close(); } finally { for (const dispose of disposers) dispose(); }
      },
    };
    try {
      await sdk.connect(bridge, { ...(signal ? { signal } : {}), ...(this.options.requestTimeoutMs === undefined ? {} : { timeout: this.options.requestTimeoutMs }) });
      this.#capabilities = structuredClone(sdk.getServerCapabilities());
      this.#version = sdk.getNegotiatedProtocolVersion();
      this.#instructions = sdk.getInstructions();
      this.#state = 'connected';
    } catch (error) { this.#state = 'closed'; await transport.close(); throw error; }
  }
  request<T = unknown>(method: string, params?: Record<string, unknown>, options: McpRequestOptions = {}): Promise<T> {
    const context: RequestContext = { options, legs: new Map(), controller: new AbortController() };
    const signal = options.signal ? AbortSignal.any([options.signal, context.controller.signal]) : context.controller.signal;
    return this.#current.run(context, async () => {
      try {
        if (isModernMcpVersion(this.protocolVersion) && (method === 'resources/subscribe' || method === 'resources/unsubscribe')) {
          const uri = params?.uri;
          if (typeof uri !== 'string') throw new ProtocolError(-32602, 'A resource URI is required');
          if (method === 'resources/unsubscribe') {
            const existing = this.#resourceSubscriptions.get(uri); this.#resourceSubscriptions.delete(uri); await existing?.close();
          } else if (!this.#resourceSubscriptions.has(uri)) {
            const subscription = await this.listen({ resourceSubscriptions: [uri] }, signal);
            if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) { await subscription.close(); throw new ProtocolError(-32601, 'MCP resource subscription is unavailable'); }
            this.#resourceSubscriptions.set(uri, subscription);
            void subscription.closed.then(cause => {
              if (this.#resourceSubscriptions.get(uri) !== subscription) return;
              this.#resourceSubscriptions.delete(uri);
              if (cause !== 'local') for (const notify of this.#gaps) notify();
            });
          }
          return {} as T;
        }
        let next = params;
        for (;;) {
          signal.throwIfAborted();
          const result = await this.sdk.request({ method, ...(next ? { params: next } : {}) }, passthrough, {
            signal, ...(options.headers ? { headers: options.headers } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }), allowInputRequired: true,
          });
          if (!isInputRequiredResult(result)) return result as T;
          // This is a continuation explicitly requested by the server, under the original
          // Operation and binding. Network errors and unknown effects never enter this loop.
          const continuation: Incoming = { guards: [], observers: [] };
          context.continuation = continuation;
          const responses = await Promise.all(Object.entries(result.inputRequests ?? {}).map(async ([key, input]) => {
            const handler = this.#handlers.get(input.method);
            if (!handler) throw new ProtocolError(-32601, `MCP input handler is unavailable: ${input.method}`);
            const response = await handler(input.params, { signal, requestId: `${context.id}:${key}`, relatedRequestId: context.id!,
              beforeResponse: guard => continuation.guards.push(guard), onResponseSettled: observer => continuation.observers.push(observer) });
            return [key, response] as const;
          }));
          next = { ...params, ...(result.requestState === undefined ? {} : { requestState: result.requestState }), inputResponses: Object.fromEntries(responses) };
        }
      } catch (error) {
        // Closing an expired session also rejects pending SDK requests. Preserve the
        // original request's explicit rejection instead of relabeling its settlement.
        throw context.transportError ?? error;
      } finally {
        for (const observer of context.continuation?.observers.splice(0) ?? []) observer('not_sent');
        for (const [id, received] of context.legs) { this.#pending.delete(id); options.onRequestSettled?.(id, received); }
      }
    });
  }
  callTool(name: string, args: Record<string, unknown>, options?: McpRequestOptions) {
    const tool = this.#tools.get(name);
    const headers = tool && this.#http && isModernMcpVersion(this.protocolVersion) ? mcpArgumentHeaders(mcpHeaderDeclarations(tool.inputSchema), args) : undefined;
    // Raw dispatch preserves the frozen declaration and never invokes SDK metadata retries.
    return this.request<CallToolResult>('tools/call', { name, arguments: args }, { ...options, ...(headers ? { headers: { ...options?.headers, ...headers } } : {}) });
  }
  setRequestHandler(method: string, handler: RequestHandler) {
    this.#handlers.set(method, handler);
    this.sdk.setRequestHandler(method, { params: passthrough, result: passthrough }, async (params, context) => {
      const incoming = this.#incoming.get(context.mcpReq.id);
      if (!incoming) throw new ProtocolError(-32603, 'The original MCP request is unavailable');
      return handler(params, { signal: context.mcpReq.signal, requestId: context.mcpReq.id,
        ...(incoming.relatedRequestId === undefined ? {} : { relatedRequestId: incoming.relatedRequestId }),
        beforeResponse: callback => incoming.guards.push(callback), onResponseSettled: callback => incoming.observers.push(callback) });
    });
    return () => { if (this.#handlers.get(method) === handler) { this.#handlers.delete(method); this.sdk.removeRequestHandler(method); } };
  }
  onNotification(method: string, listener: (params: unknown) => void) {
    let listeners = this.#notifications.get(method);
    if (!listeners) {
      listeners = new Set(); this.#notifications.set(method, listeners);
      this.sdk.setNotificationHandler(method, { params: passthrough }, params => { for (const notify of this.#notifications.get(method) ?? []) notify(params); });
    }
    const selected = listeners; selected.add(listener);
    return () => { selected.delete(listener); if (!selected.size && this.#notifications.get(method) === selected) { this.#notifications.delete(method); this.sdk.removeNotificationHandler(method); } };
  }
  onError(listener: (error: Error) => void) { this.#errors.add(listener); return () => { this.#errors.delete(listener); }; }
  onClose(listener: () => void) { this.#closes.add(listener); return () => { this.#closes.delete(listener); }; }
  onNotificationGap(listener: () => void) { this.#gaps.add(listener); return () => { this.#gaps.delete(listener); }; }
  async listTools(options?: McpRequestOptions) {
    const directory = await this.#list<Tool>('tools/list', 'tools', options);
    const tools = directory;
    for (const tool of tools) {
      if (!this.#http || !isModernMcpVersion(this.protocolVersion)) continue;
      try { mcpHeaderDeclarations(tool.inputSchema); }
      catch { for (const listener of this.#errors) listener(new Error(`MCP tool has invalid HTTP header declarations: ${tool.name}`)); }
    }
    this.#tools.clear(); for (const tool of tools) this.#tools.set(tool.name, tool);
    return tools;
  }
  listen(filter: SubscriptionFilter, signal?: AbortSignal) { return this.sdk.listen(filter, signal ? { signal } : {}); }
  listResources(options?: McpRequestOptions) { return this.#list<Resource>('resources/list', 'resources', options); }
  listResourceTemplates(options?: McpRequestOptions) { return this.#list<ResourceTemplate>('resources/templates/list', 'resourceTemplates', options); }
  listPrompts(options?: McpRequestOptions) { return this.#list<{ name: string; description?: string; arguments?: unknown[] }>('prompts/list', 'prompts', options); }
  readResource(uri: string, options?: McpRequestOptions) { return this.request<import('@modelcontextprotocol/client').ReadResourceResult>('resources/read', { uri }, options); }
  listResourcesPage(cursor?: string, options?: McpRequestOptions) { return this.request<import('@modelcontextprotocol/client').ListResourcesResult>('resources/list', cursor ? { cursor } : {}, options); }
  listResourceTemplatesPage(cursor?: string, options?: McpRequestOptions) { return this.request<import('@modelcontextprotocol/client').ListResourceTemplatesResult>('resources/templates/list', cursor ? { cursor } : {}, options); }
  async #list<T>(method: string, field: string, options?: McpRequestOptions): Promise<T[]> {
    const rows: T[] = []; let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.request<Record<string, unknown>>(method, cursor ? { cursor } : {}, options);
      if (!Array.isArray(page[field])) throw new Error('MCP directory response is invalid');
      rows.push(...page[field] as T[]);
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('MCP directory cursor repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }
  close(): Promise<void> {
    this.#state = 'closed';
    return this.#closing ??= this.sdk.close();
  }
}
