/**
 * Domain-action adapters for `owner: "action"` settings catalog entries
 * (Stage S / D-309).
 *
 * Every adapter talks to the real owning authority — a Pi worker RPC, an
 * in-process Host service, or the owning module — never a config field that
 * merely looks like state. Entries whose owner API does not exist stay
 * `unavailable`; nothing here fakes an install, login, or connection.
 */

import type { SettingsCatalogEntry } from '@varin/application-client';
import type { SettingsActionResult } from '@varin/protocol';
import { randomUUID } from 'node:crypto';
import { HarnessServiceError } from './service-error.js';
import type { AppPersistOutcome, SettingsServiceCaller } from './settings-service.js';

export interface SettingsActionContext {
  caller: SettingsServiceCaller;
  /** Resolved workspace root; null when the session is workspace-less. */
  workspaceRoot: string | null;
}

export interface ActionStatus {
  /** One-line live state summary for `settings.read`. */
  summary?: string;
  /** Structured owner state for `detail` reads. */
  data?: unknown;
  /** Verbs the owner can actually execute right now. */
  verbs?: string[];
  /** Why the domain is not operable (offline, missing dep, …). */
  unavailable?: string;
}

export interface ActionInvocation {
  status: SettingsActionResult['status'];
  detail?: string;
  data?: unknown;
  operation?: SettingsActionResult['operation'];
}

/**
 * An adapter declares this before invoke when the owner may outlive the
 * request. The Host can then refuse before side effects if its durable record
 * authority or the owner's observation API is unavailable.
 */
export interface SettingsActionCapabilities {
  execution: 'sync' | 'async';
  operation?: {
    query: boolean;
    cancel?: boolean;
  };
}

export interface SettingsActionAdapter {
  /** Verbs this adapter implements; catalog declarations are intersected with this list. */
  verbs: readonly string[];
  describe(ctx: SettingsActionContext, entry: SettingsCatalogEntry): Promise<ActionStatus>;
  invoke(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    verb: string,
    args: Record<string, unknown>,
  ): Promise<ActionInvocation>;
  capabilities?(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    verb: string,
    args: Record<string, unknown>,
  ): SettingsActionCapabilities | Promise<SettingsActionCapabilities>;
  /** Query an owner operation using the real identity returned by invoke. */
  getOperation?(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    operationId: string,
    args: Record<string, unknown>,
  ): Promise<ActionInvocation>;
  /** Cancel an owner operation only when the owner exposes a real cancel API. */
  cancelOperation?(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    operationId: string,
    args: Record<string, unknown>,
  ): Promise<ActionInvocation>;
}

/* ── dep handles (narrow views over the real services) ──────────────────── */

export interface ExtensionRuntimeHandle {
  state(): Promise<unknown>;
  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<unknown>;
  selectWorkbenchProfile?(request: Record<string, unknown>): Promise<unknown>;
  updateWorkbenchLayout?(request: Record<string, unknown>): Promise<unknown>;
  applyWorkbenchProfile?(request: Record<string, unknown>): Promise<unknown>;
}

export interface TunnelHandle {
  resolveActiveMode(): unknown;
  resolveActiveProvider(): unknown;
  getPublicUrl(): string | null;
  checkAvailability(provider?: string): Promise<unknown>;
  start(input: Record<string, unknown>): Promise<unknown>;
  stop(): unknown;
}

export interface RemoteClientsHandle {
  listClients(): Promise<unknown> | unknown;
  hasActiveRelayClients(): Promise<boolean> | boolean;
  revokeClient?(id: string): Promise<unknown>;
}

export interface LanguageSupportHandle {
  getStatus(request: { workspaceId: string }): Promise<unknown>;
  prepareServer(request: { workspaceId: string; languageId: string }): Promise<unknown>;
  cancelServerPreparation(request: { workspaceId: string; languageId: string }): Promise<unknown>;
}

export interface RuntimeLifecycleHandle {
  readonly snapshot: unknown;
  refresh(): Promise<unknown>;
  install(): Promise<unknown>;
  upgrade(): Promise<unknown>;
  activate(id: string): Promise<unknown>;
  activateCustom(packageRoot: string, nodePath?: string): Promise<unknown>;
}

export interface MagicPromptsHandle {
  readPromptState(): Promise<unknown>;
  setOverride(id: string, text: string): Promise<unknown>;
  resetOverride(id: string): Promise<unknown>;
  resetAllOverrides(): Promise<unknown>;
}

export type KnowledgeHandle = Pick<
  import('../knowledge/store.js').KnowledgeStore,
  'listKnowledge' | 'acceptKnowledge' | 'retireKnowledge'
>;

export interface FoundationalHandle {
  status(): { entries?: { id: string; observed?: string }[] };
  restore(ids?: readonly string[]): Promise<unknown>;
}

/** Profiles carry sshKey/signingKey secrets — never hand raw rows to callers. */
export interface GitIdentityStore {
  getProfiles(): import('../git/identity-storage.js').GitIdentityProfile[];
  getProfile(id: string): import('../git/identity-storage.js').GitIdentityProfile | null;
  createProfile(
    input: Partial<import('../git/identity-storage.js').GitIdentityProfile>
      & Pick<import('../git/identity-storage.js').GitIdentityProfile, 'id' | 'userEmail' | 'userName'>,
  ): import('../git/identity-storage.js').GitIdentityProfile;
  updateProfile(
    id: string,
    updates: Partial<Omit<import('../git/identity-storage.js').GitIdentityProfile, 'id'>>,
  ): import('../git/identity-storage.js').GitIdentityProfile;
  deleteProfile(id: string): true;
}

