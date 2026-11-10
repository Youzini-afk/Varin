/**
 * Agent-facing settings service (D-306 / Stage S).
 *
 * Serves the shared `SETTINGS_CATALOG` through the owning authorities:
 *  - `app`         → the Varin settings document via the serialized store
 *                    (CAS by content-hash revision, atomic multi-field writes).
 *  - `agent-settings` → revisioned native global/project settings authority.
 *  - `client`      → one authenticated device Surface, which applies and
 *                    acknowledges its own local state.
 *  - `action`      → domain surfaces (extensions, providers, tunnel, …),
 *                    invoked through their existing owner APIs.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SETTINGS_CATALOG,
  getSettingsCatalogEntry,
  listSettingsCategories,
  querySettingsCatalog,
  settingsSearchTranslations,
  type AgentSettingsSnapshot,
  type SettingsCatalogEntry,
  type SettingsFieldSpec,
} from '@varin/application-client';
import type {
  SettingsActionParams,
  SettingsActionResult,
  SettingsFieldResult,
  SettingsFieldValue,
  SettingsItemResult,
  SettingsReadParams,
  SettingsReadResult,
  SettingsSearchItem,
  SettingsSearchParams,
  SettingsSearchResult,
  SettingsUpdateItem,
  SettingsUpdateParams,
  SettingsUpdateResult,
} from '@varin/protocol';
import { compileToolJsonSchema, describeToolSchemaFailure } from '../models/schema.js';
import { resolveAgentSettingsField } from './settings-resolution.js';
import { getSettingsActionContracts } from './settings-action-contracts.js';
import { ModelConfigurationError } from '../models/configuration.js';
import type { AgentSettingsService } from '../models/settings.js';
import { HarnessServiceError } from './service-error.js';
import type { VarinSettingsDocument } from '@varin/settings-store';
import type {
  ActionInvocation,
  ActionStatus,
  SettingsActionCapabilities,
  SettingsActionRegistry,
} from './settings-actions.js';

export interface SettingsServiceCaller {
  workspaceId: string | null;
  threadId: string;
  branchId: string;
  runId?: string;
  operationId?: string;
  signal?: AbortSignal;
  invocation?: import('../kernel/tool-invocation.js').ToolInvocationAuthority;
  /** Original Host permission persistence only; never accepted from model arguments. */
  permissionSettingsRevision?: { before: string; after: string };
  /** Original owner selection from a trusted reference, never model arguments. */
  expectedSurface?: {surfaceId:string;connectionId:string};
  onReferenceTarget?(target:{surfaceId:string;connectionId:string}):void;
  /** Facts from the existing writer call, without a separate verification read. */
  onMutationState?(state: 'started' | 'unchanged' | 'applied'): void;
}

export interface SettingsActionOperationStore {
  /** Exact entry-scoped lookup; operation ids are only meaningful for one entry/Thread/branch. */
  get(caller: SettingsServiceCaller, entryId: string, operationId: string): Promise<{
    id: string;
    entryId: string;
    verb: string;
    state: NonNullable<SettingsActionResult['operation']>['state'];
    detail?: string;
    cancelVerb?: string;
    recordRevision?: number;
  } | null>;
  /** Host storage authority is available for a new async operation record. */
  available?(caller: SettingsServiceCaller): Promise<boolean>;
  put(caller: SettingsServiceCaller, operation: {
    id: string;
    entryId: string;
    verb: string;
    state: NonNullable<SettingsActionResult['operation']>['state'];
    detail?: string;
    cancelVerb?: string;
    expectedRecordRevision?: number;
  }): Promise<void>;
}

export interface AppPersistOutcome {
  conflict: boolean;
  revision: string;
  document: VarinSettingsDocument;
}

export interface SettingsServiceDeps {
  readAppSettings(): Promise<VarinSettingsDocument>;
  /**
   * Serialized CAS write over the app settings document through the same
   * sanitize/merge/domain-effect pipeline as the UI writer. `changes` and
   * `removals` use top-level document keys; `expectedRevision` is checked
   * inside the store lock so concurrent UI writes are never overwritten.
   */
  persistAppSettings(
    changes: Record<string, unknown>,
    removals: readonly string[],
    expectedRevision: string | undefined,
  ): Promise<AppPersistOutcome>;
  /** Native revisioned settings owner; global configuration does not require a workspace. */
  agentSettings(): Pick<AgentSettingsService, 'snapshot' | 'update'>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
  /** Best-effort dynamic option resolution; null = surface-resolved only. */
  resolveOptions?(
    source: string,
    caller: SettingsServiceCaller,
  ): Promise<{ value: string; label?: string }[] | null>;
  /** Domain-action adapters for `action` entries (Stage S). */
  actions?: SettingsActionRegistry;
  /** Durable owner operation references. Missing means async actions cannot be observed safely. */
  actionOperations?: SettingsActionOperationStore;
  /**
   * Targeted surface bridge for `client` entries. Absent = no live surface
   * channel — client entries report `unavailable` honestly.
   */
  clientSurfaces?: ClientSurfaceBridge;
  /** Fires once per successful write with the affected catalog ids. */
  onChanged?(change: {
    owner: 'app' | 'agent-settings' | 'client';
    ids: string[];
    scope: 'host' | 'global' | 'project' | 'client';
    revision: string;
  }): void;
}

/** A connected UI surface that owns device-local settings. */
export interface ClientSurfaceInfo {
  id: string;
  kind: 'desktop' | 'web' | 'mobile' | string;
}

export interface ClientSurfaceFieldResult {
  id: string;
  itemIndex?: number;
  status: 'applied' | 'failed' | 'unavailable';
  error?: string;
  /** Current values after apply/read (surface-reported fact). */
  values?: Record<string, unknown>;
  revision?: string;
  consistency?: 'compare-and-swap' | 'last-write-wins';
  mutation?: 'none' | 'applied' | 'unknown';
}

export interface ClientSurfaceBridge {
  /** Connected surfaces whose stream was Host-validated against one caller Thread/branch. */
  listForThread(identity: Pick<SettingsServiceCaller, 'threadId' | 'branchId'>): ClientSurfaceInfo[];
  /**
   * Read/apply client-owned fields, or deliver an owned credential-entry request
   * (metadata only; the acknowledgement confirms presentation, never key entry).
   * The bridge resolves the
   * target: the Surface bound to the caller's authenticated Thread/branch. Several
   * bound candidates = `ambiguous`; none = `unavailable`.
   */
  request(op: {
    type: 'read' | 'apply' | 'present-credential';
    entries: { id: string; itemIndex?: number; values?: Record<string, unknown>; reset?: string[]; expectedRevision?: string }[];
  }, target: Pick<SettingsServiceCaller, 'threadId' | 'branchId' | 'expectedSurface'> & {onDispatch?():void}): Promise<{
    surface: ClientSurfaceInfo;
    connectionId?: string;
    results: ClientSurfaceFieldResult[];
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deterministic content-hash revision over the app settings document. */
export const settingsDocumentRevision = (document: VarinSettingsDocument): string =>
  createHash('sha256').update(JSON.stringify(sortDeep(document))).digest('hex').slice(0, 32);

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
};

const getPath = (document: Record<string, unknown>, path: string): unknown => {
  const segments = path.split('.');
  let cursor: unknown = document;
  for (const segment of segments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

const setPath = (document: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.');
  let cursor = document;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isRecord(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) return;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
};

const deletePath = (document: Record<string, unknown>, path: string): void => {
  setPath(document, path, undefined);
};

const entryFields = (entry: SettingsCatalogEntry): readonly SettingsFieldSpec[] =>
  entry.fields ?? (entry.field ? [entry.field] : []);

const catalogSearchItem = (entry: SettingsCatalogEntry): SettingsSearchItem => ({
  id: entry.id,
  category: entry.category,
  owner: entry.owner,
  titleKey: entry.ui.titleKey,
  paths: entryFields(entry).map((field) => field.path),
  writable: entry.writable ?? entry.owner !== 'action',
  fields: entryFields(entry).map(field => ({ ...field })),
  ...(entry.authority ? { authority: entry.authority } : {}),
  ...(entry.scope ? { scope: entry.scope } : {}),

  ...(entry.apply ? { apply: entry.apply } : {}),
  page: entry.ui.page,
  ...(entry.ui.keywords ? { keywords: [...entry.ui.keywords] } : {}),
  ...(entry.actionRef?.note ? { note: entry.actionRef.note } : {}),
});

const validateFieldValue = (field: SettingsFieldSpec, value: unknown): string | null => {
  if (value === null || value === undefined) {
    return field.nullable ? null : 'value is not nullable; use reset to clear';
  }
  if (field.schema) {
    const validate = compileToolJsonSchema(field.schema);
    if (!validate(value)) return describeToolSchemaFailure(validate, value);
  }
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number';
      if (field.integer && !Number.isInteger(value)) return 'expected an integer';
      if (field.min !== undefined && value < field.min) return `must be >= ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be <= ${field.max}`;
      if (field.exclusiveMin !== undefined && value <= field.exclusiveMin) return `must be > ${field.exclusiveMin}`;
      if (field.exclusiveMax !== undefined && value >= field.exclusiveMax) return `must be < ${field.exclusiveMax}`;
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string') return 'expected a string';
      return field.options?.some((option) => option.value === value)
        ? null
        : `expected one of: ${(field.options ?? []).map((option) => option.value).join(', ')}`;
    }
    case 'string':
      if (typeof value !== 'string') return 'expected a string';
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return null;
    case 'string-list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? null
        : 'expected an array of strings';
    case 'json':
      return value === undefined ? 'expected a JSON value' : null;
    case 'secret':
      return 'credential fields are status-only and cannot be written through this service';
    default:
      return null;
  }
};

interface OwnerWrite {
  entry: SettingsCatalogEntry;
  set: Record<string, unknown>;
  reset: string[];
  itemIndex?: number;
  expectedRevision?: string | undefined;
}

/** Reject every item participating in a conflicting duplicate path before an owner write. */
const rejectConflictingDuplicatePaths = <T extends OwnerWrite>(writes: T[]): {
  accepted: T[];
  rejected: SettingsItemResult[];
} => {
  const mutations = new Map<string, { write: T; kind: 'set' | 'reset'; value?: unknown }[]>();
  for (const write of writes) {
    for (const [path, value] of Object.entries(write.set)) {
      mutations.set(path, [...(mutations.get(path) ?? []), { write, kind: 'set', value }]);
    }
    for (const path of new Set(write.reset)) {
      mutations.set(path, [...(mutations.get(path) ?? []), { write, kind: 'reset' }]);
    }
  }
  const conflicts = new Map<T, Set<string>>();
  for (const [path, entries] of mutations) {
    if (entries.length < 2) continue;
    const first = entries[0]!;
    const differs = entries.some((entry) => (
      entry.kind !== first.kind || (entry.kind === 'set' && !isDeepStrictEqual(entry.value, first.value))
    ));
    if (!differs) continue;
    for (const entry of entries) {
      const paths = conflicts.get(entry.write) ?? new Set<string>();
      paths.add(path);
      conflicts.set(entry.write, paths);
    }
  }
  return {
    accepted: writes.filter((write) => !conflicts.has(write)),
    rejected: writes.filter((write) => conflicts.has(write)).map((write) => {
      const paths = [...conflicts.get(write)!];
      return {
        id: write.entry.id,
        ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}),
        status: 'failed',
        error: `conflicting duplicate path(s) in owner batch: ${paths.join(', ')}`,
        fields: paths.map((path) => ({
          path,
          status: 'failed',
          error: 'the same owner path has incompatible set/reset values in this compound update',
        })),
      };
    }),
  };
};

