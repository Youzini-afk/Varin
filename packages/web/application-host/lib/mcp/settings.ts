/** Settings and Agent execution share the same MCP definitions and connection owner. */
import { randomUUID } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import type { McpConfigurationSnapshot, McpConfigurationDocument } from '@varin/application-client';
import { McpAuthority, type McpAuthorityScope } from './authority.js';
import { mcpOAuthUrl } from './connection.js';
import { ConfigTextFileEditor } from './config-text-file-editor.js';
import { HostError } from '../configuration-errors.js';
import { validateMcpServerConfig, validateMcpPolicy, validateMcpDocument } from './configuration.js';
import { AuthorizationFlows } from '../authorization-flows.js';
import { parse, type ParseError } from 'jsonc-parser';
import { object, ModelConfigurationError } from '../models/configuration.js';
import { waitWithSignal } from '../cancellation.js';

interface View { cwd: string | undefined; spec: McpAuthorityScope; scopes: Set<string>; connections: Map<string, { scope: string; handle: string }>; flows: AuthorizationFlows; closed: boolean; unwatch?: () => void }
export function createMcpSettings(options: {
  authority: McpAuthority;
  resolveScope(cwd: string | undefined, signal: AbortSignal): Promise<McpAuthorityScope>;
  changed(): void;
}) {
  const views = new Map<string, View>();
  const requireView = (id: unknown) => { const view = typeof id === 'string' ? views.get(id) : undefined; if (!view) throw new ModelConfigurationError('mcp-view-unavailable', 'Reload MCP settings', 409); return view; };
  const config = (view: View) => options.authority.configuration(view.spec);
  const snapshot = async (id: string): Promise<McpConfigurationSnapshot> => {
    const view = requireView(id);
    const directory = await options.authority.directory(view.spec, new AbortController().signal);
    requireView(id);
    const loaded = config(view), readiness = await options.authority.inspect(view.spec);
    requireView(id);
    return { view: id, issues: loaded.errors,
      sources: loaded.sources.map(path => ({ path, scope: path === loaded.projectConfig ? 'project' : 'global' })),
      servers: loaded.servers.map(entry => {
        const state = readiness.servers.find(server => server.name === entry.name)!;
        const retained = view.connections.get(entry.name);
        const current = retained && !state.credentialError ? options.authority.snapshot(retained.scope, retained.handle) : undefined;
        const signInRequired = state.status === 'needs-auth' || Object.values(state.directories ?? {}).includes('needs-auth');
        const oauthEligible = mcpOAuthUrl(entry) !== undefined;
        const liveTools = current?.state === 'connected' && !current.error && state.directories?.tools === 'ready' ? current.tools : undefined;
        const tools = liveTools
          ? liveTools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }))
          : directory.filter(tool => tool.server === entry.name).map(tool => ({ name: tool.tool, description: tool.description, inputSchema: tool.inputSchema }));
        return { name: entry.name, source: entry.source, ...(entry.override ? { override: entry.override } : {}), enabled: entry.config.enabled !== false,
          exposure: entry.config.exposure ?? 'codemode', status: state.status, cachedToolCount: state.cachedToolCount, connectedToolCount: state.connectedToolCount,
          tools, toolsSource: liveTools ? 'connection' : 'cache',
          holdsConnection: retained !== undefined, signInRequired,
          canConnect: entry.config.enabled !== false && !state.credentialError,
          canSignIn: oauthEligible && state.hasStoredOAuthGrant !== undefined && (!state.hasStoredOAuthGrant || signInRequired),
          canSignOut: oauthEligible && state.hasStoredOAuthGrant === true,
          ...(state.credentialError ? { error: state.credentialError } : current?.error ? { error: current.error } : Object.values(state.directories ?? {}).includes('needs-auth')
            ? { error: `MCP sign-in required for: ${Object.entries(state.directories ?? {}).filter(([, status]) => status === 'needs-auth').map(([kind]) => kind).join(', ')}` } : Object.values(state.directories ?? {}).includes('failed')
            ? { error: `MCP directory unavailable: ${Object.entries(state.directories ?? {}).filter(([, status]) => status === 'failed').map(([kind]) => kind).join(', ')}` } : {}) };
      }) };
  };
  const editor = (view: View, path: unknown) => {
    if (typeof path !== 'string' || !config(view).sources.includes(path)) throw new ModelConfigurationError('mcp-source-unavailable', 'Select a configured MCP source');
    return new ConfigTextFileEditor(path, 'jsonc');
  };
  const connect = async (view: View, name: string) => {
    const opened = await options.authority.open(view.spec), entry = opened.config.servers.find(server => server.name === name);
    view.scopes.add(opened.scope);
    try {
      if (view.closed) throw new ModelConfigurationError('mcp-view-unavailable', 'MCP settings were closed');
      if (!entry) throw new ModelConfigurationError('mcp-server-unavailable', 'MCP server is no longer configured');
      const state = await options.authority.connect(opened.scope, entry);
      if (view.closed) throw new ModelConfigurationError('mcp-view-unavailable', 'MCP settings were closed');
      const previous = view.connections.get(name), current = { scope: opened.scope, handle: state.handle };
      view.connections.set(name, current);
      if (previous) { view.scopes.delete(previous.scope); options.authority.closeScope(previous.scope); }
      return current;
    } catch (error) { view.scopes.delete(opened.scope); options.authority.closeScope(opened.scope); throw error; }
  };
  const close = (id: string) => {
    const view = views.get(id); if (!view) return;
    views.delete(id); view.closed = true; view.flows.close(); view.unwatch?.();
    for (const scope of view.scopes) options.authority.closeScope(scope);
  };
  const actions: Record<string, (input: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>> = {
    open: async (input, signal) => {
      if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new ModelConfigurationError('invalid-params', 'Invalid workspace');
      const spec = await options.resolveScope(input.cwd as string | undefined, signal); signal.throwIfAborted();
      const id = randomUUID(), view: View = { cwd: input.cwd as string | undefined, spec, scopes: new Set(), connections: new Map(), flows: new AuthorizationFlows(options.changed), closed: false };
      views.set(id, view);
      void options.authority.subscribe(spec, options.changed).then(unwatch => { if (view.closed) unwatch(); else view.unwatch = unwatch; }, () => undefined);
      const aborted = () => close(id);
      signal.addEventListener('abort', aborted, { once: true });
      try {
        signal.throwIfAborted();
        const result = await snapshot(id);
        signal.throwIfAborted();
        return result;
      } catch (error) { close(id); throw error; }
      finally { signal.removeEventListener('abort', aborted); }
    },
    read: async input => { await options.authority.reload(requireView(input.view).spec); return snapshot(input.view as string); },
    close: input => { close(input.view as string); return {}; },
    'document/read': async input => ({ path: input.path, ...await editor(requireView(input.view), input.path).read() }),
    'document/save': async input => {
      const view = requireView(input.view), file = editor(view, input.path);
      if (typeof input.content !== 'string' || typeof input.expectedRevision !== 'string') throw new ModelConfigurationError('invalid-params', 'Invalid configuration document');
      const errors: ParseError[] = [], document: unknown = parse(input.content, errors, { allowTrailingComma: true });
      if (errors.length || !object(document) || validateMcpDocument(document))
        throw new ModelConfigurationError('mcp-config-invalid', 'MCP configuration must be a JSON object with valid sources and policies');
      for (const [name, policy] of Object.entries(document.mcpPolicies ?? {})) {
        const issue = validateMcpPolicy(policy); if (issue) throw new ModelConfigurationError('mcp-config-invalid', `${name}: ${issue}`);
      }
      for (const [name, definition] of Object.entries(document.mcpServers ?? {})) {
        const issue = validateMcpServerConfig(name, definition);
        if (typeof issue === 'string') throw new ModelConfigurationError('mcp-config-invalid', `${name}: ${issue}`);
        if (input.path === config(view).projectConfig && 'url' in issue && issue.auth) throw new ModelConfigurationError('mcp-project-account', 'Project configuration cannot select a user model account');
      }
      const result: McpConfigurationDocument = { path: input.path as string, ...await file.update(input.content, input.expectedRevision) };
      await options.authority.reload(view.spec);
      options.changed(); return result;
    },
    command: async (input, signal) => {
      const view = requireView(input.view);
      if (typeof input.name !== 'string') throw new ModelConfigurationError('invalid-params', 'Select an MCP server');
      const retained = view.connections.get(input.name);
      switch (input.command) {
        case 'connect': await waitWithSignal(connect(view, input.name), signal); break;
        case 'reconnect': {
          // Settings acts on today's definition. Existing Runs retain their original immutable lease.
          const wasConnected = retained && options.authority.snapshot(retained.scope, retained.handle).state === 'connected';
          const current = await waitWithSignal(connect(view, input.name), signal);
          if (wasConnected && current.handle === retained.handle) await waitWithSignal(options.authority.reconnect(current.scope, current.handle), signal);
          break;
        }
        case 'disconnect': if (retained) { view.connections.delete(input.name); view.scopes.delete(retained.scope); options.authority.closeScope(retained.scope); } break;
        case 'sign-out': await options.authority.signOutServer(view.spec, input.name); break;
        default: throw new ModelConfigurationError('invalid-params', 'Unknown MCP action');
      }
      options.changed(); return snapshot(input.view as string);
    },
    'authorization/start': async (input, signal) => {
      const view = requireView(input.view);
      if (typeof input.name !== 'string') throw new ModelConfigurationError('invalid-params', 'Select an MCP server');
      const retained = await waitWithSignal(connect(view, input.name), signal);
      return view.flows.start(prompt => options.authority.signIn(retained.scope, retained.handle, prompt));
    },
    'authorization/read': input => requireView(input.view).flows.read(input.id as string),
    'authorization/reply': input => { if (typeof input.redirect !== 'string') throw new ModelConfigurationError('invalid-params', 'Enter the authorization callback URL'); requireView(input.view).flows.reply(input.id as string, input.redirect); return {}; },
    'authorization/cancel': input => { requireView(input.view).flows.cancel(input.id as string); return {}; },
  };
  const invoke = async (name: string, input: Record<string, unknown>, signal: AbortSignal = new AbortController().signal): Promise<unknown> => {
    const action = actions[name];
    if (!action) throw new ModelConfigurationError('invalid-params', 'Unknown MCP settings action');
    if (name !== 'open' && name !== 'close') {
      const view = requireView(input.view);
      const current = await options.resolveScope(view.cwd, signal);
      if (view.spec.projectTrusted && !current.projectTrusted) {
        close(input.view as string);
        throw new ModelConfigurationError('mcp-project-trust-revoked', 'Project trust changed. Reload MCP settings.', 403);
      }
    }
    signal.throwIfAborted();
    return action(input, signal);
  };
  return {
    invoke,
    register(app: Express, requireAuth: RequestHandler) {
      for (const name of Object.keys(actions)) app.post(`/api/mcp/${name}`, requireAuth, async (request, response) => {
        const controller = new AbortController(), cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          if (!object(request.body)) throw new ModelConfigurationError('invalid-params', 'Invalid MCP settings request');
          response.json(await invoke(name, request.body, controller.signal));
        }
        catch (error) {
          if (error instanceof ModelConfigurationError) response.status(error.status).json({ code: error.code, message: error.message });
          else if (error instanceof HostError) response.status(error.code.includes('conflict') ? 409 : 400).json({ code: error.code, message: error.message });
          else response.status(503).json({ code: 'mcp-settings-unavailable', message: 'MCP settings are unavailable' });
        } finally { response.removeListener('close', cancel); }
      });
    },
    close() { for (const id of views.keys()) close(id); },
  };
}