export interface SettingsActionDeps {
  /** Worker-scoped Pi RPC on the caller's workspace. */
  requestWorkspace(cwd: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Session-scoped Pi RPC (slash commands, provider auth). */
  requestSession(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
  /** In-process host services; lazy getters because the service is created
   *  before several of them exist. Missing handle = domain unavailable. */
  extensionRuntime?(): ExtensionRuntimeHandle | null;
  tunnel?(): TunnelHandle | null;
  remoteClients?(): RemoteClientsHandle | null;
  languageSupport?(): LanguageSupportHandle | null;
  runtimeLifecycle?(): RuntimeLifecycleHandle | null;
  magicPrompts?(): MagicPromptsHandle | null;
  foundational?(): FoundationalHandle | null;
  knowledgeStore?(workspaceId: string, scope: 'workspace' | 'user'): Promise<KnowledgeHandle | null>;
  gitIdentities?: GitIdentityStore;
  gitHubAuthStatus?(): Promise<Record<string, unknown>>;
  /** Single connected surface kind when unambiguous (web/desktop/mobile). */
  surfaceHint?(): string | null;
  /** Project metadata writes go through the real app-document CAS pipeline. */
  readAppSettings(): Promise<Record<string, unknown>>;
  persistAppSettings(
    changes: Record<string, unknown>,
    removals: readonly string[],
    expectedRevision: string | undefined,
  ): Promise<AppPersistOutcome>;
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;

const needString = (args: Record<string, unknown>, key: string): string => {
  const value = str(args, key);
  if (!value) throw new HarnessServiceError('invalid-params', `verb argument "${key}" is required`);
  return value;
};

const needWorkspace = async (
  ctx: SettingsActionContext,
  deps: SettingsActionDeps,
): Promise<string> => {
  if (!ctx.caller.workspaceId) {
    throw new HarnessServiceError('unavailable', 'this action requires a workspace-bound session');
  }
  const root = ctx.workspaceRoot ?? await deps.resolveWorkspaceRoot(ctx.caller.workspaceId);
  if (!root) throw new HarnessServiceError('unavailable', `cannot resolve workspace root for ${ctx.caller.workspaceId}`);
  return root;
};

const unavailable = (detail: string): ActionInvocation => ({ status: 'unavailable', detail });

const wrapError = (error: unknown): ActionInvocation => ({
  status: 'failed',
  detail: error instanceof Error ? error.message : String(error),
});

const sanitizeUrl = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|secret|key|password|credential/i.test(key)) parsed.searchParams.set(key, '[present]');
    }
    return parsed.toString();
  } catch {
    return value;
  }
};

const sanitizeProviderDescriptor = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    name: value.name,
    dynamicModels: value.dynamicModels,
    modelCount: value.modelCount,
    ...(value.baseUrl !== undefined ? { baseUrl: sanitizeUrl(value.baseUrl) } : {}),
    ...(isRecord(value.auth) ? {
      auth: {
        configured: value.auth.configured === true,
        ...(typeof value.auth.label === 'string' ? { label: value.auth.label } : {}),
        ...(typeof value.auth.source === 'string' ? { source: value.auth.source } : {}),
        ...(Array.isArray(value.auth.methods) ? {
          methods: value.auth.methods.map((method) => isRecord(method)
            ? { label: method.label, type: method.type }
            : method),
        } : {}),
      },
    } : {}),
  };
};

const sanitizeProviderConfig = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const config = isRecord(value.config) ? value.config : null;
  return {
    providerId: value.providerId,
    effectiveScope: value.effectiveScope,
    locations: value.locations,
    ...(isRecord(value.auth) ? {
      auth: {
        configured: value.auth.configured === true,
        ...(typeof value.auth.label === 'string' ? { label: value.auth.label } : {}),
        ...(typeof value.auth.source === 'string' ? { source: value.auth.source } : {}),
      },
    } : {}),
    ...(config ? {
      config: {
        id: config.id,
        name: config.name,
        api: config.api,
        authHeader: config.authHeader,
        ...(config.baseUrl !== undefined ? { baseUrl: sanitizeUrl(config.baseUrl) } : {}),
        ...(Array.isArray(config.models) ? { models: config.models.map(sanitizeProviderModel) } : {}),
      },
    } : {}),
  };
};

function sanitizeProviderModel(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.api !== undefined ? { api: value.api } : {}),
    ...(value.baseUrl !== undefined ? { baseUrl: sanitizeUrl(value.baseUrl) } : {}),
    ...(value.contextWindow !== undefined ? { contextWindow: value.contextWindow } : {}),
    ...(value.cost !== undefined ? { cost: value.cost } : {}),
    ...(value.input !== undefined ? { input: value.input } : {}),
    ...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
    ...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
    ...(value.thinkingLevelMap !== undefined ? { thinkingLevelMap: value.thinkingLevelMap } : {}),
  };
}

const sanitizeProviderModelDiscovery = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return {
    providerId: value.providerId,
    api: value.api,
    ...(value.baseUrl !== undefined ? { baseUrl: sanitizeUrl(value.baseUrl) } : {}),
    models: Array.isArray(value.models) ? value.models.map(sanitizeProviderModel) : [],
  };
};

const sanitizeMcpSnapshot = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const catalog = isRecord(value.catalog) ? value.catalog : null;
  return {
    provider: isRecord(value.provider) ? {
      state: value.provider.state,
      ...(value.provider.bridgeVersion !== undefined ? { bridgeVersion: value.provider.bridgeVersion } : {}),
      ...(value.provider.issue !== undefined ? { issue: value.provider.issue } : {}),
    } : value.provider,
    ...(catalog ? {
      catalog: {
        version: catalog.version,
        sources: Array.isArray(catalog.sources) ? catalog.sources.map((source) => isRecord(source) ? {
          id: source.id,
          displayPath: source.displayPath,
          order: source.order,
          scope: source.scope,
          serverNames: source.serverNames,
          ...(isRecord(source.target) ? {
            target: { format: source.target.format, path: source.target.path, root: source.target.root },
          } : {}),
        } : source) : [],
        servers: Array.isArray(catalog.servers) ? catalog.servers.map((server) => {
          if (!isRecord(server) || !isRecord(server.transport)) return server;
          return {
            name: server.name,
            disabled: server.disabled,
            sourceIds: server.sourceIds,
            transport: {
              kind: server.transport.kind,
              ...(server.transport.command !== undefined ? { command: server.transport.command } : {}),
              ...(server.transport.socket !== undefined ? { socket: server.transport.socket } : {}),
              ...(server.transport.url !== undefined ? { url: sanitizeUrl(server.transport.url) } : {}),
            },
          };
        }) : [],
      },
    } : {}),
  };
};

const sanitizeTextDocument = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const content = typeof value.content === 'string' ? value.content : undefined;
  return {
    ...Object.fromEntries(['exists', 'format', 'path', 'revision', 'root', 'scope'].flatMap((key) => (
      value[key] === undefined ? [] : [[key, value[key]]]
    ))),
    content: { isSet: content !== undefined && content.length > 0, ...(content !== undefined ? { bytes: Buffer.byteLength(content) } : {}) },
  };
};

const sanitizePackageDescriptor = (entry: unknown): unknown => isRecord(entry) ? {
  name: entry.name,
  enabled: entry.enabled,
  installed: entry.installed,
  scope: entry.scope,
  structured: entry.structured,
  ...(entry.source !== undefined ? { source: sanitizeUrl(entry.source) } : {}),
  ...(entry.version !== undefined ? { version: entry.version } : {}),
  ...(entry.resolvedPath !== undefined ? { resolvedPath: entry.resolvedPath } : {}),
} : entry;

