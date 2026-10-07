/**
 * Agent-facing settings service (D-306 / Stage S).
 *
 * These methods expose the shared settings catalog
 * (`@varin/application-client` `SETTINGS_CATALOG`) to harness workers.
 * Values are always resolved through the owning authority — the Varin
 * settings document, Pi `settings.json`, or the domain service an `action`
 * entry points at. The service never maintains a parallel store.
 */

export type SettingsValueScope = "global" | "project" | "effective";

/** Result of resolving one catalog entry against its owner. */
export type SettingsEntryState =
  /** Value read through the owner. */
  | "ok"
  /** Entry exists but has no stored value (navigation/action row). */
  | "no-value"
  /** Owner refused — e.g. untrusted project scope, permission denied. */
  | "denied"
  /** Stored value is malformed for the declared spec. */
  | "malformed"
  /** Owner unavailable (desktop bridge, missing runtime, offline host). */
  | "unavailable"
  /** Entry is a domain action, not a field — see actionRef. */
  | "action";

export interface SettingsSearchParams {
  query?: string;
  category?: string;
  owner?: "app" | "pi-settings" | "client" | "action";
  id?: string;
  limit?: number;
  offset?: number;
}

export interface SettingsSearchItem {
  id: string;
  category: string;
  owner: "app" | "pi-settings" | "client" | "action";
  /** i18n key for the human title (same key the settings page renders). */
  titleKey: string;
  /** Machine-usable paths this row controls, if any. */
  paths: string[];
  writable: boolean;
  apply?: "immediate" | "next-run" | "restart" | "manual";
  /** Settings-page slug; the UI focuses this row by id. */
  page: string;
  keywords?: string[];
  note?: string;
  /**
   * Live summary for simple entries — enough to decide a change without a
   * follow-up `settings.read`. Omitted when the owner can't answer cheaply
   * or the entry needs detail context (multi-field rows, dynamic options).
   * Secret values never appear — `isSet` only.
   */
  summary?: {
    /** Effective value in force right now. */
    value?: unknown;
    source?: "user" | "project" | "default" | "runtime" | "none" | "surface";
    isSet?: boolean;
    /** Field kind for single-field entries (boolean/enum/number/…). */
    fieldKind?: string;
    /** Declared enum options — dynamic lists still come from settings.read. */
    options?: { value: string; label?: string }[];
    /** `action` entries: verbs declared on the catalog entry. */
    verbs?: string[];
    /** `client` entries: how many surfaces are connected right now. */
    surfaces?: number;
  };
}

export interface SettingsSearchResult {
  items: SettingsSearchItem[];
  total: number;
  categories: { category: string; count: number }[];
  /** Partial keyword matches when the full query had no match. */
  related?: SettingsSearchItem[];
}

export interface SettingsFieldValue {
  path: string;
  kind: string;
  /** Value saved at the requested scope (undefined = unset). */
  saved?: unknown;
  /** Whether the field is set at this scope (distinguishes unset from null). */
  isSet: boolean;
}

export interface SettingsReadParams {
  /** Stable catalog id. */
  id: string;
  /** `pi-settings` entries: which file to read. Default `effective`. */
  scope?: SettingsValueScope;
  /** Include options, related entries, notes and help references. */
  detail?: boolean;
  /** Legacy selector rejected by Host; client entries resolve Surface from caller session. */
  surface?: string;
}

export interface SettingsReadResult {
  state: SettingsEntryState;
  entry: SettingsSearchItem;
  /** Per-field saved values at the requested scope. */
  fields?: SettingsFieldValue[];
  /**
   * Resolved value actually in force, with the scope that produced it.
   * Absent when the entry has no value or the owner is unavailable.
   */
  effective?: {
    value: unknown;
    source: "user" | "project" | "default" | "runtime" | "none";
  };
  /**
   * Content-hash revision of the owning document at read time — pass back as
   * `expectedRevision` in `settings.update` for compare-and-swap.
   * `pi-settings` entries may carry one revision per scope.
   */
  revision?: string;
  revisions?: { global?: string; project?: string };
  /** Resolved dynamic options when the field declares an optionsSource. */
  options?: { value: string; label?: string }[];
  /** Catalog ids of related rows (same page/group). */
  related?: string[];
  /** Progressive-disclosure help pointer for complex entries. */
  help?: string;
  /** Owning domain action description for `action` entries. */
  action?: {
    domain: string;
    /** Verbs actually invocable right now (owner reported; catalog fallback). */
    verbs?: string[];
    note?: string;
    /** Live one-line state summary reported by the owner. */
    status?: string;
    /** Structured owner state (lists, snapshots) when the owner provides it. */
    data?: unknown;
  };
  /** Human-readable reason for denied/malformed/unavailable states. */
  reason?: string;
}