export interface SettingsService {
  search(caller: SettingsServiceCaller, params: SettingsSearchParams): Promise<SettingsSearchResult>;
  read(caller: SettingsServiceCaller, params: SettingsReadParams): Promise<SettingsReadResult>;
  update(caller: SettingsServiceCaller, params: SettingsUpdateParams): Promise<SettingsUpdateResult>;
  /** Invoke a domain action on an `action` entry (D-309). */
  action(caller: SettingsServiceCaller, params: SettingsActionParams): Promise<SettingsActionResult>;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const toSearchItem = (entry: SettingsCatalogEntry, detail: 'summary' | 'full' = 'full'): SettingsSearchItem => {
    const item = catalogSearchItem(entry);
    if (detail === 'summary') {
      const { fields: _fields, keywords: _keywords, ...summary } = item;
      return { ...summary, read: { tool: 'settings_read', arguments: { id: entry.id } } };
    }
    const adapter = deps.actions?.adapterFor(entry.actionRef?.domain);
    return adapter ? { ...item, actions: Object.fromEntries(Object.entries(getSettingsActionContracts(entry)).filter(([verb]) => adapter.verbs.includes(verb))) } : item;
  };
  const search = async (
    caller: SettingsServiceCaller,
    params: SettingsSearchParams,
  ): Promise<SettingsSearchResult> => {
    const detail = params.detail ?? (params.id ? 'full' : 'summary');
    const translations = params.query?.trim() && !params.id ? await settingsSearchTranslations() : undefined;
    const matches = querySettingsCatalog({
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.category !== undefined ? { category: params.category as never } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
      ...(params.id !== undefined ? { id: params.id } : {}),
    }, translations);
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const terms = [...new Set((params.query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
    const relatedScores = new Map<SettingsCatalogEntry, number>();
    if (!matches.length && !params.id && terms.length > 1) {
      for (const term of terms) {
        for (const entry of querySettingsCatalog({ query: term, ...(params.category ? { category: params.category as never } : {}), ...(params.owner ? { owner: params.owner } : {}) }, translations)) {
          relatedScores.set(entry, (relatedScores.get(entry) ?? 0) + 1);
        }
      }
    }
    const related = [...relatedScores].sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id))
      .slice(0, limit).map(([entry]) => toSearchItem(entry, detail));
    const categories = new Map<string, number>();
    for (const entry of matches) {
      categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
    }
    const page = matches.slice(offset, offset + limit);
    const summaries = await summarizeSearchItems(caller, page);
    return {
      items: page.map((entry, index) => {
        const item = toSearchItem(entry, detail);
        const summary = summaries[index];
        return summary ? { ...item, summary } : item;
      }),
      total: matches.length,
      ...(offset + page.length < matches.length ? { next: { ...params, offset: offset + page.length } } : {}),
      ...(related.length ? { related } : {}),
      categories: [...categories.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  };

  /**
   * Progressive disclosure for search (S-B): simple entries carry the live
   * facts needed to decide a write — effective value/source for single-field
   * app+pi rows, declared verbs for action rows, connected-surface count for
   * client rows. Owner documents are fetched once per search, never per item.
   */
  const summarizeSearchItems = async (
    caller: SettingsServiceCaller,
    entries: readonly SettingsCatalogEntry[],
  ): Promise<(SettingsSearchItem['summary'] | undefined)[]> => {
    let appDocument: VarinSettingsDocument | null = null;
    let agentSnapshot: AgentSettingsSnapshot | null = null;
    const needApp = entries.some((entry) => entry.owner === 'app');
    const needAgent = entries.some((entry) => entry.owner === 'agent-settings');
    if (needApp) appDocument = await deps.readAppSettings().catch(() => null);
    if (needAgent) {
      const root = caller.workspaceId ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null) : null;
      agentSnapshot = await deps.agentSettings().snapshot(root ?? undefined).catch(() => null);
    }
    const surfaceCount = deps.clientSurfaces?.listForThread(caller).length ?? 0;
    const actionRoot = caller.workspaceId
      ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null)
      : null;
    const actionStatus = new Map<string, Promise<ActionStatus>>();
    return Promise.all(entries.map(async (entry) => {
      const fields = entryFields(entry);
      const single = fields.length === 1 ? fields[0]! : null;
      if (entry.owner === 'action') {
        const domain = entry.actionRef?.domain;
        const adapter = deps.actions?.adapterFor(domain) ?? null;
        if (!domain || !adapter) return { verbs: [] };
        let statusPromise = actionStatus.get(domain);
        if (!statusPromise) {
          statusPromise = adapter.describe({ caller, workspaceRoot: actionRoot }, entry)
            .catch((error: unknown): ActionStatus => ({
              unavailable: error instanceof Error ? error.message : String(error),
            }));
          actionStatus.set(domain, statusPromise);
        }
        const status = await statusPromise;
        if (status.unavailable) return { verbs: [] };
        const declared = entry.actionRef?.verbs ?? [];
        const supported = status.verbs ?? adapter.verbs;
        return { verbs: declared.filter((verb) => supported.includes(verb) && adapter.verbs.includes(verb)) };
      }
      if (entry.owner === 'client') {
        return { surfaces: surfaceCount };
      }
      if (!single) return undefined;
      const summary: NonNullable<SettingsSearchItem['summary']> = {
        fieldKind: single.kind,
        ...(single.options ? { options: single.options.map((o) => ({ value: o.value, ...(o.labelKey ? { label: o.labelKey } : {}) })) } : {}),
      };
      if (entry.owner === 'app' && appDocument) {
        const saved = getPath(appDocument, single.path);
        if (single.kind === 'secret') {
          summary.isSet = saved !== undefined && saved !== null && saved !== '';
          summary.source = summary.isSet ? 'user' : 'none';
        } else {
          summary.value = saved !== undefined ? saved : single.default;
          summary.source = saved !== undefined ? 'user' : single.default !== undefined ? 'default' : 'none';
        }
        return summary;
      }
      if (entry.owner === 'agent-settings' && agentSnapshot) {
        const effective = resolveAgentSettingsField(agentSnapshot, single);
        if (single.kind === 'secret') summary.isSet = effective.value !== undefined && effective.value !== null && effective.value !== '';
        else summary.value = effective.value;
        summary.source = effective.source;
        return summary;
      }
      // Owner unreachable — kind/options still help the caller shape a read.
      return summary;
    }));
  };

  const requireEntry = (id: string): SettingsCatalogEntry => {
    const entry = getSettingsCatalogEntry(id);
    if (!entry) {
      throw new HarnessServiceError('not-found', `unknown settings id "${id}" — search first for stable ids`);
    }
    return entry;
  };

  const resolveOptions = async (
    caller: SettingsServiceCaller,
    fields: readonly SettingsFieldSpec[],
  ): Promise<{ value: string; label?: string }[] | undefined> => {
    const sources = new Set(
      fields.flatMap((field) => (field.optionsSource ? [field.optionsSource] : [])),
    );
    if (sources.size === 0 || !deps.resolveOptions) return undefined;
    const options: { value: string; label?: string }[] = [];
    for (const source of sources) {
      const resolved = await deps.resolveOptions(source, caller).catch(() => null);
      if (resolved) options.push(...resolved);
    }
    return options.length > 0 ? options : undefined;
  };

  const readApp = async (
    entry: SettingsCatalogEntry,
    detail: boolean,
    caller: SettingsServiceCaller,
  ): Promise<SettingsReadResult> => {
    const document = await deps.readAppSettings();
    const fields = entryFields(entry);
    const values: SettingsFieldValue[] = fields.map((field) => {
      const saved = getPath(document, field.path);
      if (field.kind === 'secret') {
        return { path: field.path, kind: field.kind, isSet: saved !== undefined && saved !== null && saved !== '' };
      }
      return { path: field.path, kind: field.kind, saved, isSet: saved !== undefined, effective: { value: saved !== undefined ? saved : field.default, source: saved !== undefined ? 'user' : field.default !== undefined ? 'default' : 'none', basis: 'configured' } };
    });
    const effectiveFields = fields.filter((field) => field.kind !== 'secret');
    const effective = effectiveFields.length === 1
      ? (() => {
          const field = effectiveFields[0]!;
          const saved = getPath(document, field.path);
          return {
            value: saved !== undefined ? saved : field.default,
            source: (saved !== undefined ? 'user' : field.default !== undefined ? 'default' : 'none') as 'user' | 'default' | 'none',
          };
        })()
      : undefined;
    return {
      state: 'ok',
      entry: toSearchItem(entry),
      fields: values,
      ...(effective ? { effective } : {}),
      revision: settingsDocumentRevision(document),
      consistency: 'compare-and-swap',
      appliedAt: entry.apply ?? 'immediate',
      ...(detail ? { related: relatedIds(entry) } : {}),
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      ...(await optionBlock(caller, fields, detail)),
    };
  };

  const relatedIds = (entry: SettingsCatalogEntry): string[] =>
    SETTINGS_CATALOG
      .filter((candidate) => candidate.id !== entry.id && candidate.ui.page === entry.ui.page)
      .map((candidate) => candidate.id)
      .slice(0, 12);

  const optionBlock = async (
    caller: SettingsServiceCaller,
    fields: readonly SettingsFieldSpec[],
    detail: boolean,
  ): Promise<Pick<SettingsReadResult, 'options'>> => {
    if (!detail) return {};
    const options = await resolveOptions(caller, fields);
    return options ? { options } : {};
  };

  const readAgent = async (
    entry: SettingsCatalogEntry,
    scope: 'global' | 'project' | 'effective',
    detail: boolean,
    caller: SettingsServiceCaller,
  ): Promise<SettingsReadResult> => {
    const root = caller.workspaceId ? await deps.resolveWorkspaceRoot(caller.workspaceId) : null;
    if (scope === 'project' && !root) return { state: 'unavailable', entry: toSearchItem(entry), reason: 'project settings require an admitted workspace' };
    let snapshot: AgentSettingsSnapshot;
    try {
      snapshot = await deps.agentSettings().snapshot(scope === 'global' ? undefined : root ?? undefined);
    } catch (error) {
      return {
        state: error instanceof SyntaxError || error instanceof ModelConfigurationError && error.code.includes('invalid')
          || error instanceof Error && error.message === 'Settings file is malformed (non-object payload)' ? 'malformed' : 'unavailable',
        entry: toSearchItem(entry), reason: error instanceof Error ? error.message : String(error),
      };
    }
    const effectiveSnapshot = scope === 'global' && root
      ? await deps.agentSettings().snapshot(root).catch(() => null) : snapshot;
    const resolution = effectiveSnapshot ? { ...effectiveSnapshot, global: snapshot.global, globalRevision: snapshot.globalRevision } : null;
    const fields = entryFields(entry);
    const values: SettingsFieldValue[] = fields.map((field) => {
      const global = getPath(snapshot.global, field.path);
      const project = resolution?.projectTrusted && field.scope !== 'user' ? getPath(resolution.project, field.path) : undefined;
      const saved = scope === 'project' ? project : scope === 'global' ? global : undefined;
      if (field.kind === 'secret') return { path: field.path, kind: field.kind, isSet: saved !== undefined };
      return {
        path: field.path, kind: field.kind,
        ...(scope !== 'effective' ? { saved } : {}),
        isSet: scope === 'effective' ? global !== undefined || project !== undefined : saved !== undefined,
        layers: { ...(global !== undefined ? { global } : {}), ...(project !== undefined ? { project } : {}) },
        ...(resolution ? { effective: resolveAgentSettingsField(resolution, field) } : {}),
      };
    });
    const effective = fields.length === 1 && fields[0]?.kind !== 'secret' ? values[0]?.effective : undefined;
    const deniedProject = scope === 'project' && !snapshot.projectTrusted;
    return {
      state: deniedProject ? 'denied' : 'ok',
      entry: toSearchItem(entry),
      fields: values,
      ...(effective ? { effective } : {}),
      consistency: 'compare-and-swap',
      appliedAt: entry.apply ?? 'next-run',
      ...(!resolution ? { effectiveUnavailable: 'admitted project settings could not be resolved; saved global values remain available' } : {}),
      revisions: {
        global: snapshot.globalRevision,
        ...(snapshot.projectTrusted ? { project: snapshot.projectRevision } : {}),
      },
      ...(deniedProject ? { reason: 'project settings file is not trusted' } : {}),
      ...(detail ? { related: relatedIds(entry) } : {}),
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      ...(await optionBlock(caller, fields, detail)),
    };
  };

  const read = async (
    caller: SettingsServiceCaller,
    params: SettingsReadParams,
  ): Promise<SettingsReadResult> => {
    const entry = requireEntry(params.id);
    const detail = params.detail === true;
    if (entry.scope && params.scope && params.scope !== entry.scope && params.scope !== 'effective') throw new HarnessServiceError('denied', `"${entry.id}" targets ${entry.scope} settings`);
    switch (entry.owner) {
      case 'app':
        if (params.scope === 'global' || params.scope === 'project') {
          throw new HarnessServiceError(
            'denied',
            `"${entry.id}" is host-owned; global/project scope is only valid for agent-settings entries`,
          );
        }
        return readApp(entry, detail, caller);
      case 'agent-settings':
        return readAgent(entry, params.scope ?? entry.scope ?? 'effective', detail, caller);
      case 'client':
        return readClient(entry, caller, params);
      case 'action':
      default:
        return readAction(entry, caller, detail);
    }
  };

  /**
   * `client` entries live on the connected surface. A read asks the surface
   * for its own current values — when no single surface is addressable the
   * result stays honestly `unavailable`/`denied` instead of guessing.
   */
  const readClient = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsReadParams,
  ): Promise<SettingsReadResult> => {
    if (params.surface) {
      return {
        state: 'denied',
        entry: toSearchItem(entry),
        reason: 'surface selection is Host-resolved from the caller Thread/branch; model supplied surface ids are not accepted',
      };
    }
    const bridge = deps.clientSurfaces;
    if (!bridge) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: 'device-local preference owned by the connected surface — no surface channel is registered on this host',
      };
    }
    let response;
    try {
      response = await bridge.request({
        type: 'read',
        entries: [{ id: entry.id }],
      }, { threadId: caller.threadId, branchId: caller.branchId, ...(caller.expectedSurface ? {expectedSurface:caller.expectedSurface}:{}) });
    } catch (error) {
      const code = error instanceof HarnessServiceError ? error.harnessCode : undefined;
      return {
        state: code === 'ambiguous' ? 'denied' : 'unavailable',
        entry: toSearchItem(entry),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const result = response.results.find((item) => item.id === entry.id);
    if (!result || result.status === 'unavailable') {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: result?.error ?? `surface ${response.surface.id} does not own ${entry.id}`,
      };
    }
    if (result.status === 'failed') {
      return {
        state: 'malformed',
        entry: toSearchItem(entry),
        reason: result.error ?? 'surface failed to read the value',
      };
    }
    if (response.connectionId) caller.onReferenceTarget?.({surfaceId:response.surface.id,connectionId:response.connectionId});
    const values = result.values ?? {};
    const paths = Object.keys(values);
    return {
      state: 'ok',
      entry: toSearchItem(entry),
      fields: paths.map((path) => ({ path, kind: 'json', saved: values[path], isSet: values[path] !== undefined, effective: { value: values[path], source: 'runtime', basis: 'active' } })),
      ...(paths.length === 1
        ? { effective: { value: values[paths[0]!], source: 'runtime' as const, basis: 'active' as const } }
        : {}),
      ...(result.revision ? { revision: result.revision } : {}),
      consistency: result.consistency ?? 'last-write-wins',
      appliedAt: entry.apply ?? 'immediate',
    };
  };

  /**
   * `action` entries describe a live domain surface. The adapter reports the
   * owner's real state and the verbs it can execute right now; without an
   * adapter the entry keeps its static pointer (still honest — not claimed).
   */
  const readAction = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    detail: boolean,
  ): Promise<SettingsReadResult> => {
    const adapter = deps.actions?.adapterFor(entry.actionRef?.domain) ?? null;
    const staticBlock = entry.actionRef
      ? {
          domain: entry.actionRef.domain,
          verbs: [] as string[],
          ...(entry.actionRef.note ? { note: entry.actionRef.note } : {}),
        }
      : undefined;
    if (!adapter) {
      return {
        state: 'action',
        entry: toSearchItem(entry),
        ...(staticBlock ? { action: staticBlock } : {}),
        reason: 'no owner adapter is wired for this domain on this host',
        ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      };
    }
    const status: ActionStatus = await adapter.describe(
      { caller, workspaceRoot: caller.workspaceId ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null) : null },
      entry,
    ).catch((error: unknown): ActionStatus => ({
      unavailable: error instanceof Error ? error.message : String(error),
    }));
    const liveVerbs = (entry.actionRef?.verbs ?? []).filter((verb) => adapter.verbs.includes(verb));
    if (status.unavailable) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        ...(staticBlock ? { action: { ...staticBlock, verbs: [], status: status.unavailable } } : {}),
        reason: status.unavailable,
        ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      };
    }
    return {
      state: 'action',
      entry: toSearchItem(entry),
      action: {
        domain: entry.actionRef?.domain ?? 'unknown',
        actions: Object.fromEntries(Object.entries(getSettingsActionContracts(entry)).filter(([verb]) => liveVerbs.includes(verb) && (!status.verbs || status.verbs.includes(verb)))),
        verbs: status.verbs ? status.verbs.filter((verb) => liveVerbs.includes(verb)) : liveVerbs,
        ...(entry.actionRef?.note ? { note: entry.actionRef.note } : {}),
        ...(status.summary ? { status: status.summary } : {}),
        ...(status.data !== undefined ? { data: status.data } : {}),
      },
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
    };
  };

  const invokeAction = async (
    caller: SettingsServiceCaller,
    params: SettingsActionParams,
  ): Promise<SettingsActionResult> => {
    const entry = requireEntry(params.id);
    if (entry.owner !== 'action' || !entry.actionRef) {
      throw new HarnessServiceError('denied', `"${entry.id}" is not a domain action entry (owner=${entry.owner})`);
    }
    const adapter = deps.actions?.adapterFor(entry.actionRef.domain) ?? null;
    if (!adapter) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `no owner adapter is wired for ${entry.actionRef.domain}`,
      };
    }
    const args = { ...params.args, ...(params.operationId ? { operationId: params.operationId } : {}) };
    const requestedOperationId = params.operationId
      ?? (typeof args.operationId === 'string' && args.operationId.trim() ? args.operationId.trim() : undefined);
    const workspaceRoot = caller.workspaceId
      ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null)
      : null;
    const actionContext = { caller, workspaceRoot };
    const operationResult = (
      record: NonNullable<Awaited<ReturnType<NonNullable<SettingsActionOperationStore['get']>>>>,
    ): SettingsActionResult => ({
      status: record.state === 'running' ? 'pending' : record.state === 'unavailable' ? 'unavailable' : record.state === 'succeeded' ? 'applied' : 'failed',
      entry: toSearchItem(entry),
      verb: params.verb,
      ...(record.detail ? { detail: record.detail } : {}),
      operation: {
        id: record.id,
        state: record.state,
        ...(record.cancelVerb ? { cancelVerb: record.cancelVerb } : {}),
        ...(record.detail ? { detail: record.detail } : {}),
      },
    });
    const makeOperation = (
      id: string,
      state: NonNullable<ActionInvocation['operation']>['state'],
      detail?: string,
      cancelVerb?: string,
    ): NonNullable<ActionInvocation['operation']> => ({
      id,
      state,
      ...(detail ? { detail } : {}),
      ...(cancelVerb ? { cancelVerb } : {}),
    });
    const persistOperation = async (
      operation: NonNullable<ActionInvocation['operation']>,
      detail?: string,
      ownerVerb = params.verb,
      expectedRecordRevision?: number,
    ): Promise<boolean> => {
      if (!deps.actionOperations) return false;
      try {
        await deps.actionOperations.put(caller, {
          id: operation.id,
          entryId: entry.id,
          verb: ownerVerb,
          state: operation.state,
          ...(detail ?? operation.detail ? { detail: detail ?? operation.detail } : {}),
          ...(operation.cancelVerb ? { cancelVerb: operation.cancelVerb } : {}),
          ...(expectedRecordRevision !== undefined ? { expectedRecordRevision } : {}),
        });
        return true;
      } catch {
        return false;
      }
    };
    if (requestedOperationId && (params.verb === 'status' || params.verb === 'cancel')) {
      const stored = await deps.actionOperations?.get(caller, entry.id, requestedOperationId).catch(() => null);
      if (!stored) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: `settings operation ${requestedOperationId} has no durable record for this Thread/branch`,
        };
      }
      if (stored.entryId !== entry.id) {
        return { status: 'denied', entry: toSearchItem(entry), verb: params.verb, detail: 'operation does not belong to this settings entry' };
      }
      if (params.verb === 'status') {
        if (stored.state !== 'running' && stored.state !== 'unavailable') return operationResult(stored);
        if (!adapter.getOperation) {
          const detail = 'owner has no durable operation status API; completion cannot be inferred after this boundary';
          const unavailable = makeOperation(
            stored.id,
            'unavailable',
            detail,
          );
          // Absence of an observer is not evidence that the owner's work stopped.
          return {
            status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
            detail, operation: unavailable,
          };
        }
        const observed = await adapter.getOperation(actionContext, entry, stored.id, args).catch((error: unknown): ActionInvocation => ({
          status: 'unavailable',
          detail: error instanceof Error ? error.message : String(error),
          operation: { id: stored.id, state: 'unavailable' },
        }));
        if (observed.status === 'unavailable' || observed.operation?.state === 'unavailable') {
          return { status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
            detail: observed.detail ?? 'owner status temporarily unavailable; query this same operation again',
            operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb) };
        }
        if (observed.operation && observed.operation.id !== stored.id) {
          return { status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
            detail: 'owner returned a different operation identity; no state was inferred',
            operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb) };
        }
        const operation = observed.operation && observed.operation.id === stored.id
          ? observed.operation
          : observed.status === 'pending'
            ? makeOperation(stored.id, 'running', observed.detail, stored.cancelVerb)
            : makeOperation(stored.id, observed.status === 'applied' ? 'succeeded' : 'failed', observed.detail, stored.cancelVerb);
        if (!await persistOperation(operation, observed.detail, stored.verb, stored.recordRevision)) {
          return {
            status: 'unavailable',
            entry: toSearchItem(entry),
            verb: params.verb,
            detail: 'owner state was observed, but Host could not commit the durable operation revision; query the same operation again',
            operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb),
          };
        }
        return {
          status: observed.status,
          entry: toSearchItem(entry),
          verb: params.verb,
          ...(observed.detail ? { detail: observed.detail } : {}),
          ...(observed.data !== undefined ? { data: observed.data } : {}),
          operation,
        };
      }
      if (stored.state !== 'running' && stored.state !== 'unavailable') return operationResult(stored);
      if (!stored.cancelVerb) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner does not expose a cancellation identity for this operation',
          operation: makeOperation(stored.id, stored.state, stored.detail),
        };
      }
      if (!adapter.cancelOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner does not expose a cancellation API for this operation',
          operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb),
        };
      }
      caller.onMutationState?.('started');
      const cancelled = await adapter.cancelOperation(actionContext, entry, stored.id, args).catch((error: unknown): ActionInvocation => ({
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
        operation: { id: stored.id, state: 'unavailable' },
      }));
      if (cancelled.mutation === 'none') caller.onMutationState?.('unchanged');
      else if (cancelled.mutation === 'applied' || cancelled.mutation === undefined && (cancelled.status === 'applied' || cancelled.status === 'pending')) caller.onMutationState?.('applied');
      if (cancelled.status === 'unavailable' || cancelled.operation?.state === 'unavailable'
        || cancelled.operation && cancelled.operation.id !== stored.id) {
        return { status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: cancelled.detail ?? 'cancellation outcome is unknown; query this same operation again',
          operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb) };
      }
      const cancellation = cancelled.operation && cancelled.operation.id === stored.id
        ? cancelled.operation
        : makeOperation(stored.id, cancelled.status === 'applied' ? 'cancelled' : 'running', cancelled.detail, stored.cancelVerb);
      if (!await persistOperation(cancellation, cancelled.detail, stored.verb, stored.recordRevision)) {
        return {
          status: 'unavailable',
          entry: toSearchItem(entry),
          verb: params.verb,
          detail: 'owner cancellation returned, but Host could not commit the durable operation revision; query the same operation again',
          operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb),
        };
      }
      return {
        status: cancelled.status,
        entry: toSearchItem(entry),
        verb: params.verb,
        ...(cancelled.detail ? { detail: cancelled.detail } : {}),
        ...(cancelled.data !== undefined ? { data: cancelled.data } : {}),
        operation: cancellation,
      };
    }
    if (requestedOperationId && !await deps.actionOperations?.get(caller, entry.id, requestedOperationId)) {
      return { status: 'denied', entry: toSearchItem(entry), verb: params.verb, detail: 'Operation does not belong to this Thread, branch and settings entry' };
    }
    const declared = entry.actionRef.verbs ?? [];
    if (declared.length > 0 && !declared.includes(params.verb) && params.verb !== 'status') {
      return {
        status: 'denied',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `verb "${params.verb}" is not declared on ${entry.id} — declared: ${declared.join(', ') || '(none)'}`,
      };
    }
    if (!adapter.verbs.includes(params.verb)) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `verb "${params.verb}" is not implemented by the ${entry.actionRef.domain} owner`,
      };
    }
    const capabilities: SettingsActionCapabilities = await (adapter.capabilities
      ? adapter.capabilities(actionContext, entry, params.verb, args)
      : { execution: 'sync' });
    const needsDurableOperation = capabilities.execution === 'async'
      || Boolean(capabilities.operation?.query);
    if (needsDurableOperation) {
      const operationStore = deps.actionOperations;
      const unavailableDetail = !operationStore
          ? 'asynchronous owner actions require durable Host operation storage'
          : !capabilities.operation?.query
            ? 'owner marked this action asynchronous without a queryable operation identity'
            : !adapter.getOperation
              ? 'owner marked this action queryable but exposes no operation status API'
              : null;
      if (unavailableDetail) {
        return { status: 'unavailable', entry: toSearchItem(entry), verb: params.verb, detail: unavailableDetail };
      }
      if (capabilities.operation?.cancel && !adapter.cancelOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner advertised cancellation but exposes no cancellation API',
        };
      }
      if (operationStore?.available && !await operationStore.available(caller).catch(() => false)) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'Host cannot durably record this owner operation for the Thread/branch',
        };
      }
      if (!operationStore?.available) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'Host operation storage cannot prove durable availability before invoke',
        };
      }
    }
    const contract = getSettingsActionContracts(entry)[params.verb];
    const mutating = contract?.mutation !== 'none';
    if (mutating) caller.onMutationState?.('started');
    const outcome: ActionInvocation = await adapter.invoke(
      actionContext,
      entry,
      params.verb,
      args,
    ).catch((error: unknown): ActionInvocation => ({
      status: 'failed' as const,
      detail: error instanceof Error ? error.message : String(error),
    }));
    if (mutating) {
      if (outcome.mutation === 'none') caller.onMutationState?.('unchanged');
      else if (outcome.mutation === 'applied' || outcome.mutation === undefined && (outcome.status === 'applied' || outcome.status === 'pending')) caller.onMutationState?.('applied');
    }
    if (outcome.status === 'pending' && !outcome.operation) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `${outcome.detail ?? 'owner started an asynchronous action'}; owner returned no stable status/cancel operation identity`,
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      };
    }
    if (outcome.operation) {
      const operationId = typeof outcome.operation.id === 'string' ? outcome.operation.id.trim() : '';
      if (!operationId) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner returned an operation without a stable identity',
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        };
      }
      if (outcome.operation.state === 'running' && !adapter.getOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner returned a running operation without a real status API',
          operation: { ...outcome.operation, id: operationId, state: 'unavailable' },
        };
      }
      if (outcome.operation.cancelVerb && !adapter.cancelOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner returned a cancellation identity without a real cancellation API',
          operation: { ...outcome.operation, id: operationId, state: 'unavailable' },
        };
      }
      if (!outcome.operation.id || !(await persistOperation(outcome.operation, outcome.detail))) {
        return {
          status: 'unavailable',
          entry: toSearchItem(entry),
          verb: params.verb,
          detail: 'owner returned an operation identity but Host could not durably record it for this Thread/branch; keep this identity and do not repeat the effect',
          operation: outcome.operation,
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        };
      }
    }
    return {
      status: outcome.status,
      entry: toSearchItem(entry),
      verb: params.verb,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.operation ? { operation: outcome.operation } : {}),
      mutation: mutating ? outcome.mutation ?? (outcome.status === 'applied' || outcome.status === 'pending' ? 'applied' : 'unknown') : 'none',
      ...(contract?.apply ? { appliedAt: contract.apply } : {}),
    };
  };

  /** One validated write spec — a single catalog entry plus its fields. */
  interface AppWrite {
    entry: SettingsCatalogEntry;
    set: Record<string, unknown>;
    reset: string[];
    itemIndex?: number;
    expectedRevision?: string | undefined;
  }

  /**
   * Commit one or more app-owner write specs in a single CAS transaction.
   * Per-item field validation decides membership; once at least one valid
   * field exists the merged change lands atomically — an item with zero valid
   * fields fails on its own without blocking the others.
   */
  const updateAppBatch = async (
    caller: SettingsServiceCaller,
    writes: AppWrite[],
    expectedRevision?: string,
  ): Promise<{
    items: SettingsItemResult[];
    revision?: string;
    effective?: Record<string, unknown>;
    document?: VarinSettingsDocument;
  }> => {
    const duplicateCheck = rejectConflictingDuplicatePaths(writes);
    writes = duplicateCheck.accepted;
    const itemResults: SettingsItemResult[] = [...duplicateCheck.rejected];
    const validSets: [string, unknown][] = [];
    const validResets: string[] = [];
    const validEntryIds: string[] = [];
    const allFields: SettingsFieldSpec[] = [];
    const current = await deps.readAppSettings();
    const currentRevision = settingsDocumentRevision(current);
    for (const write of writes) {
      const guard = write.expectedRevision ?? expectedRevision;
      if (guard !== undefined && guard !== currentRevision) {
        itemResults.push({
          id: write.entry.id,
        ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}),
          status: 'failed',
          error: `revision conflict — re-read and retry (current ${currentRevision})`,
          fields: [...Object.keys(write.set), ...write.reset].map((path) => ({
            path, status: 'failed', error: `revision conflict — re-read and retry (current ${currentRevision})`,
          })),
        });
        continue;
      }
      const byPath = new Map(entryFields(write.entry).map((field) => [field.path, field]));
      const fieldResults: SettingsFieldResult[] = [];
      const itemSets: [string, unknown][] = [];
      const itemResets: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be written through this service' });
          continue;
        }
        const problem = validateFieldValue(field, value);
        if (problem) {
          fieldResults.push({ path, status: 'failed', error: problem });
          continue;
        }
        itemSets.push([path, value]);
      }
      for (const path of write.reset) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be reset through this service' });
          continue;
        }
        itemResets.push(path);
      }
      if (itemSets.length === 0 && itemResets.length === 0) {
        itemResults.push({
          id: write.entry.id,
        ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}),
          status: 'failed',
          fields: fieldResults,
          error: 'no valid fields to write',
        });
        continue;
      }
      validSets.push(...itemSets);
      validResets.push(...itemResets);
      validEntryIds.push(write.entry.id);
      allFields.push(...entryFields(write.entry));
      itemResults.push({
        id: write.entry.id,
        ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}),
        status: fieldResults.length > 0 ? 'partial' : 'applied',
        fields: [
          ...itemSets.map(([path]): SettingsFieldResult => ({ path, status: 'applied' })),
          ...itemResets.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...fieldResults,
        ],
      });
    }
    if (validSets.length === 0 && validResets.length === 0) {
      return { items: itemResults, revision: currentRevision };
    }
    // Nested paths collapse into their top-level key — the persist pipeline
    // merges whole top-level objects, so a partial nested write must
    // read-modify-write its root inside the CAS revision.
    const changes: Record<string, unknown> = {};
    const removals: string[] = [];
    const nestedRoots = new Map<string, Record<string, unknown>>();
    for (const [path, value] of validSets) {
      if (!path.includes('.')) {
        changes[path] = value;
        continue;
      }
      const rootKey = path.split('.')[0]!;
      const rootObject = nestedRoots.get(rootKey)
        ?? (isRecord(getPath(current, rootKey)) ? structuredClone(getPath(current, rootKey) as Record<string, unknown>) : {});
      nestedRoots.set(rootKey, rootObject);
      setPath(rootObject, path.slice(rootKey.length + 1), value);
    }
    for (const path of validResets) {
      if (!path.includes('.')) {
        removals.push(path);
        continue;
      }
      const rootKey = path.split('.')[0]!;
      const rootObject = nestedRoots.get(rootKey)
        ?? (isRecord(getPath(current, rootKey)) ? structuredClone(getPath(current, rootKey) as Record<string, unknown>) : {});
      nestedRoots.set(rootKey, rootObject);
      deletePath(rootObject, path.slice(rootKey.length + 1));
    }
    for (const [rootKey, rootObject] of nestedRoots) {
      changes[rootKey] = rootObject;
    }
    // Always CAS on the document we just merged against: without an explicit
    // expectedRevision a concurrent UI write between read and transact would
    // otherwise be silently clobbered.
    caller.onMutationState?.('started');
    const outcome = await deps.persistAppSettings(
      changes,
      removals,
      currentRevision,
    );
    caller.onMutationState?.(outcome.conflict || isDeepStrictEqual(current, outcome.document) ? 'unchanged' : 'applied');
    if (outcome.conflict) {
      for (const item of itemResults) {
        if (item.status !== 'applied' && item.status !== 'partial') continue;
        item.status = 'failed';
        item.error = `revision conflict — re-read and retry (current ${outcome.revision})`;
        for (const field of item.fields ?? []) {
          if (field.status === 'applied') {
            field.status = 'failed';
            field.error = `revision conflict — re-read and retry (current ${outcome.revision})`;
          }
        }
      }
      return { items: itemResults, revision: outcome.revision };
    }
    for (const item of itemResults) {
      const write = writes.find(write => item.index === undefined ? write.entry.id === item.id : write.itemIndex === item.index);
      for (const field of item.fields ?? []) {
        if (field.status !== 'applied' || !write) continue;
        const saved = getPath(outcome.document, field.path);
        field.saved = saved;
        field.isSet = saved !== undefined;
        const spec = entryFields(write.entry).find(spec => spec.path === field.path);
        field.effective = { value: saved !== undefined ? saved : spec?.default,
          source: saved !== undefined ? 'user' : spec?.default !== undefined ? 'default' : 'none', basis: 'configured' };
        const requested = Object.hasOwn(write.set, field.path) ? write.set[field.path] : undefined;
        if (!isDeepStrictEqual(saved, requested)) {
          field.status = 'failed';
          field.error = 'owner did not persist the requested value; saved contains the authoritative result';
        }
      }
      const applied = item.fields?.filter(field => field.status === 'applied').length ?? 0;
      if (item.fields?.length) item.status = applied === item.fields.length ? 'applied' : applied ? 'partial' : 'failed';
      item.mutation = isDeepStrictEqual(current, outcome.document) ? 'none' : 'applied';
    }
    const effective: Record<string, unknown> = {};
    for (const field of allFields) {
      if (field.kind === 'secret') continue;
      const value = getPath(outcome.document, field.path);
      effective[field.path] = value !== undefined ? value : field.default;
    }
    deps.onChanged?.({
      owner: 'app',
      ids: validEntryIds,
      scope: 'host',
      revision: outcome.revision,
    });
    for (const item of itemResults) {
      if (item.mutation === 'applied' || item.fields?.some(field => Object.hasOwn(field, 'saved'))) item.revision = outcome.revision;
    }
    void caller;
    return { items: itemResults, revision: outcome.revision, effective, document: outcome.document };
  };

  const updateApp = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (params.surface) {
      throw new HarnessServiceError('denied', 'surface selection is Host-resolved from the caller Thread/branch; model supplied surface ids are not accepted');
    }
    if (params.scope !== undefined) {
      throw new HarnessServiceError(
        'denied',
        `"${entry.id}" is host-owned; global/project scope is only valid for agent-settings entries`,
      );
    }
    const { items, revision, effective } = await updateAppBatch(
      caller,
      [{ entry, set: params.set ?? {}, reset: params.reset ?? [], expectedRevision: params.expectedRevision }],
      params.expectedRevision,
    );
    const item = items[0]!;
    const fields = item.fields ?? [];
    return {
      status: item.status === 'applied' ? 'applied' : item.status === 'partial' ? 'partial' : 'failed',
      entry: toSearchItem(entry),
      scope: 'host',
      fields,
      ...(revision ? { revision } : {}),
      appliedAt: entry.apply ?? 'immediate',
      ...(effective ? { effective } : {}),
      mutation: item.mutation ?? 'none',
      consistency: 'compare-and-swap',
    };
  };

  interface AgentWrite {
    entry: SettingsCatalogEntry;
    set: Record<string, unknown>;
    reset: string[];
    itemIndex?: number;
    expectedRevision?: string | undefined;
  }

  /**
   * Commit one or more Agent-owner write specs at one scope in a single
   * `settings.update` call — the native settings owner's revision CAS covers the merged
   * top-level keys atomically.
   */
  const updateAgentBatch = async (
    caller: SettingsServiceCaller,
    scope: 'global' | 'project',
    writes: AgentWrite[],
    expectedRevision?: string,
  ): Promise<{ items: SettingsItemResult[]; revision?: string; effective?: Record<string, unknown> }> => {
    const root = caller.workspaceId ? await deps.resolveWorkspaceRoot(caller.workspaceId) : null;
    if (scope === 'project' && !root) throw new HarnessServiceError('unavailable', 'project settings require an admitted workspace');
    const duplicateCheck = rejectConflictingDuplicatePaths(writes);
    writes = duplicateCheck.accepted;
    const itemResults: SettingsItemResult[] = [...duplicateCheck.rejected];
    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    const validEntryIds: string[] = [];
    let snapshot = await deps.agentSettings().snapshot(scope === 'global' ? undefined : root ?? undefined);
    const currentRevision = scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision;
    for (const write of writes) {
      const submittedGuard = write.expectedRevision ?? expectedRevision;
      const transition = caller.permissionSettingsRevision;
      const guard = scope === 'global' && transition && submittedGuard === transition.before && currentRevision === transition.after
        ? transition.after : submittedGuard;
      if (guard !== undefined && guard !== currentRevision) {
        itemResults.push({
          id: write.entry.id,
        ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}),
          status: 'failed',
          error: `revision conflict — re-read and retry (current ${currentRevision})`,
          fields: [...Object.keys(write.set), ...write.reset].map((path) => ({
            path, status: 'failed', error: `revision conflict — re-read and retry (current ${currentRevision})`,
          })),
        });
        continue;
      }
      const byPath = new Map(entryFields(write.entry).map((field) => [field.path, field]));
      const fieldResults: SettingsFieldResult[] = [];
      const itemSetPaths: string[] = [];
      const itemResetPaths: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential references are managed by the native model credential owner, not this service' });
          continue;
        }
        if (scope === 'project' && field.scope === 'user') {
          fieldResults.push({ path, status: 'failed', error: `"${path}" is user-owned and cannot be written at project scope` });
          continue;
        }
        const problem = validateFieldValue(field, value);
        if (problem) {
          fieldResults.push({ path, status: 'failed', error: problem });
          continue;
        }
        itemSetPaths.push(path);
        set[path] = value;
      }
      for (const path of write.reset) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential references are managed by the native model credential owner, not this service' });
          continue;
        }
        if (scope === 'project' && field.scope === 'user') {
          fieldResults.push({ path, status: 'failed', error: `"${path}" is user-owned and cannot be reset at project scope` });
          continue;
        }
        itemResetPaths.push(path);
        remove.push(path);
      }
      if (itemSetPaths.length === 0 && itemResetPaths.length === 0) {
        itemResults.push({
          id: write.entry.id, ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}), status: 'failed', fields: fieldResults, error: 'no valid fields to write',
        });
        continue;
      }
      validEntryIds.push(write.entry.id);
      itemResults.push({
        id: write.entry.id,
        ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}),
        status: fieldResults.length > 0 ? 'partial' : 'applied',
        fields: [
          ...itemSetPaths.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...itemResetPaths.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...fieldResults,
        ],
      });
    }
    if (Object.keys(set).length === 0 && remove.length === 0) {
      return { items: itemResults, revision: currentRevision };
    }
    // CAS: the native settings authority pins the revision of the target scope file.
    // settings.update applies top-level keys only — nested paths
    // (harness.shell, …) are grouped into a read-modify-write of their root
    // object inside the same CAS revision.
    const layer = scope === 'project' ? snapshot.project : snapshot.global;
    const rootSets = new Map<string, Record<string, unknown>>();
    for (const [path, value] of Object.entries(set)) {
      if (!path.includes('.')) continue;
      const rootKey = path.split('.')[0]!;
      const currentRoot = getPath(layer, rootKey);
      const rootObject = rootSets.get(rootKey)
        ?? (isRecord(currentRoot) ? structuredClone(currentRoot) : {});
      rootSets.set(rootKey, rootObject);
      setPath(rootObject, path.slice(rootKey.length + 1), value);
    }
    const nestedResets = new Map<string, string[]>();
    for (const path of remove) {
      if (!path.includes('.')) continue;
      const rootKey = path.split('.')[0]!;
      const currentRoot = getPath(layer, rootKey);
      const rootObject = rootSets.get(rootKey)
        ?? (isRecord(currentRoot) ? structuredClone(currentRoot) : {});
      rootSets.set(rootKey, rootObject);
      nestedResets.set(rootKey, [...(nestedResets.get(rootKey) ?? []), path.slice(rootKey.length + 1)]);
    }
    const topLevelSet: Record<string, unknown> = {};
    const topLevelRemove: string[] = [];
    for (const [path, value] of Object.entries(set)) {
      if (!path.includes('.')) topLevelSet[path] = value;
    }
    for (const path of remove) {
      if (!path.includes('.')) topLevelRemove.push(path);
    }
    for (const [rootKey, rootObject] of rootSets) {
      for (const sub of nestedResets.get(rootKey) ?? []) {
        deletePath(rootObject, sub);
      }
      topLevelSet[rootKey] = rootObject;
    }
    caller.onMutationState?.('started');
    let updated;
    try {
      updated = await deps.agentSettings().update({
        ...(scope === 'project' && root ? { cwd: root } : {}),
        scope,
        expectedRevision: currentRevision,
        set: topLevelSet as Record<string, import('@varin/protocol').JsonValue>,
        remove: topLevelRemove,
      });
    } catch (error) {
      if (error instanceof ModelConfigurationError && error.code === 'config_conflict') {
        caller.onMutationState?.('unchanged');
      }
      if (error instanceof ModelConfigurationError) {
        if (error.code !== 'config_conflict') caller.onMutationState?.('unchanged');
        const detail = error.message;
        for (const item of itemResults) {
          if (item.status !== 'applied' && item.status !== 'partial') continue;
          item.status = 'failed'; item.error = detail; item.mutation = 'none';
          for (const field of item.fields ?? []) if (field.status === 'applied') { field.status = 'failed'; field.error = detail; }
        }
        return { items: itemResults, revision: currentRevision };
      }
      throw new HarnessServiceError('failed', error instanceof Error ? error.message : String(error));
    }
    caller.onMutationState?.('applied');
    snapshot = updated;
    const revision = scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision;
    // Saved values come from the exact commit. Resolve the admitted context
    // separately; an unavailable layer never becomes a guessed effective value.
    const effectiveSnapshot = root
      ? await deps.agentSettings().snapshot(root).catch(() => null) : snapshot;
    const effective: Record<string, unknown> = {};
    for (const item of itemResults) {
      const write = writes.find(write => item.index === undefined ? write.entry.id === item.id : write.itemIndex === item.index);
      item.mutation = item.status === 'applied' || item.status === 'partial' ? 'applied' : 'none';
      for (const result of item.fields ?? []) {
        if (result.status !== 'applied') continue;
        result.saved = getPath(scope === 'project' ? snapshot.project : snapshot.global, result.path);
        result.isSet = result.saved !== undefined;
        const field = write && entryFields(write.entry).find(field => field.path === result.path);
        if (field && effectiveSnapshot) {
          result.effective = resolveAgentSettingsField(effectiveSnapshot, field);
          effective[result.path] = result.effective.value;
        }
      }
    }
    deps.onChanged?.({
      owner: 'agent-settings',
      ids: validEntryIds,
      scope,
      revision,
    });
    for (const item of itemResults) {
      if (item.status === 'applied' || item.status === 'partial') item.revision = revision;
    }
    return { items: itemResults, revision, effective };
  };

  const updateAgent = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (entry.scope && params.scope && params.scope !== entry.scope) throw new HarnessServiceError('denied', `"${entry.id}" targets ${entry.scope} settings`);
    const scope = params.scope ?? entry.scope ?? 'global';
    const { items, revision, effective } = await updateAgentBatch(
      caller,
      scope,
      [{ entry, set: params.set ?? {}, reset: params.reset ?? [], expectedRevision: params.expectedRevision }],
      params.expectedRevision,
    );
    const item = items[0]!;
    const fields = item.fields ?? [];
    return {
      status: item.status === 'applied' ? 'applied' : item.status === 'partial' ? 'partial' : 'failed',
      entry: toSearchItem(entry),
      scope,
      fields,
      ...(revision ? { revision } : {}),
      appliedAt: entry.apply ?? 'next-run',
      mutation: item.mutation ?? 'none',
      consistency: 'compare-and-swap',
      ...(effective ? { effective } : {}),
    };
  };

  /**
   * `client` entries apply on the connected surface through the targeted
   * bridge — the surface's own store writes the value and reports the fact.
   */
  const updateClientBatch = async (caller: SettingsServiceCaller, originalWrites: OwnerWrite[]): Promise<{
    items: SettingsItemResult[]; effective?: Record<string, unknown>; surface?: SettingsUpdateResult['surface'];
  }> => {
    const bridge = deps.clientSurfaces;
    if (!bridge) throw new HarnessServiceError('unavailable', 'no client surface channel is registered on this Host');
    const grouped = new Map<string, OwnerWrite[]>();
    for (const write of originalWrites) grouped.set(write.entry.id, [...(grouped.get(write.entry.id) ?? []), write]);
    const checks = [...grouped.values()].map(writes => rejectConflictingDuplicatePaths(writes));
    const duplicateCheck = { accepted: checks.flatMap(check => check.accepted), rejected: checks.flatMap(check => check.rejected) };
    const items: SettingsItemResult[] = [...duplicateCheck.rejected];
    const entries: Parameters<ClientSurfaceBridge['request']>[0]['entries'] = [];
    for (const write of duplicateCheck.accepted) {
      const byPath = new Map(entryFields(write.entry).map(field => [field.path, field]));
      const fields: SettingsFieldResult[] = [];
      const values: Record<string, unknown> = {};
      const reset: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        const error = !field ? `field "${path}" is not part of ${write.entry.id}` : validateFieldValue(field, value);
        fields.push({ path, status: error ? 'failed' : 'applied', ...(error ? { error } : {}) });
        if (!error) values[path] = value;
      }
      for (const path of write.reset) {
        const error = !byPath.has(path) ? `field "${path}" is not part of ${write.entry.id}` : Object.hasOwn(write.set, path) ? 'a field cannot be set and reset together' : undefined;
        fields.push({ path, status: error ? 'failed' : 'applied', ...(error ? { error } : {}) });
        if (!error) reset.push(path);
      }
      const valid = Object.keys(values).length > 0 || reset.length > 0;
      items.push({ id: write.entry.id, ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}), status: 'failed', fields, mutation: 'none' });
      if (valid) entries.push({ id: write.entry.id, ...(write.itemIndex !== undefined ? { itemIndex: write.itemIndex } : {}), values, reset,
        ...(write.expectedRevision !== undefined ? { expectedRevision: write.expectedRevision } : {}) });
    }
    if (!entries.length) return { items };
    let dispatched=false;
    const onDispatch=()=>{dispatched=true;entries.forEach(() => caller.onMutationState?.('started'));};
    // The bridge validates the observed connection before reporting dispatch.
    const response = await bridge.request({ type: 'apply', entries }, {...caller,onDispatch});
    if (!dispatched) onDispatch();
    const effective: Record<string, unknown> = {};
    for (const entry of entries) {
      const result = response.results.find(result => result.id === entry.id && result.itemIndex === entry.itemIndex);
      const item = items.find(item => item.id === entry.id && item.index === entry.itemIndex)!;
      const mutation = result?.mutation ?? (result?.status === 'applied' ? 'applied' : 'unknown');
      item.mutation = mutation;
      if (mutation !== 'unknown') caller.onMutationState?.(mutation === 'applied' ? 'applied' : 'unchanged');
      if (result?.revision) item.revision = result.revision;
      item.consistency = result?.consistency ?? 'last-write-wins';
      for (const field of item.fields ?? []) {
        if (field.status !== 'applied') continue;
        field.status = result?.status === 'applied' ? 'applied' : 'failed';
        if (result?.error) field.error = result.error;
        if (result?.values && Object.hasOwn(result.values, field.path)) {
          field.saved = result.values[field.path];
          field.isSet = result.values[field.path] !== undefined;
          effective[field.path] = result.values[field.path];
          field.effective = { value: result.values[field.path], source: 'runtime', basis: 'active' };
        }
      }
      const applied = item.fields?.filter(field => field.status === 'applied').length ?? 0;
      item.status = applied === item.fields?.length ? 'applied' : applied > 0 ? 'partial' : result?.status === 'unavailable' || !result ? 'unavailable' : 'failed';
      if (result?.error || !result) item.error = result?.error ?? 'Surface did not acknowledge this entry';
      if (mutation === 'applied') deps.onChanged?.({ owner: 'client', ids: [entry.id], scope: 'client', revision: result?.revision ?? '' });
    }
    return { items, effective, surface: { ...response.surface, results: response.results.map(result => ({ path: result.id, status: result.status, ...(result.error ? { error: result.error } : {}) })) } };
  };

  const updateClient = async (entry: SettingsCatalogEntry, caller: SettingsServiceCaller, params: SettingsUpdateParams | SettingsUpdateItem): Promise<SettingsUpdateResult> => {
    if (params.scope !== undefined || params.surface) throw new HarnessServiceError('denied', 'client scope and Surface are resolved from the admitted caller; global/project/surface selectors are not accepted');
    const batch = await updateClientBatch(caller, [{ entry, set: params.set ?? {}, reset: params.reset ?? [], expectedRevision: params.expectedRevision }]);
    const item = batch.items[0]!;
    return { status: item.status === 'applied' ? 'applied' : item.status === 'partial' ? 'partial' : 'failed',
      entry: toSearchItem(entry), scope: 'client', fields: item.fields ?? [], appliedAt: entry.apply ?? 'immediate',
      mutation: item.mutation ?? 'none', consistency: item.consistency ?? 'last-write-wins',
      ...(item.revision ? { revision: item.revision } : {}), ...(batch.effective ? { effective: batch.effective } : {}),
      ...(batch.surface ? { surface: batch.surface } : {}),
    };
  };

  /**
   * Compound update: validate every item, then execute per owner group.
   * Same-owner app items land in one CAS write; agent-settings merge per scope;
   * client items go to the resolved surface in one request; action entries
   * are reported as needing `settings.action`. Per-item results keep partial
   * success visible — no fake global transaction is implied.
   */
  const updateCompound = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const items = params.items ?? [];
    if (params.scope !== undefined || params.expectedRevision !== undefined || params.set !== undefined || params.reset !== undefined) {
      throw new HarnessServiceError('denied', 'compound writes carry scope, revision, set and reset on each item, not on the envelope');
    }
    const itemResults: SettingsItemResult[] = [];
    type Group = { owner: 'app' | 'agent-settings' | 'client'; scope: 'host' | 'global' | 'project' | 'client'; writes: OwnerWrite[] };
    const groups = new Map<string, Group>();
    for (const [index, item] of items.entries()) {
      const entry = getSettingsCatalogEntry(item.id);
      const fail = (error: string) => itemResults.push({ id: item.id, index, status: 'failed', error, mutation: 'none' });
      if (!entry) { fail(`unknown settings id "${item.id}"`); continue; }
      if (entry.writable === false) { fail(`"${item.id}" is read-only: the saved compatibility setting has no active consumer`); continue; }
      if (item.surface || params.surface) { fail('surface selection is Host-resolved from the caller Thread/branch'); continue; }
      if (entry.owner === 'action') { fail(`"${item.id}" is a domain action — invoke it through settings.action`); continue; }
      if (entry.owner !== 'agent-settings' && item.scope !== undefined) { fail(`"${item.id}" does not accept global/project scope`); continue; }
      if (entry.scope && item.scope && item.scope !== entry.scope) { fail(`"${item.id}" targets ${entry.scope} settings`); continue; }
      const scope = entry.owner === 'agent-settings' ? item.scope ?? entry.scope ?? 'global' : entry.owner === 'app' ? 'host' : 'client';
      const key = `${entry.owner}:${scope}`;
      const group = groups.get(key) ?? { owner: entry.owner, scope, writes: [] };
      group.writes.push({ entry, itemIndex: index, set: item.set ?? {}, reset: item.reset ?? [], expectedRevision: item.expectedRevision });
      groups.set(key, group);
    }
    // Each owner remains its own transaction. A later exception cannot erase
    // committed earlier receipts or prevent unrelated owners from answering.
    for (const group of groups.values()) {
      let pending = 0;
      let changed = false;
      const groupCaller: SettingsServiceCaller = { ...caller, onMutationState(state) {
        if (state === 'started') pending++;
        else { pending = Math.max(0, pending - 1); if (state === 'applied') changed = true; }
        caller.onMutationState?.(state);
      } };
      try {
        const batch = group.owner === 'app' ? await updateAppBatch(groupCaller, group.writes)
          : group.owner === 'agent-settings' ? await updateAgentBatch(groupCaller, group.scope as 'global' | 'project', group.writes)
          : await updateClientBatch(groupCaller, group.writes);
        for (const result of batch.items) {
          const entry = group.writes.find(write => write.itemIndex === result.index)!.entry;
          itemResults.push({ ...result, scope: group.scope, appliedAt: entry.apply ?? (group.owner === 'agent-settings' ? 'next-run' : 'immediate'),
            mutation: result.mutation ?? (result.status === 'applied' || result.status === 'partial' ? 'applied' : 'none'),
            ...(batch.effective ? { effective: Object.fromEntries(entryFields(entry).filter(field => Object.hasOwn(batch.effective!, field.path)).map(field => [field.path, batch.effective![field.path]])) } : {}),
          });
        }
      } catch (error) {
        for (const write of group.writes) itemResults.push({ id: write.entry.id, ...(write.itemIndex !== undefined ? { index: write.itemIndex } : {}), status: 'unavailable', scope: group.scope,
          appliedAt: write.entry.apply ?? (group.owner === 'agent-settings' ? 'next-run' : 'immediate'),
          mutation: pending > 0 ? 'unknown' : changed ? 'applied' : 'none',
          error: error instanceof Error ? error.message : String(error) });
      }
    }
    const ordered = itemResults.sort((a, b) => a.index! - b.index!);
    const firstKnown = items.map(item => getSettingsCatalogEntry(item.id)).find(entry => entry !== undefined);
    const failed = ordered.filter(item => item.status === 'failed' || item.status === 'unavailable').length;
    const scopes = new Set(ordered.flatMap(item => item.scope ? [item.scope] : []));
    const timings = new Set(ordered.flatMap(item => item.appliedAt ? [item.appliedAt] : []));
    return {
      status: !ordered.length || failed === ordered.length ? 'failed' : failed > 0 || ordered.some(item => item.status === 'partial') ? 'partial' : 'applied',
      entry: firstKnown ? toSearchItem(firstKnown)
        : { id: items[0]?.id ?? params.id ?? '', category: '', owner: 'app', titleKey: '', paths: [], writable: false, page: '' },
      scope: scopes.size === 1 ? [...scopes][0]! : 'mixed', fields: [],
      appliedAt: timings.size === 1 ? [...timings][0]! : 'per-item',
      mutation: ordered.some(item => item.mutation === 'unknown') ? 'unknown' : ordered.some(item => item.mutation === 'applied') ? 'applied' : 'none',
      items: ordered,
    };
  };

  const update = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (params.items && params.items.length > 0) {
      return updateCompound(caller, params);
    }
    if (!params.id) throw new HarnessServiceError('invalid-params', 'single-entry updates require id');
    const entry = requireEntry(params.id);
    if (entry.writable === false) throw new HarnessServiceError('unavailable', `"${entry.id}" is read-only: the saved compatibility setting has no active consumer`);
    switch (entry.owner) {
      case 'app':
        return updateApp(entry, caller, params);
      case 'agent-settings':
        return updateAgent(entry, caller, params);
      case 'client':
        return updateClient(entry, caller, params);
      case 'action':
      default:
        throw new HarnessServiceError(
          'denied',
          `"${entry.id}" is a domain action (${entry.actionRef?.domain ?? 'unknown'}) — invoke it through settings.action`,
        );
    }
  };

  return { search, read, update, action: invokeAction };
}

export { listSettingsCategories };