const sanitizePackageResult = (value: unknown): unknown => Array.isArray(value)
  ? value.map(sanitizePackageDescriptor)
  : sanitizePackageDescriptor(value);

/* ── adapters ───────────────────────────────────────────────────────────── */

const providersAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'status', 'read', 'connect', 'login', 'disconnect', 'discover-models', 'models'],
  async describe(ctx) {
    const root = await needWorkspace(ctx, deps).catch(() => null);
    if (!root) return { unavailable: 'requires a workspace-bound session' };
    const list = await deps.requestWorkspace(root, 'provider.list', {}).catch(() => null);
    if (!Array.isArray(list)) return { unavailable: 'provider list unavailable' };
    const connected = list.filter((p) => isRecord(p) && (p.connected === true || p.authenticated === true));
    return {
      summary: `${list.length} providers, ${connected.length} connected`,
      data: list.map(sanitizeProviderDescriptor),
    };
  },
  async invoke(ctx, _entry, verb, args) {
    const root = await needWorkspace(ctx, deps);
    try {
      switch (verb) {
        case 'list':
          return { status: 'applied', data: (await deps.requestWorkspace(root, 'provider.list', {}) as unknown[]).map(sanitizeProviderDescriptor) };
        case 'status': {
          const providerId = needString(args, 'providerId');
          const config = await deps.requestWorkspace(root, 'provider.config.get', { providerId });
          return { status: 'applied', data: sanitizeProviderConfig(config) };
        }
        case 'read':
          return {
            status: 'applied',
            data: sanitizeProviderConfig(await deps.requestWorkspace(root, 'provider.config.get', { providerId: needString(args, 'providerId') })),
          };
        case 'connect':
        case 'login': {
          const providerId = needString(args, 'providerId');
          const type = str(args, 'type') === 'api_key' ? 'api_key' : 'oauth';
          await deps.requestWorkspace(root, 'provider.login', {
            interactionId: randomUUID(),
            providerId,
            type,
          });
          return {
            status: 'applied',
            detail: 'provider login request accepted by the owning session; recheck provider status/list for authentication state',
            data: { providerId, started: true },
          };
        }
        case 'disconnect': {
          const providerId = needString(args, 'providerId');
          const scope = str(args, 'scope') === 'project' ? 'project' : 'global';
          if (str(args, 'config') !== undefined || args.deleteConfig === true) {
            return {
              status: 'applied',
              data: sanitizeProviderConfig(await deps.requestWorkspace(root, 'provider.config.delete', { providerId, scope })),
            };
          }
          await deps.requestWorkspace(root, 'provider.logout', { providerId });
          return { status: 'applied', data: { providerId, disconnected: true } };
        }
        case 'discover-models':
        case 'models':
          return {
            status: 'applied',
            data: sanitizeProviderModelDiscovery(await deps.requestWorkspace(root, 'provider.models.discover', {
              interactionId: randomUUID(),
              providerId: needString(args, 'providerId'),
              ...(isRecord(args.config) ? { config: args.config } : {}),
              ...(args.capability === undefined ? {} : { capability: args.capability }),
            })),
          };
        default:
          return unavailable(`verb "${verb}" is not supported by the provider owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const mcpAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'reconnect', 'enable', 'disable', 'read', 'write'],
  async describe(ctx) {
    const snapshot = await deps.requestSession(ctx.caller.sessionId, 'mcp.config.snapshot', {}).catch(() => null);
    if (!isRecord(snapshot)) return { unavailable: 'mcp provider unavailable' };
    const provider = isRecord(snapshot.provider) ? snapshot.provider.state : undefined;
    const catalog = isRecord(snapshot.catalog) ? snapshot.catalog : null;
    const servers = Array.isArray(catalog?.servers) ? catalog.servers.length : 0;
    return {
      summary: `provider ${provider ?? 'unknown'}, ${servers} configured servers`,
      data: sanitizeMcpSnapshot(snapshot),
      verbs: ['status', 'reconnect', 'read', 'write'],
    };
  },
  async invoke(ctx, _entry, verb, args) {
    const request = (method: string, params: Record<string, unknown>) => deps.requestSession(ctx.caller.sessionId, method, params);
    try {
      switch (verb) {
        case 'status':
          return { status: 'applied', data: sanitizeMcpSnapshot(await request('mcp.config.snapshot', {})) };
        case 'reconnect': {
          const name = str(args, 'name');
          const command = name ? `/mcp reconnect ${name}` : '/mcp reconnect';
          const result = await deps.requestSession(ctx.caller.sessionId, 'command.execute', { command });
          return { status: 'applied', detail: `executed "${command}" in the owning session`, data: result };
        }
        case 'enable':
        case 'disable': {
          const name = needString(args, 'name');
          const command = `/mcp ${verb} ${name.replace(/\s+/g, '-')}`;
          const result = await deps.requestSession(ctx.caller.sessionId, 'command.execute', { command });
          return { status: 'applied', detail: `executed "${command}" in the owning session`, data: result };
        }
        case 'read': {
          const snapshot = await request('mcp.config.snapshot', {});
          const catalog = isRecord(snapshot) && isRecord(snapshot.catalog) ? snapshot.catalog : null;
          const sourceId = str(args, 'sourceId');
          if (!sourceId) return { status: 'applied', data: sanitizeMcpSnapshot(snapshot) };
          const sources = Array.isArray(catalog?.sources) ? catalog.sources : [];
          const source = sources.find((s: unknown) => isRecord(s) && s.id === sourceId);
          if (!source || !isRecord(source.target)) {
            return { status: 'failed', detail: `unknown mcp config source "${sourceId}"` };
          }
          return {
            status: 'applied',
            data: sanitizeTextDocument(await request('config.text.get', source.target as Record<string, unknown>)),
          };
        }
        case 'write': {
          const sourceId = str(args, 'sourceId');
          const content = typeof args.content === 'string' ? args.content : undefined;
          if (!sourceId || content === undefined) {
            return { status: 'failed', detail: 'write requires args {sourceId, content, expectedRevision?}' };
          }
          const snapshot = await request('mcp.config.snapshot', {});
          const catalog = isRecord(snapshot) && isRecord(snapshot.catalog) ? snapshot.catalog : null;
          const sources = Array.isArray(catalog?.sources) ? catalog.sources : [];
          const source = sources.find((s: unknown) => isRecord(s) && s.id === sourceId);
          if (!source || !isRecord(source.target)) {
            return { status: 'failed', detail: `unknown mcp config source "${sourceId}" — read the catalog first` };
          }
          const target = source.target as Record<string, unknown>;
          let expectedRevision = str(args, 'expectedRevision');
          if (!expectedRevision) {
            const current = await request('config.text.get', target) as Record<string, unknown>;
            expectedRevision = typeof current?.revision === 'string' ? current.revision : '';
          }
          return {
            status: 'applied',
            data: sanitizeTextDocument(await request('config.text.update', {
              ...target,
              content,
              expectedRevision,
            })),
          };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the mcp owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const resourcesAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'read', 'write', 'create', 'delete'],
  async describe(ctx) {
    const root = await needWorkspace(ctx, deps).catch(() => null);
    if (!root) return { unavailable: 'requires a workspace-bound session' };
    return { summary: 'Pi resource authority (prompts, skills)' };
  },
  async invoke(ctx, entry, verb, args) {
    const root = await needWorkspace(ctx, deps);
    const kind = entry.id.startsWith('prompts.') ? 'prompt' : entry.id.startsWith('skills.') ? 'skill' : null;
    if (!kind) return unavailable('this entry has no Pi resource kind (snippets are UI-owned, not a runtime resource)');
    try {
      switch (verb) {
        case 'list':
          return { status: 'applied', data: await deps.requestWorkspace(root, 'resource.list', { kind }) };
        case 'read':
          return {
            status: 'applied',
            data: await deps.requestWorkspace(root, 'resource.get', { kind, id: needString(args, 'id') }),
          };
        case 'write':
        case 'create': {
          const content = typeof args.content === 'string' ? args.content : undefined;
          if (content === undefined) return { status: 'failed', detail: 'verb requires args.content' };
          const id = str(args, 'id');
          const scope = str(args, 'scope') === 'project' ? 'project' : 'user';
          if (id) {
            let expectedRevision = str(args, 'expectedRevision');
            if (!expectedRevision) {
              const current = await deps.requestWorkspace(root, 'resource.get', { kind, id }) as Record<string, unknown>;
              expectedRevision = typeof current?.revision === 'string' ? current.revision : undefined;
            }
            if (!expectedRevision) return { status: 'failed', detail: 'resource has no readable revision — cannot update safely' };
            return {
              status: 'applied',
              data: await deps.requestWorkspace(root, 'resource.update', { kind, id, content, expectedRevision }),
            };
          }
          return {
            status: 'applied',
            data: await deps.requestWorkspace(root, 'resource.create', {
              kind,
              name: str(args, 'name') ?? `resource-${Date.now()}`,
              content,
              scope,
            }),
          };
        }
        case 'delete': {
          const id = needString(args, 'id');
          let expectedRevision = str(args, 'expectedRevision');
          if (!expectedRevision) {
            const current = await deps.requestWorkspace(root, 'resource.get', { kind, id }) as Record<string, unknown>;
            expectedRevision = typeof current?.revision === 'string' ? current.revision : undefined;
          }
          if (!expectedRevision) return { status: 'failed', detail: 'resource has no readable revision — cannot delete safely' };
          return {
            status: 'applied',
            data: await deps.requestWorkspace(root, 'resource.delete', { kind, id, expectedRevision }),
          };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the resource owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const piPackagesAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'install', 'remove', 'update', 'read', 'write'],
  async describe(ctx) {
    const root = await needWorkspace(ctx, deps).catch(() => null);
    if (!root) return { unavailable: 'requires a workspace-bound session' };
    const list = await deps.requestWorkspace(root, 'package.list', {}).catch(() => null);
    return Array.isArray(list)
      ? { summary: `${list.length} packages`, data: sanitizePackageResult(list) }
      : { unavailable: 'package list unavailable' };
  },
  async invoke(ctx, entry, verb, args) {
    const root = await needWorkspace(ctx, deps);
    try {
      switch (verb) {
        case 'list': {
          if (entry.id === 'plugins.recommended') {
            const foundation = deps.foundational?.();
            if (!foundation) return unavailable('foundational package status unavailable');
            return { status: 'applied', data: foundation.status() };
          }
          return { status: 'applied', data: sanitizePackageResult(await deps.requestWorkspace(root, 'package.list', {})) };
        }
        case 'install': {
          if (entry.id === 'plugins.recommended') {
            const foundation = deps.foundational?.();
            if (!foundation) return unavailable('foundational package restore unavailable');
            const ids = Array.isArray(args.ids) ? args.ids.filter((v): v is string => typeof v === 'string') : undefined;
            return { status: 'applied', detail: 'foundational package restore completed at the Pi package owner', data: await foundation.restore(ids) };
          }
          const source = needString(args, 'source');
          const scope = str(args, 'scope') === 'project' ? 'project' : 'global';
          const result = await deps.requestWorkspace(root, 'package.install', { source, scope });
          return {
            status: 'applied',
            detail: `package install completed for ${source}; recheck package list for the owner state`,
            data: sanitizePackageResult(result),
          };
        }
        case 'remove': {
          const source = needString(args, 'source');
          const scope = str(args, 'scope') === 'project' ? 'project' : 'global';
          return {
            status: 'applied',
            data: sanitizePackageResult(await deps.requestWorkspace(root, 'package.remove', { source, scope })),
          };
        }
        case 'update':
          return {
            status: 'applied',
            detail: 'package update completed at the Pi package owner; recheck package list for the owner state',
            data: sanitizePackageResult(await deps.requestWorkspace(root, 'package.update', {
              ...(str(args, 'source') ? { source: str(args, 'source')! } : {}),
            })),
          };
        case 'read':
        case 'write': {
          // plugin-settings.configuration — per-plugin config documents.
          const path = str(args, 'path');
          const rootKind = str(args, 'root');
          if (!path || !rootKind) {
            return { status: 'failed', detail: 'requires args {path, root: agent|home|project|user-config, format?}' };
          }
          if (verb === 'read') {
            return {
              status: 'applied',
              data: sanitizeTextDocument(await deps.requestWorkspace(root, 'config.text.get', {
                path, root: rootKind, format: str(args, 'format') ?? 'jsonc',
              })),
            };
          }
          const content = typeof args.content === 'string' ? args.content : undefined;
          if (content === undefined) return { status: 'failed', detail: 'write requires args.content' };
          let expectedRevision = str(args, 'expectedRevision');
          if (!expectedRevision) {
            const current = await deps.requestWorkspace(root, 'config.text.get', {
              path, root: rootKind, format: str(args, 'format') ?? 'jsonc',
            }) as Record<string, unknown>;
            expectedRevision = typeof current?.revision === 'string' ? current.revision : '';
          }
          return {
            status: 'applied',
            data: sanitizeTextDocument(await deps.requestWorkspace(root, 'config.text.update', {
              path, root: rootKind, format: str(args, 'format') ?? 'jsonc', content, expectedRevision,
            })),
          };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the package owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const agentsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'status', 'read', 'create', 'update', 'enable', 'disable', 'delete'],
  async describe(ctx) {
    const snapshot = await deps.requestSession(ctx.caller.sessionId, 'agentProvider.list', {}).catch(() => null);
    if (!isRecord(snapshot)) return { unavailable: 'agent provider catalog unavailable' };
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers.length : 0;
    return { summary: `${providers} agent providers`, data: snapshot };
  },
  async invoke(ctx, entry, verb, args) {
    const request = (method: string, params: Record<string, unknown>) => deps.requestSession(ctx.caller.sessionId, method, params);
    try {
      switch (verb) {
        case 'list':
          return { status: 'applied', data: await request('agentProvider.list', {}) };
        case 'status':
        case 'read': {
          const snapshot = await request('agentProvider.list', {});
          if (verb === 'read' || str(args, 'agentId')) {
            const providerId = str(args, 'providerId');
            const agentId = str(args, 'agentId');
            if (providerId) {
              return {
                status: 'applied',
                data: await request('agentProvider.action', {
                  providerId, action: 'inspect', ...(agentId ? { agentId } : {}),
                }),
              };
            }
          }
          return { status: 'applied', data: snapshot };
        }
        case 'create':
        case 'update':
        case 'enable':
        case 'disable':
        case 'delete': {
          const providerId = str(args, 'providerId');
          const agentId = str(args, 'agentId');
          const action = verb === 'create' ? 'create-agent' : verb;
          if (!providerId || (verb !== 'create' && !agentId)) return unavailable('providerId and an existing agentId are required (create only needs providerId)');
          const catalog = await request('agentProvider.list', {});
          const owners = isRecord(catalog) ? (verb === 'create' ? catalog.providers : catalog.agents) : undefined;
          const owner = Array.isArray(owners) ? owners.find(item => isRecord(item)
            && (verb === 'create' ? item.id === providerId : item.id === agentId && item.providerId === providerId)) : undefined;
          if (!isRecord(owner) || !Array.isArray(owner.actions) || !owner.actions.some(item => isRecord(item) && item.id === action)) return unavailable('The selected agent provider does not expose this action');
          const result = await request('agentProvider.action', { providerId, ...(agentId ? { agentId } : {}), action, input: args.input });
          return isRecord(result) && result.success === true ? { status: 'applied', data: result }
            : { status: 'failed', detail: isRecord(result) && typeof result.message === 'string' ? result.message : 'Agent action failed', data: result };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the agent provider owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const fleetAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'list', 'kill', 'inspect', 'doctor'],
  async describe(ctx) {
    const root = await needWorkspace(ctx, deps).catch(() => null);
    if (!root) return { unavailable: 'requires a workspace-bound session' };
    const status = await deps.requestSession(ctx.caller.sessionId, 'fleet.status', {}).catch(() => null);
    if (!isRecord(status)) return { unavailable: 'fleet status unavailable' };
    return { summary: 'fleet status available', data: status };
  },
  async invoke(ctx, _entry, verb, args) {
    try {
      switch (verb) {
        case 'status':
        case 'list':
          return { status: 'applied', data: await deps.requestSession(ctx.caller.sessionId, 'fleet.status', {}) };
        case 'kill': {
          const entryKey = needString(args, 'entryKey');
          return {
            status: 'applied',
            data: await deps.requestSession(ctx.caller.sessionId, 'fleet.action', {
              providerId: str(args, 'providerId') ?? 'subagents',
              action: 'kill',
              entryKey,
            }),
          };
        }
        case 'inspect': {
          const entryKey = needString(args, 'entryKey');
          return {
            status: 'applied',
            data: await deps.requestSession(ctx.caller.sessionId, 'fleet.action', {
              providerId: str(args, 'providerId') ?? 'subagents',
              action: 'logs',
              entryKey,
            }),
          };
        }
        case 'doctor':
          return {
            status: 'applied',
            data: await deps.requestSession(ctx.caller.sessionId, 'fleet.action', {
              providerId: str(args, 'providerId') ?? 'subagents',
              action: 'status',
            }),
          };
        default:
          return unavailable(`verb "${verb}" is not supported by the fleet owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

/**
 * Profiles hold sshKey/signingKey material. Agents get presence facts, never
 * secret values — the same rule as password fields on ordinary entries.
 */
const sanitizeGitProfile = (profile: import('../git/identity-storage.js').GitIdentityProfile) => ({
  id: profile.id,
  name: profile.name,
  host: profile.host,
  userName: profile.userName,
  userEmail: profile.userEmail,
  authType: profile.authType,
  icon: profile.icon,
  color: profile.color,
  signCommits: profile.signCommits,
  sshKey: { isSet: Boolean(profile.sshKey) },
  signingKey: { isSet: Boolean(profile.signingKey) },
});

const gitAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'list', 'create', 'update', 'delete'],
  async describe() {
    if (!deps.gitIdentities) return { unavailable: 'git identity store unavailable' };
    const profiles = deps.gitIdentities.getProfiles();
    return { summary: `${profiles.length} identities`, data: profiles.map(sanitizeGitProfile) };
  },
  async invoke(_ctx, entry, verb, args) {
    const identities = deps.gitIdentities;
    try {
      switch (verb) {
        case 'status': {
          if (entry.id === 'git.github-account') {
            if (!deps.gitHubAuthStatus) return unavailable('github auth service unavailable');
            return { status: 'applied', data: await deps.gitHubAuthStatus() };
          }
          return { status: 'applied', data: (identities?.getProfiles() ?? []).map(sanitizeGitProfile) };
        }
        case 'list':
          if (!identities) return unavailable('git identity store unavailable');
          return { status: 'applied', data: identities.getProfiles().map(sanitizeGitProfile) };
        case 'create': {
          if (!identities) return unavailable('git identity store unavailable');
          const userName = needString(args, 'userName');
          const userEmail = needString(args, 'userEmail');
          const id = str(args, 'id') ?? `git-id-${Date.now().toString(36)}`;
          return {
            status: 'applied',
            data: sanitizeGitProfile(identities.createProfile({
              id, userName, userEmail,
              ...(str(args, 'name') ? { name: str(args, 'name')! } : {}),
            })),
          };
        }
        case 'update': {
          if (!identities) return unavailable('git identity store unavailable');
          const id = needString(args, 'id');
          const updates: Partial<import('../git/identity-storage.js').GitIdentityProfile> = {};
          for (const key of ['userName', 'userEmail', 'name'] as const) {
            if (args[key] !== undefined) updates[key] = String(args[key]);
          }
          return { status: 'applied', data: sanitizeGitProfile(identities.updateProfile(id, updates)) };
        }
        case 'delete': {
          if (!identities) return unavailable('git identity store unavailable');
          identities.deleteProfile(needString(args, 'id'));
          return { status: 'applied', detail: 'identity deleted' };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the git owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const projectsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['rename', 'set-default-model', 'set-default-work-focus', 'set-color', 'set-icon'],
  async describe() {
    const document = await deps.readAppSettings();
    const projects = Array.isArray(document.projects) ? document.projects : [];
    return { summary: `${projects.length} projects`, data: projects };
  },
  async invoke(_ctx, entry, verb, args) {
    try {
      const document = await deps.readAppSettings();
      const projects = Array.isArray(document.projects) ? [...document.projects] : [];
      const projectId = str(args, 'projectId') ?? str(args, 'id');
      const findIndex = () => {
        if (!projectId) return -1;
        return projects.findIndex((p) => isRecord(p) && (p.id === projectId || p.path === projectId));
      };
      const patchProject = async (patch: Record<string, unknown>): Promise<ActionInvocation> => {
        const index = findIndex();
        if (index < 0) return { status: 'failed', detail: `unknown project "${projectId ?? ''}"` };
        const next = [...projects];
        next[index] = { ...(next[index] as Record<string, unknown>), ...patch };
        const outcome = await deps.persistAppSettings({ projects: next }, [], str(args, 'expectedRevision'));
        if (outcome.conflict) {
          return { status: 'failed', detail: `revision conflict — re-read and retry (current ${outcome.revision})` };
        }
        return { status: 'applied', detail: 'project updated', data: next[index] };
      };
      switch (verb) {
        case 'rename': {
          const label = str(args, 'name') ?? str(args, 'label');
          if (!label) throw new HarnessServiceError('invalid-params', 'verb argument "name" or "label" is required');
          return patchProject({ label });
        }
        case 'set-default-model':
          return patchProject({ defaultModel: str(args, 'model') ?? null });
        case 'set-default-work-focus':
          return patchProject({ defaultWorkFocus: needString(args, 'focus') ?? needString(args, 'workFocus') });
        case 'set-color':
          return patchProject({ color: str(args, 'color') ?? null });
        case 'set-icon':
          return patchProject({ icon: str(args, 'icon') ?? null });
        case 'list-actions':
          // Per-project action definitions live in the project config, read
          // by the surface that runs them; the host store only holds metadata.
          return unavailable('project actions are defined in the project config file and executed by a surface — list via the project config, run via a surface');
        case 'run-action':
          return unavailable('project actions execute in a connected surface (terminal tab / url / ssh forward) — not host-side');
        default:
          return unavailable(`verb "${verb}" is not supported by the projects owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const remoteInstancesAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'revoke'],
  async describe() {
    const clients = deps.remoteClients?.();
    if (!clients) return { unavailable: 'remote client auth service unavailable' };
    const [list, relayActive] = await Promise.all([
      Promise.resolve(clients.listClients()),
      Promise.resolve(clients.hasActiveRelayClients()),
    ]);
    const count = Array.isArray(list) ? list.length : 0;
    return {
      summary: `${count} paired clients, relay ${relayActive ? 'active' : 'idle'}`,
      data: list,
    };
  },
  async invoke(_ctx, _entry, verb, args) {
    const clients = deps.remoteClients?.();
    if (!clients) return unavailable('remote client auth service unavailable');
    try {
      switch (verb) {
        case 'status':
          return {
            status: 'applied',
            data: {
              clients: await Promise.resolve(clients.listClients()),
              relayActive: await Promise.resolve(clients.hasActiveRelayClients()),
            },
          };
        case 'revoke': {
          if (!clients.revokeClient) return unavailable('client revoke not supported by this service');
          const id = needString(args, 'clientId') ?? needString(args, 'id');
          return { status: 'applied', data: await clients.revokeClient(id) };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the remote-instances owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const WORKBENCH_SHELL_TARGET = 'shell';
const WORKBENCH_SURFACES = new Set(['web', 'desktop', 'mobile']);

/**
 * Write the `shell` replacement selection on the surface-keyed workbench
 * layout layer — mirrors the UI's persistReplacementSelection against the
 * host workbench document revision.
 */
const selectWorkbenchShell = async (
  runtime: ExtensionRuntimeHandle,
  deps: SettingsActionDeps,
  contributionId: string | null,
  args: Record<string, unknown>,
): Promise<ActionInvocation> => {
  const surfaceArg = str(args, 'surface');
  const hinted = surfaceArg ?? deps.surfaceHint?.() ?? undefined;
  if (!hinted || !WORKBENCH_SURFACES.has(hinted)) {
    return {
      status: 'failed',
      detail: `shell selection needs a target surface (${[...WORKBENCH_SURFACES].join('/')}) — pass args.surface`,
    };
  }
  const state = await runtime.state() as {
    workbench?: {
      document?: {
        revision?: number;
        layouts?: Record<string, unknown>[];
      };
    };
  };
  const document = state.workbench?.document;
  const revision = document?.revision;
  if (!document || typeof revision !== 'number') {
    return { status: 'unavailable', detail: 'workbench document has no readable revision' };
  }
  const scope = str(args, 'scopeId') ? 'workspace' : 'user';
  const scopeId = str(args, 'scopeId') ?? 'default';
  // Land the layer on the profile currently resolved for this surface.
  const profileId = str(args, 'profileId')
    ?? (() => {
      const match = (document.layouts ?? []).find((layer) => (
        layer.surface === hinted && layer.scope === scope && layer.scopeId === scopeId
      ));
      return typeof match?.profileId === 'string' ? match.profileId : 'default';
    })();
  const currentLayer = (document.layouts ?? []).find((layer) => (
    layer.profileId === profileId && layer.surface === hinted && layer.scope === scope && layer.scopeId === scopeId
  ));
  const replacementSelections = { ...((currentLayer?.replacementSelections ?? {}) as Record<string, string>) };
  if (contributionId === null) delete replacementSelections[WORKBENCH_SHELL_TARGET];
  else replacementSelections[WORKBENCH_SHELL_TARGET] = contributionId;
  return {
    status: 'applied',
    data: await runtime.updateWorkbenchLayout!({
      expectedRevision: revision,
      layer: {
        profileId,
        references: (currentLayer?.references as unknown[] | undefined) ?? [],
        replacementSelections,
        scope,
        scopeId,
        surface: hinted,
      },
    }),
  };
};

const workbenchExtensionsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'enable', 'disable', 'select', 'clear', 'apply'],
  async describe() {
    const runtime = deps.extensionRuntime?.();
    if (!runtime) return { unavailable: 'extension runtime unavailable' };
    const state = await runtime.state().catch(() => null);
    return { summary: 'workbench extension catalog', data: state };
  },
  async invoke(_ctx, entry, verb, args) {
    const runtime = deps.extensionRuntime?.();
    if (!runtime) return unavailable('extension runtime unavailable');
    try {
      switch (verb) {
        case 'list':
          return { status: 'applied', data: await runtime.state() };
        case 'enable':
        case 'disable': {
          const extensionId = needString(args, 'extensionId');
          const revision = typeof args.expectedRevision === 'number'
            ? args.expectedRevision
            : Number(str(args, 'expectedRevision') ?? NaN);
          return {
            status: 'applied',
            data: await runtime.setEnabled(
              extensionId,
              verb === 'enable',
              Number.isFinite(revision) ? revision : 0,
            ),
          };
        }
        case 'select': {
          // extensions.workbench.profile → host workbench document profile
          // selection; extensions.workbench.shell → a surface-keyed layout
          // layer's shell replacement.
          if (entry.id === 'extensions.workbench.profile') {
            if (!runtime.selectWorkbenchProfile) return unavailable('workbench profile selection unavailable');
            const profileId = needString(args, 'profileId');
            const state = await runtime.state() as {
              workbench?: { document?: { revision?: number; profiles?: { id: string }[] } };
            };
            const revision = state.workbench?.document?.revision;
            if (typeof revision !== 'number') {
              return { status: 'unavailable', detail: 'workbench document has no readable revision' };
            }
            const known = state.workbench?.document?.profiles;
            if (Array.isArray(known) && !known.some((profile) => profile.id === profileId)) {
              return {
                status: 'failed',
                detail: `unknown workbench profile "${profileId}" — installed: ${known.map((profile) => profile.id).join(', ') || '(none)'}`,
              };
            }
            return {
              status: 'applied',
              data: await runtime.selectWorkbenchProfile({
                profileId,
                scope: 'user',
                scopeId: 'default',
                expectedRevision: revision,
              }),
            };
          }
          if (entry.id === 'extensions.workbench.shell') {
            if (!runtime.updateWorkbenchLayout) return unavailable('workbench layout update unavailable');
            const contributionId = str(args, 'contributionId');
            if (!contributionId) {
              return { status: 'failed', detail: 'select requires args.contributionId (shell contribution id from the catalog)' };
            }
            return selectWorkbenchShell(runtime, deps, contributionId, args);
          }
          return unavailable(`select is only supported on extensions.workbench.profile / extensions.workbench.shell`);
        }
        case 'clear': {
          if (entry.id !== 'extensions.workbench.shell') {
            return unavailable('clear is only supported on extensions.workbench.shell');
          }
          if (!runtime.updateWorkbenchLayout) return unavailable('workbench layout update unavailable');
          return selectWorkbenchShell(runtime, deps, null, args);
        }
        case 'apply': {
          if (!runtime.applyWorkbenchProfile) return unavailable('workbench profile apply unavailable');
          const profileId = needString(args, 'profileId');
          const catalogRevision = typeof args.expectedCatalogRevision === 'number'
            ? args.expectedCatalogRevision
            : Number(str(args, 'expectedCatalogRevision') ?? NaN);
          if (!Number.isFinite(catalogRevision)) {
            const state = await runtime.state() as { catalog?: { revision?: number } };
            const revision = state.catalog?.revision;
            if (typeof revision !== 'number') {
              return { status: 'failed', detail: 'apply requires args.expectedCatalogRevision — read the catalog first' };
            }
            return {
              status: 'applied',
              data: await runtime.applyWorkbenchProfile({ profileId, expectedCatalogRevision: revision }),
            };
          }
          return {
            status: 'applied',
            data: await runtime.applyWorkbenchProfile({ profileId, expectedCatalogRevision: catalogRevision }),
          };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the extension owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const knowledgeAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'accept', 'supersede'],
  async describe(ctx) {
    const scope = ctx.caller.workspaceId ? 'workspace' : 'user';
    const store = await deps.knowledgeStore?.(ctx.caller.workspaceId ?? 'user', scope).catch(() => null);
    if (!store) return { unavailable: 'knowledge store unavailable' };
    return { summary: `${scope} knowledge store`, verbs: ['list', 'accept', 'supersede'] };
  },
  async invoke(ctx, entry, verb, args) {
    if (!deps.knowledgeStore) return unavailable('knowledge store unavailable');
    const scope = entry.id === 'knowledge.user' ? 'user' : 'workspace';
    if (scope === 'workspace' && !ctx.caller.workspaceId) {
      return unavailable('workspace knowledge requires a workspace-bound session');
    }
    const store = await deps.knowledgeStore(ctx.caller.workspaceId ?? 'user', scope);
    if (!store) return unavailable('knowledge store unavailable');
    try {
      switch (verb) {
        case 'list':
          return {
            status: 'applied',
            data: await store.listKnowledge({
              scope,
              ...(str(args, 'status')
                ? { status: str(args, 'status') as import('../knowledge/store.js').KnowledgeStatus }
                : {}),
            }),
          };
        case 'accept': {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { status: 'failed', detail: 'verb requires integer args.id' };
          const supersedes = Array.isArray(args.supersedes)
            ? args.supersedes.map(Number).filter(Number.isInteger)
            : undefined;
          return { status: 'applied', data: await store.acceptKnowledge(id, { ...(supersedes ? { supersedes } : {}) }) };
        }
        case 'supersede': {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { status: 'failed', detail: 'verb requires integer args.id' };
          return { status: 'applied', data: await store.retireKnowledge(id, scope) };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the knowledge owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const languageSupportAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'prepare', 'cancel'],
  async describe(ctx) {
    const support = deps.languageSupport?.();
    if (!support) return { unavailable: 'language support service unavailable' };
    if (!ctx.caller.workspaceId) {
      return { summary: 'language support service (workspace-bound for status)' };
    }
    const status = await support.getStatus({ workspaceId: ctx.caller.workspaceId }).catch(() => null);
    return { summary: 'language support service', data: status };
  },
  async invoke(ctx, _entry, verb, args) {
    const support = deps.languageSupport?.();
    if (!support) return unavailable('language support service unavailable');
    if (!ctx.caller.workspaceId) return unavailable('language support requires a workspace-bound session');
    const workspaceId = ctx.caller.workspaceId;
    try {
      switch (verb) {
        case 'status':
          return {
            status: 'applied',
            data: await support.getStatus({ workspaceId }),
          };
        case 'prepare': {
          const languageId = needString(args, 'languageId');
          return {
            status: 'applied',
            detail: `language server preparation completed for ${languageId}; recheck language status for the owner state`,
            data: await support.prepareServer({ workspaceId, languageId }),
          };
        }
        case 'cancel':
          return {
            status: 'applied',
            data: await support.cancelServerPreparation({
              workspaceId,
              languageId: needString(args, 'languageId'),
            }),
          };
        default:
          return unavailable(`verb "${verb}" is not supported by the language-support owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const runtimeUpdateAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'install', 'upgrade', 'rediscover', 'activate', 'choose'],
  async describe() {
    const lifecycle = deps.runtimeLifecycle?.();
    if (!lifecycle) return { unavailable: 'runtime lifecycle manager unavailable' };
    const snapshot = lifecycle.snapshot as { status?: string; active?: { version?: string } } | undefined;
    return {
      summary: snapshot ? `runtime ${snapshot.active?.version ?? '?'} (${snapshot.status ?? 'unknown'})` : 'runtime snapshot unavailable',
      data: snapshot,
    };
  },
  async invoke(_ctx, _entry, verb, args) {
    const lifecycle = deps.runtimeLifecycle?.();
    if (!lifecycle) return unavailable('runtime lifecycle manager unavailable');
    try {
      switch (verb) {
        case 'status':
          return { status: 'applied', data: lifecycle.snapshot };
        case 'install':
          return {
            status: 'applied', detail: 'runtime install completed at the runtime lifecycle owner',
            data: await lifecycle.install(),
          };
        case 'upgrade':
          return {
            status: 'applied', detail: 'runtime upgrade completed at the runtime lifecycle owner',
            data: await lifecycle.upgrade(),
          };
        case 'rediscover':
          return { status: 'applied', data: await lifecycle.refresh() };
        case 'activate': {
          const id = needString(args, 'id');
          return { status: 'applied', data: await lifecycle.activate(id) };
        }
        case 'choose': {
          const packageRoot = needString(args, 'packageRoot');
          return { status: 'applied', data: await lifecycle.activateCustom(packageRoot, str(args, 'nodePath')) };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the runtime owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const tunnelAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'start', 'stop'],
  async describe() {
    const tunnel = deps.tunnel?.();
    if (!tunnel) return { unavailable: 'tunnel service unavailable' };
    const url = tunnel.getPublicUrl();
    return {
      summary: url ? `active: ${url}` : 'inactive',
      data: { publicUrl: url, mode: tunnel.resolveActiveMode(), provider: tunnel.resolveActiveProvider() },
    };
  },
  async invoke(_ctx, _entry, verb, args) {
    const tunnel = deps.tunnel?.();
    if (!tunnel) return unavailable('tunnel service unavailable');
    try {
      switch (verb) {
        case 'status':
          return {
            status: 'applied',
            data: {
              publicUrl: tunnel.getPublicUrl(),
              mode: tunnel.resolveActiveMode(),
              provider: tunnel.resolveActiveProvider(),
              availability: await tunnel.checkAvailability(str(args, 'provider')),
            },
          };
        case 'start': {
          const input: Record<string, unknown> = {};
          if (str(args, 'provider')) input.provider = str(args, 'provider');
          if (str(args, 'mode')) input.mode = str(args, 'mode');
          return {
            status: 'applied',
            detail: 'tunnel start completed at the tunnel owner; recheck tunnel status for the live endpoint',
            data: await tunnel.start(input),
          };
        }
        case 'stop':
          return { status: 'applied', data: await tunnel.stop() };
        default:
          return unavailable(`verb "${verb}" is not supported by the tunnel owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const magicPromptsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['read', 'write', 'reset'],
  async describe() {
    const runtime = deps.magicPrompts?.();
    if (!runtime) return { unavailable: 'magic prompt runtime unavailable' };
    const state = await runtime.readPromptState().catch(() => null);
    return { summary: 'magic prompt overrides', data: state };
  },
  async invoke(_ctx, _entry, verb, args) {
    const runtime = deps.magicPrompts?.();
    if (!runtime) return unavailable('magic prompt runtime unavailable');
    try {
      switch (verb) {
        case 'read':
          return { status: 'applied', data: await runtime.readPromptState() };
        case 'write': {
          const id = needString(args, 'id');
          const text = typeof args.text === 'string' ? args.text : undefined;
          if (text === undefined) return { status: 'failed', detail: 'write requires args.text' };
          return { status: 'applied', data: await runtime.setOverride(id, text) };
        }
        case 'reset': {
          const id = str(args, 'id');
          return {
            status: 'applied',
            data: id ? await runtime.resetOverride(id) : await runtime.resetAllOverrides(),
          };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the magic-prompt owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const notificationsAdapter = (): SettingsActionAdapter => ({
  verbs: [],
  async describe() {
    return {
      summary: 'web push subscriptions are per-device and browser-granted',
      verbs: [],
      unavailable: 'push subscription belongs to each browser surface — an agent cannot subscribe another device',
    };
  },
  async invoke(_ctx, _entry, verb) {
    return unavailable(`verb "${verb}" is not supported — push subscription is per-device`);
  },
});

/* ── registry ───────────────────────────────────────────────────────────── */

export function createSettingsActionRegistry(deps: SettingsActionDeps) {
  const snippetsAdapter: SettingsActionAdapter = {
    verbs: [],
    async describe() {
      return { unavailable: 'snippets are owned by the interactive UI and have no host action authority' };
    },
    async invoke(_ctx, _entry, verb) {
      return unavailable(`verb "${verb}" is not available through the host snippet owner`);
    },
  };
  const adapters = new Map<string, SettingsActionAdapter>([
    ['runtime:providers', providersAdapter(deps)],
    ['runtime:mcp', mcpAdapter(deps)],
    ['runtime:resources', resourcesAdapter(deps)],
    ['runtime:extensions', piPackagesAdapter(deps)],
    ['service:agents', agentsAdapter(deps)],
    ['service:fleet', fleetAdapter(deps)],
    ['service:git', gitAdapter(deps)],
    ['service:projects', projectsAdapter(deps)],
    ['service:remote-instances', remoteInstancesAdapter(deps)],
    ['service:extensions', workbenchExtensionsAdapter(deps)],
    ['service:knowledge', knowledgeAdapter(deps)],
    ['runtime:language-support', languageSupportAdapter(deps)],
    ['runtime:runtime-update', runtimeUpdateAdapter(deps)],
    ['service:tunnel', tunnelAdapter(deps)],
    ['service:magic-prompts', magicPromptsAdapter(deps)],
    ['service:snippets', snippetsAdapter],
    ['service:notifications', notificationsAdapter()],
  ]);

  return {
    adapterFor(domain: string | undefined): SettingsActionAdapter | null {
      return domain ? adapters.get(domain) ?? null : null;
    },
  };
}

export type SettingsActionRegistry = ReturnType<typeof createSettingsActionRegistry>;