export interface SettingsUpdateChange {
  /** Field path within the entry (must be one of the entry's declared paths). */
  path: string;
  /** New value. Omit for reset entries in `reset`. */
  value?: unknown;
}

export interface SettingsUpdateParams {
  id: string;
  /** `pi-settings` entries: target file. Default `global`. */
  scope?: "global" | "project";
  /** Field paths → values. May address one or several fields of the entry. */
  set?: Record<string, unknown>;
  /** Field paths to remove (restore default / clear override). */
  reset?: string[];
  /** CAS guard: revision previously returned by `settings.read`. */
  expectedRevision?: string;
  /** Legacy selector rejected by Host; client entries resolve Surface from caller session. */
  surface?: string;
  /**
   * Compound update: several catalog entries in one request. Each item shares
   * the update semantics of a single-entry call; same-owner app fields commit
   * atomically, cross-owner items execute in order and report per-item status.
   * When present, `id` still identifies the first item's entry.
   */
  items?: SettingsUpdateItem[];
}

export interface SettingsUpdateItem {
  id: string;
  scope?: "global" | "project";
  set?: Record<string, unknown>;
  reset?: string[];
  expectedRevision?: string;
  /** Legacy selector rejected by Host; client entries resolve Surface from caller session. */
  surface?: string;
}

export interface SettingsItemResult {
  id: string;
  status: "applied" | "partial" | "pending" | "failed" | "unavailable";
  fields?: SettingsFieldResult[];
  revision?: string;
  error?: string;
}

export interface SettingsFieldResult {
  path: string;
  status: "applied" | "failed";
  error?: string;
}

export interface SettingsUpdateResult {
  /** Overall outcome; `partial` = some fields/items failed within one owner or batch. */
  status: "applied" | "partial" | "failed" | "pending";
  entry: SettingsSearchItem;
  scope: "host" | "global" | "project" | "client" | "action";
  fields: SettingsFieldResult[];
  /** New owner revision after a successful write (for follow-up CAS). */
  revision?: string;
  /** When the change actually reaches the running product. */
  appliedAt: "immediate" | "next-run" | "restart" | "manual";
  /** Post-write effective state for the affected fields. */
  effective?: Record<string, unknown>;
  /** Domain-action result for `action` entries. */
  actionResult?: { verb: string; detail?: string };
  /** Per-item outcomes for compound `items` updates. */
  items?: SettingsItemResult[];
  /**
   * `client` entries: which surface acknowledged the apply, plus per-surface
   * facts (applied / failed / unavailable). Absent when no surface answered.
   */
  surface?: {
    id: string;
    kind: string;
    results: { path: string; status: "applied" | "failed" | "unavailable"; error?: string }[];
  };
}

/**
 * `settings.action` — invoke a real domain operation on an `owner:"action"`
 * catalog entry (provider login, package install, tunnel start, …).
 */
export interface SettingsActionParams {
  /** Stable catalog id. */
  id: string;
  /** One of the entry's advertised verbs (`settings.read` reports live verbs). */
  verb: string;
  /** Existing owner operation to inspect/cancel; never generated by the Host. */
  operationId?: string;
  /** Verb arguments: providerId, source, name, content, expectedRevision, … */
  args?: Record<string, unknown>;
}

export interface SettingsActionOperation {
  /** Stable operation identity for later status checks. */
  id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "unavailable";
  /** How to observe or cancel the operation (verb + args hint). */
  cancelVerb?: string;
  detail?: string;
}

export interface SettingsActionResult {
  status: "applied" | "pending" | "failed" | "unavailable" | "denied";
  entry: SettingsSearchItem;
  verb: string;
  /** Human-readable outcome. */
  detail?: string;
  /** Structured state the owner returned (lists, status snapshots). */
  data?: unknown;
  /** Long-running operations expose their real handle here. */
  operation?: SettingsActionOperation;
}
