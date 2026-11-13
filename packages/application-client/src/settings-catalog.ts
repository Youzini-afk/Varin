import { DEFAULT_HARNESS_SETTINGS, DEFAULT_COMPACTION_RESERVE_RATIO } from '@varin/protocol';
import { settingsValueSchema } from './settings-value-schemas.js';

/**
 * Shared settings catalog (D-306 / Stage S).
 *
 * One UI-independent descriptor list consumed by both the settings-page search
 * (`packages/ui`) and the agent-facing `settings_*` tools served by the
 * Application Host (`packages/web`). It describes *what exists* and *who owns
 * it* — it never stores values itself.
 *
 * Owners:
 *  - `app`         Varin settings document (settings.json in VARIN_DATA_DIR),
 *                  written through the settings runtime's serialized store.
 *  - `agent-settings` native `agent-settings.json` + trusted project `.varin/settings.json`,
 *                  written through the native AgentSettingsService
 *                  protocol with content-hash revisions.
 *  - `client`      Device-local UI state (localStorage/Zustand/Electron bridge).
 *                  An authenticated Surface applies its own fields and returns
 *                  the actual result; the Host does not persist a duplicate.
 *  - `action`      The "setting" is really a domain object or operation
 *                  (extensions, providers, MCP, language packs, …). The entry
 *                  points at the real owner surface; reads report status,
 *                  writes go through the domain's own authority, never a config
 *                  field that merely looks like state.
 */

export type SettingsOwnerKind = 'app' | 'agent-settings' | 'client' | 'action';

export type SettingsCategory =
  | 'appearance' | 'notifications' | 'chat' | 'sessions' | 'editor' | 'terminal'
  | 'model' | 'harness' | 'retrieval' | 'web' | 'extensions' | 'agents'
  | 'git' | 'tunnel' | 'projects' | 'voice' | 'runtime'
  | 'providers' | 'knowledge' | 'language' | 'remote' | 'productivity';

export type SettingsValueKind =
  | 'boolean' | 'number' | 'enum' | 'string' | 'string-list' | 'json' | 'secret';

/** Dynamic option sets the owning surface can resolve at read time. */
export type SettingsOptionSource =
  | 'models'          // provider/model pairs the host can enumerate
  | 'thinking-levels' // effort variants for the current default model
  | 'themes'          // UI theme ids — resolved by the UI, host returns source name
  | 'locales'         // installed UI locales
  | 'git-identities'; // configured git identity profiles

export interface SettingsFieldSpec {
  /** Document key (`app`) or dot path (`agent-settings`, e.g. `harness.shell`). */
  path: string;
  kind: SettingsValueKind;
  options?: readonly { value: string; labelKey?: string }[];
  optionsSource?: SettingsOptionSource;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  integer?: boolean;
  unit?: string;
  /** Value may be explicitly cleared (null/delete) rather than set. */
  nullable?: boolean;
  multiline?: boolean;
  maxLength?: number;
  /** Free-form note surfaced to agents (units, format, caveats). */
  note?: string;
  /** Machine-readable owner shape for structured values; validated without coercion. */
  schema?: Record<string, unknown>;
  /** Set replaces this declared path; it is not an implicit deep merge. */
  updateMode?: 'replace';
  /** This field changes policy or credential routing, not ordinary preferences. */
  authority?: 'permissions' | 'credentials';
  /**
   * `agent-settings` scope rule. `user` = global file only; `user-or-project`
   * = writable at either scope. User-owned fields silently dropped into a
   * project file are rejected by the owner, so the catalog refuses them
   * up front.
   */
  scope?: 'user' | 'user-or-project';
  /** Removing the field restores this default (shown, not applied blindly). */
  default?: unknown;
}

export interface SettingsAvailability {
  /** Desktop shell required (or forbidden when false). */
  desktop?: boolean;
  /** Desktop shell connected to its own local host. */
  desktopLocal?: boolean;
  /** Web/mobile surface (non-desktop shell). */
  web?: boolean;
  /** Mobile form factor required (or forbidden when false). */
  mobile?: boolean;
  /** Host OS constraint. */
  platform?: 'mac' | 'windows' | 'linux' | 'not-mac';
}

export interface SettingsActionRef {
  /**
   * Owning domain surface the real operation lives on. `runtime:*` methods are
   * native Host owner calls; `service:*` are Application Host services; `tool:*`
   * entries defer to an existing agent tool; `page:*` is UI-only management.
   */
  domain:
    | 'runtime:providers'
    | 'runtime:mcp' | 'runtime:language-support'
    | 'service:git' | 'service:tunnel'
    | 'service:extension-packages' | 'service:extensions' | 'service:agents' | 'service:embedding-requests'
    | 'service:notifications' | 'service:projects' | 'service:remote-instances'
    | 'service:self-bot' | 'service:self-conversation' | 'service:web-search'
    | 'tool:resource' | 'tool:extension' | 'page:ui';
  /** What the agent can actually do without opening the UI. */
  verbs?: readonly string[];
  note?: string;
}

/** A real owner action's accepted arguments and effect boundary. */
export interface SettingsActionContract {
  inputSchema: Record<string, unknown>;
  mutation: 'none' | 'owner';
  apply?: SettingsCatalogEntry['apply'];
  note?: string;
  authority?: 'permissions' | 'credentials';
}

export interface SettingsCatalogEntry {
  /** Stable identifier — also the settings-page focus target. */
  id: string;
  category: SettingsCategory;
  owner: SettingsOwnerKind;
  /** Semantic management authority, separate from ordinary preference edits. */
  authority?: 'permissions' | 'credentials';
  /** Fixed target for project-only aliases; omitted leaves scope selectable. */
  scope?: 'project';
  /** Legacy settings without an execution consumer can remain inspectable. */
  writable?: boolean;
  /** Single-path field. */
  field?: SettingsFieldSpec;
  /** Multi-path group — update accepts a subset of `fields`. */
  fields?: readonly SettingsFieldSpec[];
  /** Non-field entries: the domain action this row points at. */
  actionRef?: SettingsActionRef;
  /**
   * How a saved change reaches the running product. `immediate` = live once
   * saved; `next-request` = at the following model request;
   * `next-run` = applied when the owning run/session starts;
   * `restart` = needs a host/surface restart; `manual` = requires a user or
   * domain action the catalog cannot perform.
   */
  apply?: 'immediate' | 'next-request' | 'next-run' | 'restart' | 'manual' | 'unsupported';
  /** Pointer for `settings_read(detail)` — doc anchor or resource hint. */
  helpRef?: string;
  ui: {
    page: string;
    titleKey: string;
    descriptionKey?: string;
    keywords?: readonly string[];
    availability?: SettingsAvailability;
  };
}

export interface SettingsCatalogContext {
  isDesktop: boolean;
  isWeb: boolean;
  isMobile: boolean;
  isDesktopLocalOrigin: boolean;
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
}

export function isCatalogEntryAvailable(
  availability: SettingsAvailability | undefined,
  ctx: SettingsCatalogContext,
): boolean {
  if (!availability) return true;
  if (availability.desktop === true && !ctx.isDesktop) return false;
  if (availability.desktop === false && ctx.isDesktop) return false;
  if (availability.desktopLocal === true && !ctx.isDesktopLocalOrigin) return false;
  if (availability.web === true && !(ctx.isWeb && !ctx.isDesktop)) return false;
  if (availability.mobile === true && !ctx.isMobile) return false;
  if (availability.mobile === false && ctx.isMobile) return false;
  switch (availability.platform) {
    case 'mac': return ctx.isMac;
    case 'windows': return ctx.isWindows;
    case 'linux': return ctx.isLinux;
    case 'not-mac': return ctx.isWindows || ctx.isLinux || !ctx.isMac;
    default: return true;
  }
}

const modelField = (path: string, scope: 'user' | 'user-or-project'): SettingsFieldSpec => ({
  path, kind: 'string', optionsSource: 'models', scope,
  note: 'model id; set the paired provider field from the option label when required',
});

const CATALOG_ENTRIES: readonly SettingsCatalogEntry[] = [
  // ── Harness (agent-settings owner) ──────────────────────────────────────────
  {
    id: 'harness.tools', category: 'harness', owner: 'agent-settings',
    field: { path: 'harness.tools', kind: 'json', scope: 'user-or-project',
      note: 'Record<toolName, boolean> enablement map; absent tools use the assembled default set' },
    apply: 'next-run',
    helpRef: 'docs/workbench.md#设置与呈现状态',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.section.tools',
      keywords: ['bash', 'grep', 'apply_patch', 'diagnostics', 'tools'] },
  },
  {
    id: 'harness.shell', category: 'harness', owner: 'agent-settings',
    fields: [
      { path: 'harness.shell', kind: 'enum', scope: 'user',
        options: [
          ...['auto', 'bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'].map(value => ({ value })),
        ], default: 'auto' },
    ],
    apply: 'next-request',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.shell.label',
      descriptionKey: 'settings.page.harness.shell.description',
      keywords: ['shell', 'bash', 'git bash', 'pwsh', 'powershell', 'cmd', 'environment'] },
  },
  {
    id: 'harness.output', category: 'harness', owner: 'agent-settings',
    field: { path: 'harness.output.visibleBytes', kind: 'number', scope: 'user-or-project',
      min: 1024, integer: true, unit: 'bytes', default: 32768 },
    apply: 'next-run',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.section.output',
      keywords: ['bytes', 'output', 'KiB'] },
  },
  {
    id: 'harness.permissions.mode', category: 'harness', owner: 'agent-settings', authority: 'permissions',
    field: { path: 'harness.permissions.mode', kind: 'enum', scope: 'user-or-project',
      options: [
        { value: 'normal' }, { value: 'bypass' },
      ], default: 'normal', note: 'Controls Host extension/MCP permission admission; project mode can only narrow the global mode. Legacy smart/accept-edits values are preserved on read but currently use normal semantics; native Source and Storage authority is independent.' },
    apply: 'immediate',
    ui: { page: 'harness-permissions', titleKey: 'settings.page.harness.permissions.mode.label',
      keywords: ['smart', 'approval', 'bypass', 'permission'] },
  },
  {
    id: 'harness.permissions.rules', category: 'harness', owner: 'agent-settings', authority: 'permissions',
    field: { path: 'harness.permissions.rules', kind: 'json', scope: 'user-or-project',
      note: 'PermissionRule[] — ordered allow/deny/ask patterns for the next Host extension/MCP permission admission. Native Source/Storage authority is independent; project rules can narrow the user policy.' },
    apply: 'immediate',
    helpRef: 'permission rules are validated by the native settings owner; invalid entries are rejected',
    ui: { page: 'harness-permissions', titleKey: 'settings.harness.rules.title',
      keywords: ['allow', 'deny', 'ask', 'regex', 'rules'] },
  },
  {
    id: 'harness.images', category: 'harness', owner: 'agent-settings',
    field: { path: 'harness.images', kind: 'json', scope: 'user', note: '{generation?: {providerId, modelId} | null, editing?: {providerId, modelId} | null}; unconfigured tools are omitted' },
    apply: 'next-run',
    ui: { page: 'images', titleKey: 'settings.harness.images.title', keywords: ['image', 'generate', 'edit', 'model', '图片', '生图'] },
  },
  {
    id: 'harness.models.explore', category: 'retrieval', owner: 'agent-settings',
    fields: [
      { path: 'harness.models.explore', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; set replaces this binding: include retained model fields, or use agents.catalog enable/disable' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-retrieval', titleKey: 'settings.harness.role.explore', keywords: ["explore", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.execution', category: 'agents', owner: 'agent-settings',
    fields: [
      { path: 'harness.models.worker', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; set replaces this binding: include retained model fields, or use agents.catalog enable/disable' },
      { path: 'harness.models.retrievalAgent', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; set replaces this binding: include retained model fields, or use agents.catalog enable/disable' },
    ],
    apply: 'next-run',
    ui: { page: 'agents', titleKey: 'settings.harness.models.execution', keywords: ["worker", "retrievalAgent", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.research', category: 'agents', owner: 'agent-settings',
    fields: [
      { path: 'harness.models.researchPeer', kind: 'json', scope: 'user', note: '{enabled?: boolean, inherit?: boolean, providerId?: string, modelId?: string}; research collaborator configuration' },
    ],
    apply: 'next-run',
    ui: { page: 'agents', titleKey: 'settings.harness.models.research', keywords: ["researchPeer", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.reader', category: 'web', owner: 'agent-settings',
    fields: [
      { path: 'harness.models.reader', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; set replaces this binding: include retained model fields, or use agents.catalog enable/disable' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.harness.role.reader', keywords: ["reader", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.webSelection', category: 'web', owner: 'agent-settings',
    field: { path: 'harness.models.webSelection', kind: 'json', scope: 'user', note: 'Optional ordinary search selector: {enabled?, providerId, modelId, agent?: {modelSettings?: {thinkingLevel?, temperature?}}}; requires web.search.smartSelection.' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.harness.role.webSelection', keywords: ['web', 'search', 'selection', 'model', '搜索', '选择'] },
  },
  {
    id: 'harness.web.assistance', category: 'web', owner: 'agent-settings',
    field: { path: 'harness.web.readingAssistance', kind: 'boolean', scope: 'user', default: false },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.assistance.title', keywords: ['web', 'reading', 'assistance', 'passage', '阅读', '选段'] },
  },
  {
    id: 'knowledge.model', category: 'knowledge', owner: 'agent-settings',
    fields: [
      { path: 'harness.models.memoryOrganizer', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; set replaces this binding: include retained model fields, or use agents.catalog enable/disable' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-bots', titleKey: 'settings.harness.role.memoryOrganizer', keywords: ["memoryOrganizer", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.permissionJudge', category: 'harness', owner: 'agent-settings', writable: false,
    fields: [
      { path: 'harness.models.permissionJudge', kind: 'json', scope: 'user', note: 'Legacy saved permission-judge binding. No running Smart permission consumer currently uses this model.' },
    ],
    apply: 'unsupported',
    helpRef: 'The saved binding is retained for inspection only. Smart permission judgment is not implemented; editing a model would not enable it.',
    ui: { page: 'harness-permissions', titleKey: 'settings.harness.role.permissionJudge', keywords: ["permissionJudge", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.delegationModelSelection', category: 'agents', owner: 'agent-settings',
    field: { path: 'harness.delegationModelSelection', kind: 'json', scope: 'user',
      note: '{enabled: boolean, model?: {providerId, modelId}, thinkingLevel?: ThinkingLevel}. Disabled by default; enabling requires a configured chat or decision model. The selector uses its own model thinking default when omitted. Consumed at the next native free delegation model-preparation boundary, even within the current Run. Does not change the current Run model or an accepted delegation recipe/binding; explicit presets and fixed execution choices are retained.' },
    apply: 'next-request', ui: { page: 'agents', titleKey: 'settings.delegationModelSelection.title',
      descriptionKey: 'settings.delegationModelSelection.description', keywords: ['dispatch', 'delegation', 'selector', 'model', 'thinking', '派发', '模型选择'] },
  },
  {
    id: 'harness.agents', category: 'agents', owner: 'agent-settings',
    field: { path: 'harness.agents', kind: 'json', scope: 'user',
      note: 'ID → {name, description, instructions, enabled, tools?: string[], workFocus: ("code"|"research")[], model?: {providerId,modelId}}. Empty workFocus means both. Native dispatch uses preset:"custom:ID"; models inherit only when omitted. Prefer agents.catalog actions for editing one definition with its catalog revision.' },
    apply: 'next-run', ui: { page: 'agents', titleKey: 'settings.page.agents.title', keywords: ['custom agent', 'team', 'multiagent', 'instructions', 'tools'] },
  },
  {
    id: 'harness.models.agentPlanning', category: 'harness', owner: 'agent-settings',
    field: { path: 'harness.models.agentPlanning', kind: 'json', scope: 'user',
      note: '{enabled?: boolean, providerId?: string, modelId?: string}; explicit model for selected native policy planning, never inherits the main model' },
    apply: 'next-run',
    ui: { page: 'harness-context', titleKey: 'settings.harness.role.agentPlanning',
      keywords: ['planning', 'policy', 'agentPlanning', 'model', 'enable', 'disable'] },
  },
  {
    id: 'harness.models.contextCompaction', category: 'agents', owner: 'agent-settings',
    field: { path: 'harness.models.contextCompaction', kind: 'json', scope: 'user',
      note: '{enabled?: boolean, providerId?: string, modelId?: string, agent?: {name?, description?, instructions?, modelSettings?: {temperature?, thinkingLevel?}}}. Automatic context organization; an omitted model inherits the conversation model. enabled controls automatic preparation; manual compaction uses the same configuration.' },
    apply: 'next-run', ui: { page: 'agents', titleKey: 'settings.harness.role.contextCompaction',
      keywords: ['context', 'compaction', 'summary', 'prompt', '上下文', '压缩', '摘要'] },
  },
  {
    id: 'harness.next-step', category: 'harness', owner: 'agent-settings',
    fields: [
      { path: 'harness.nextStep', kind: 'json', scope: 'user',
        note: '{enabled: boolean}; user-owned and disabled by default' },
      { path: 'harness.models.nextStep', kind: 'json', scope: 'user',
        note: '{enabled?: boolean, providerId?: string, modelId?: string}; dedicated model for next-step suggestions' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-context', titleKey: 'settings.page.harness.nextStep.title',
      keywords: ['next step', 'suggestion', 'follow up', 'model'] },
  },
  {
    id: 'harness.context.messageTime', category: 'harness', owner: 'agent-settings',
    fields: [
      { path: 'harness.context.messageTime.enabled', kind: 'boolean', scope: 'user', default: false },
      { path: 'harness.context.messageTime.timeZone', kind: 'string', scope: 'user', nullable: true, default: null,
        note: 'null follows the sending device; otherwise an IANA time zone, independent of execution Host. Applies to new messages; accepted message times are retained.' },
    ],
    apply: 'immediate',
    ui: { page: 'harness-context', titleKey: 'settings.page.harness.context.messageTime.title',
      keywords: ['time', 'date', 'timezone', 'message', '时间', '日期', '时区'] },
  },
  {
    id: 'harness.context', category: 'harness', owner: 'agent-settings',
    fields: [
      { path: 'harness.context.backgroundPreparation', kind: 'boolean', scope: 'user', default: DEFAULT_HARNESS_SETTINGS.context.backgroundPreparation },
      { path: 'harness.context.preparationWaterline', kind: 'number', scope: 'user', exclusiveMin: 0, exclusiveMax: 1,
        default: DEFAULT_HARNESS_SETTINGS.context.preparationWaterline },
    ],
    apply: 'next-request',
    ui: { page: 'harness-context', titleKey: 'settings.contextScale.title',
      keywords: ['compaction', 'context', 'recovery', 'stalled request', 'retry', 'preparationWaterline', 'reserve', 'replacement', '压缩', '准备', '替换', '预留', '水位'] },
  },
  {
    id: 'harness.context.compactionRecovery', category: 'harness', owner: 'agent-settings', writable: false, apply: 'unsupported',
    fields: [
      { path: 'harness.context.compactionRecovery.enabled', kind: 'boolean', scope: 'user', default: DEFAULT_HARNESS_SETTINGS.context.compactionRecovery.enabled },
      { path: 'harness.context.compactionRecovery.streamIdleMs', kind: 'number', scope: 'user', min: 1, max: 2147483647, integer: true, unit: 'ms', default: DEFAULT_HARNESS_SETTINGS.context.compactionRecovery.streamIdleMs },
      { path: 'harness.context.compactionRecovery.responseWaitMs', kind: 'number', scope: 'user', min: 1, max: 2147483647, integer: true, unit: 'ms', default: DEFAULT_HARNESS_SETTINGS.context.compactionRecovery.responseWaitMs },
      { path: 'harness.context.compactionRecovery.maxRetries', kind: 'number', scope: 'user', min: 0, integer: true, default: DEFAULT_HARNESS_SETTINGS.context.compactionRecovery.maxRetries },
    ],
    helpRef: 'Legacy saved values are preserved for inspection. The current native ContextJob recovery does not consume these preferences; changing them would not affect execution.',
    ui: { page: 'harness-context', titleKey: 'settings.page.harness.context.recovery.title', keywords: ['recovery', 'stall', 'timeout', 'retry', 'unsupported', '恢复', '重试'] },
  },
  {
    id: 'harness.compaction', category: 'harness', owner: 'agent-settings',
    fields: [
      { path: 'compaction.enabled', kind: 'boolean', scope: 'user-or-project', default: true,
        note: 'Automatic compaction also requires harness.models.contextCompaction to be enabled.' },
      { path: 'compaction.reserveRatio', kind: 'number', scope: 'user-or-project', min: 0, exclusiveMax: 1, default: DEFAULT_COMPACTION_RESERVE_RATIO,
        note: 'Fraction of the selected model context reserved for generation/tool progress; model overrides take precedence.' },
      { path: 'compaction.keepRecentTokens', kind: 'number', scope: 'user-or-project', min: 0, integer: true, default: 20000,
        note: 'Recent token budget retained through compaction; model overrides take precedence.' },
      { path: 'compaction.modelOverrides', kind: 'json', scope: 'user-or-project',
        note: 'providerId/modelId → partial {reserveRatio, keepRecentTokens}; global/project entries merge per model.',
        schema: { type: 'object', propertyNames: { minLength: 1 }, additionalProperties: { type: 'object', additionalProperties: false,
          properties: { reserveRatio: { type: 'number', minimum: 0, exclusiveMaximum: 1 }, keepRecentTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } } },
    ],
    apply: 'next-request',
    ui: { page: 'harness-context', titleKey: 'settings.contextScale.title',
      keywords: ['compaction', 'context', 'reserve ratio', 'keep recent tokens', 'model overrides', '压缩', '预留', '保留'] },
  },
  {
    id: 'harness.codeRetrieval', category: 'retrieval', owner: 'agent-settings',
    field: { path: 'harness.codeRetrieval.decision', kind: 'enum', scope: 'user', default: 'auto',
      options: [
        { value: 'auto' }, { value: 'llm' }, { value: 'fast-decision' },
        { value: 'rerank' }, { value: 'source' },
      ], note: 'auto: LLM selects material when enabled, otherwise Fast Decision, then rerank, then source ranking. Fast Decision can choose next actions alongside LLM selection. A query does not run multiple material judges; explicit modes select the engine.' },
    apply: 'immediate',
    ui: { page: 'harness-retrieval', titleKey: 'settings.page.harness.codeRetrieval.title',
      keywords: ['explore', 'LLM', 'fast decision', 'rerank', 'ranking'] },
  },
  {
    id: 'harness.embedding', category: 'retrieval', owner: 'agent-settings',
    field: { path: 'harness.embedding', kind: 'json', scope: 'user',
      note: 'memory and knowledge embeddings: {protocol:"local",providerId:"local",modelId:"installed"} selects the installed component; {protocol:"openai-compatible",providerId,modelId} selects a model service; absent uses text search' },
    apply: 'next-run',
    ui: { page: 'harness-embeddings', titleKey: 'settings.page.harness.section.embedding',
      keywords: ['memory', 'knowledge', 'embedding', 'vector', 'local', 'offline'] },
  },
  {
    id: 'harness.embeddingRequests', category: 'retrieval', owner: 'action',
    actionRef: { domain: 'service:embedding-requests', verbs: ['read', 'write'], note: 'write replaces {concurrentRequests: positive integer, requestIntervalMs: non-negative timer milliseconds, localCpuMode?: auto|efficient|performance, localCpuThreads?: positive integer|null}; supply config and revision from read' },
    apply: 'restart',
    ui: { page: 'harness-embeddings', titleKey: 'settings.page.harness.embeddings.requests.title',
      keywords: ['memory', 'knowledge', 'concurrency', 'interval', 'embedding'] },
  },
  {
    id: 'harness.rerank', category: 'retrieval', owner: 'agent-settings',
    field: { path: 'harness.rerank', kind: 'json', scope: 'user',
      note: 'dedicated rerank backend; user-owned' },
    apply: 'next-run',
    ui: { page: 'harness-retrieval', titleKey: 'settings.page.harness.section.rerank',
      keywords: ['rerank', 'ranking'] },
  },
  {
    id: 'harness.fastDecision', category: 'retrieval', owner: 'agent-settings',
    field: { path: 'harness.fastDecision', kind: 'json', scope: 'user',
      note: 'Fast Decision Model {default?: {protocol:"typed-classifier",providerId,modelId,endpoint?}, purposes?: {explore|web|scholarly?: binding|"off"}} — typed candidate/action judgment, not a chat slot; user-owned; applies to the next query' },
    apply: 'next-run',
    ui: { page: 'harness-retrieval', titleKey: 'settings.page.harness.section.fastDecision',
      keywords: ['fast decision', 'jev', 'typesafe', 'selection'] },
  },
  {
    id: 'harness.web.search', category: 'web', owner: 'agent-settings', authority: 'credentials',
    field: { path: 'harness.web.search', kind: 'json', scope: 'user',
      note: '{connections: [{id,name,provider,enabled,description?,endpoint?,credentialRef?}], defaultConnectionId?, fallbackConnectionIds: string[], enabled?, smartSelection?}. JSON writes replace this entire configuration. Prefer harness.web.search.connections actions to edit one connection, enter credentials privately or test it. Credential references identify Host-owned secrets; reads never return secret material.' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.section.web',
      keywords: ['brave', 'tavily', 'exa', 'jina', 'searxng', 'anysearch', 'API key', 'search'] },
  },
  {
    id: 'harness.web.search.connections', category: 'web', owner: 'action',
    actionRef: { domain: 'service:web-search', verbs: ['list', 'add', 'patch', 'remove', 'route', 'restore-default', 'test', 'credential-status', 'enter-credential', 'remove-credential'],
      note: 'Manage one search connection without replacing unrelated settings. Read list for revision, exact IDs and credential status. enter-credential opens private user input on the authenticated interface for this conversation; it returns a queryable/cancellable operation, never the key. A real test uses only the selected connection.' },
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.section.web', keywords: ['search connection', 'search provider', 'API key', 'brave', 'exa', 'tavily', 'jina', 'searxng', 'anysearch', '搜索连接', '搜索提供商'] },
  },
  {
    id: 'harness.web.render', category: 'web', owner: 'agent-settings',
    field: { path: 'harness.web.render', kind: 'boolean', scope: 'user',
      note: 'browser rendering access for webfetch; user-owned' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.render',
      keywords: ['browser', 'webfetch', 'render'] },
  },
  {
    id: 'harness.document-reading', category: 'web', owner: 'agent-settings',
    fields: [
      { path: 'harness.documentReading.doclingCommand', kind: 'string', scope: 'user', authority: 'permissions', default: DEFAULT_HARNESS_SETTINGS.documentReading.doclingCommand, note: 'Host executable name/path for optional PDF structure parsing.' },
      { path: 'harness.documentReading.tesseractCommand', kind: 'string', scope: 'user', authority: 'permissions', default: DEFAULT_HARNESS_SETTINGS.documentReading.tesseractCommand, note: 'Host executable name/path for optional OCR.' },
      { path: 'harness.documentReading.ocrLanguage', kind: 'string', scope: 'user', default: DEFAULT_HARNESS_SETTINGS.documentReading.ocrLanguage },
    ],
    apply: 'next-run',
    helpRef: 'Optional Host-side PDF structure parsing and OCR executables; base text and page-image reading do not require them.',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.documentReading.title',
      descriptionKey: 'settings.page.harness.web.documentReading.description',
      keywords: ['document reading', 'PDF', 'Docling', 'Tesseract', 'OCR'] },
  },
  {
    id: 'harness.web.sourcePreferences', category: 'web', owner: 'agent-settings',
    field: { path: 'harness.web.sourcePreferences', kind: 'json', scope: 'user-or-project',
      note: '{preferredDomains?: string[], excludedDomains?: string[]} — search defaults, not network permissions; explicit per-request preferences override these defaults' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.webConnections.preferences', keywords: ['sources', 'preferred', 'excluded', '来源', '偏好'] },
  },
  {
    id: 'harness.web.domains', category: 'web', owner: 'agent-settings', authority: 'permissions',
    field: { path: 'harness.web.domains', kind: 'json', scope: 'user-or-project',
      note: '{allow?: string[], block: string[]} — project scope can only narrow the user policy' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.domains.title',
      keywords: ['domain', 'allow', 'block'] },
  },
  {
    id: 'harness.dispatch', category: 'harness', owner: 'agent-settings', writable: false,
    field: { path: 'harness.dispatch', kind: 'json', scope: 'user-or-project',
      note: 'Legacy {concurrency, askBefore} preferences. The current native dispatch owner does not consume these settings.' },
    apply: 'unsupported',
    helpRef: 'Saved values are preserved for inspection; this legacy configuration does not limit native dispatch concurrency or create approval gates.',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.section.tools',
      keywords: ['concurrency', 'dispatch', 'ask before', 'child'] },
  },
  {
    id: 'harness.worktree', category: 'harness', owner: 'agent-settings', writable: false,
    field: { path: 'harness.worktree', kind: 'json', scope: 'user-or-project',
      note: 'Legacy {setup, setupTimeoutMs, copyIgnored, shareDependencies, reclaimIdle, budget} preferences. The current source/materialization owner does not consume them.' },
    apply: 'unsupported',
    helpRef: 'Saved worktree preferences remain inspectable. They do not execute setup commands, copy ignored files, share dependencies or enforce budgets in the current native source pipeline.',
    ui: { page: 'projects', titleKey: 'settings.projects.page.section.worktree',
      keywords: ['worktree', 'setup commands', 'bootstrap'] },
  },
  {
    id: 'harness.knowledge.retention', category: 'harness', owner: 'agent-settings',
    field: { path: 'harness.knowledge', kind: 'json', scope: 'user-or-project',
      note: '{eventRetentionDays: number, autoOrganize: {user, bot}}; automatic memory applies only to Bots' },
    apply: 'next-run',
    ui: { page: 'harness-context', titleKey: 'settings.knowledge.section.workspace',
      keywords: ['knowledge', 'retention', 'suggestions'] },
  },

  // ── Appearance ───────────────────────────────────────────────────────────
  {
    id: 'appearance.language', category: 'appearance', owner: 'client',
    field: { path: 'locale', kind: 'enum',
      options: [
        { value: 'en' }, { value: 'fr' }, { value: 'zh-CN' }, { value: 'zh-TW' },
        { value: 'uk' }, { value: 'es' }, { value: 'pt-BR' }, { value: 'ko' },
        { value: 'pl' }, { value: 'ja' },
      ] },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.appearance.language.label',
      descriptionKey: 'settings.appearance.language.description',
      keywords: ['locale', 'translation', 'ui language'] },
  },
  {
    id: 'appearance.time-format', category: 'appearance', owner: 'app',
    field: { path: 'timeFormatPreference', kind: 'enum',
      options: [{ value: 'auto' }, { value: '12h' }, { value: '24h' }] },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.timeFormat',
      keywords: ['clock', '12h', '24h'] },
  },
  {
    id: 'appearance.week-start', category: 'appearance', owner: 'app',
    field: { path: 'weekStartPreference', kind: 'enum',
      options: [{ value: 'auto' }, { value: 'sunday' }, { value: 'monday' }] },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.weekStartsOn',
      keywords: ['calendar', 'monday', 'sunday'] },
  },
  {
    id: 'appearance.light-theme', category: 'appearance', owner: 'app',
    fields: [
      { path: 'useSystemTheme', kind: 'boolean',
        note: 'follow the OS appearance; light/dark ids pick the variants' },
      { path: 'lightThemeId', kind: 'string', optionsSource: 'themes' },
    ],
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.lightTheme',
      keywords: ['theme', 'color', 'light mode'] },
  },
  {
    id: 'appearance.dark-theme', category: 'appearance', owner: 'app',
    fields: [
      { path: 'themeVariant', kind: 'enum', options: [{ value: 'light' }, { value: 'dark' }] },
      { path: 'darkThemeId', kind: 'string', optionsSource: 'themes' },
    ],
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.darkTheme',
      keywords: ['theme', 'color', 'dark mode'] },
  },
  {
    id: 'appearance.window-transparency', category: 'appearance', owner: 'client',
    field: { path: 'enabled', kind: 'boolean',
      note: 'persisted then applied on the next desktop window creation — the surface relaunches' },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.macVibrancy',
      descriptionKey: 'settings.varin.visual.field.macVibrancyHint',
      keywords: ['transparent', 'transparency', 'vibrancy', 'blur', 'macos', 'opaque'],
      availability: { desktopLocal: true } },
  },
  {
    id: 'appearance.dock-badge', category: 'appearance', owner: 'client',
    field: { path: 'enabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.dockBadge',
      descriptionKey: 'settings.varin.visual.field.dockBadgeHint',
      keywords: ['dock', 'badge', 'unread', 'unseen', 'counter', 'count', 'notification', 'macos'],
      availability: { platform: 'mac' } },
  },
  {
    id: 'appearance.pwa-install-name', category: 'appearance', owner: 'app',
    field: { path: 'pwaAppName', kind: 'string', maxLength: 64 },
    apply: 'manual',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.installAppName',
      descriptionKey: 'settings.varin.visual.field.installAppNameHint',
      keywords: ['pwa', 'installed app'],
      availability: { web: true } },
  },
  {
    id: 'appearance.pwa-orientation', category: 'appearance', owner: 'app',
    field: { path: 'pwaOrientation', kind: 'enum',
      options: [{ value: 'system' }, { value: 'portrait' }, { value: 'landscape' }] },
    apply: 'manual',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.installOrientation',
      descriptionKey: 'settings.varin.visual.field.installOrientationHint',
      keywords: ['pwa', 'portrait', 'landscape'],
      availability: { web: true } },
  },
  {
    id: 'appearance.mobile-keyboard-mode', category: 'appearance', owner: 'app',
    field: { path: 'mobileKeyboardMode', kind: 'enum',
      options: [{ value: 'native' }, { value: 'resize-content' }] },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.mobileKeyboardMode',
      descriptionKey: 'settings.varin.visual.field.mobileKeyboardModeHint',
      keywords: ['mobile', 'keyboard', 'resize'],
      availability: { mobile: true, web: true } },
  },
  {
    id: 'appearance.interface-font-size', category: 'appearance', owner: 'app',
    fields: [
      { path: 'fontSize', kind: 'number', min: 50, max: 200, integer: true, unit: '%' },
      { path: 'uiFont', kind: 'string', nullable: true, note: 'font family override' },
    ],
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.interfaceFontSize',
      keywords: ['font', 'text size', 'ui scale'],
      availability: { mobile: false } },
  },
  {
    id: 'editor.code-font', category: 'editor', owner: 'app',
    field: { path: 'monoFont', kind: 'string', nullable: true, note: 'shared monospace font for code and terminals' },
    apply: 'immediate',
    ui: { page: 'editor', titleKey: 'settings.varin.visual.field.codeFont', keywords: ['code', 'font', 'monospace', 'terminal'] },
  },
  {
    id: 'appearance.terminal-font-size', category: 'appearance', owner: 'app',
    field: { path: 'terminalFontSize', kind: 'number', min: 9, max: 52, integer: true, unit: 'px' },
    apply: 'immediate',
    ui: { page: 'terminal', titleKey: 'settings.varin.visual.field.terminalFontSize',
      keywords: ['terminal', 'font', 'text size'] },
  },
  {
    id: 'appearance.terminal-shell', category: 'terminal', owner: 'app',
    fields: [
      { path: 'terminalShell', kind: 'enum',
        options: [
          { value: 'auto' }, { value: 'bash' }, { value: 'zsh' }, { value: 'sh' },
          { value: 'fish' }, { value: 'pwsh' }, { value: 'powershell' }, { value: 'cmd' },
          { value: 'dash' }, { value: 'ksh' }, { value: 'nu' },
        ] },
      { path: 'terminalLoginShells', kind: 'string-list',
        note: 'shells that run as login shells' },
    ],
    apply: 'immediate',
    ui: { page: 'terminal', titleKey: 'settings.varin.visual.field.terminalShell',
      descriptionKey: 'settings.varin.visual.field.terminalShellHint',
      keywords: ['terminal', 'shell', 'bash', 'zsh', 'fish', 'pwsh', 'powershell'] },
  },
  {
    id: 'appearance.editor-font-size', category: 'editor', owner: 'app',
    field: { path: 'editorFontSize', kind: 'number', min: 8, max: 32, unit: 'px' },
    apply: 'immediate',
    ui: { page: 'editor', titleKey: 'settings.varin.visual.field.editorFontSize',
      keywords: ['editor', 'font', 'text size', 'code'] },
  },
  {
    id: 'appearance.spacing-density', category: 'appearance', owner: 'app',
    fields: [
      { path: 'padding', kind: 'number', min: 50, max: 200, integer: true, unit: '%' },
      { path: 'cornerRadius', kind: 'number', min: 0, max: 32, integer: true, unit: 'px' },
    ],
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.spacingDensity',
      keywords: ['density', 'compact', 'comfortable', 'spacing'] },
  },
  {
    id: 'appearance.motion', category: 'appearance', owner: 'app',
    field: { path: 'motionPreference', kind: 'enum',
      options: [{ value: 'full' }, { value: 'reduced' }, { value: 'off' }],
      note: 'the operating system reduced-motion setting lowers full to reduced' },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.section.motion',
      descriptionKey: 'settings.varin.visual.section.motionDescription',
      keywords: ['motion', 'animation', 'reduced motion', 'transition', '动效', '动画'] },
  },
  {
    id: 'appearance.input-bar-offset', category: 'appearance', owner: 'app',
    field: { path: 'inputBarOffset', kind: 'number', min: 0, max: 100, integer: true, unit: 'px' },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.inputBarOffset',
      descriptionKey: 'settings.varin.visual.field.inputBarOffsetTooltip',
      keywords: ['input', 'home bar', 'offset'],
      availability: { mobile: true } },
  },
  {
    id: 'appearance.auto-save-enabled', category: 'editor', owner: 'app',
    field: { path: 'autoSaveEnabled', kind: 'boolean', default: true },
    apply: 'immediate',
    ui: { page: 'editor', titleKey: 'settings.varin.visual.field.autoSaveEnabled',
      descriptionKey: 'settings.varin.visual.field.autoSaveEnabledInfo',
      keywords: ['editor', 'autosave', 'auto-save', 'files', 'save'] },
  },
  {
    id: 'appearance.expanded-editor-toolbar', category: 'editor', owner: 'app',
    field: { path: 'expandedEditorToolbar', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'editor', titleKey: 'settings.varin.visual.field.expandedEditorToolbar',
      keywords: ['editor', 'toolbar', 'tabs', 'docked', 'files'] },
  },
  {
    id: 'appearance.file-editor-keymap', category: 'editor', owner: 'client',
    field: { path: 'keymap', kind: 'enum', options: [{ value: 'default' }, { value: 'vim' }] },
    apply: 'immediate',
    ui: { page: 'editor', titleKey: 'settings.varin.visual.field.fileEditorKeymap',
      keywords: ['editor', 'vim', 'keymap'] },
  },
  {
    id: 'appearance.file-editor', category: 'editor', owner: 'app',
    field: { path: 'fileEditorSettings', kind: 'json',
      note: 'editor options object (minimap, wrap, whitespace, indentation, format)' },
    apply: 'immediate',
    ui: { page: 'editor', titleKey: 'settings.varin.editor.section.title',
      descriptionKey: 'settings.varin.editor.section.description',
      keywords: ['editor', 'minimap', 'wrap', 'whitespace', 'indentation', 'format'] },
  },
  {
    id: 'appearance.terminal-quick-keys', category: 'terminal', owner: 'client',
    field: { path: 'enabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'terminal', titleKey: 'settings.varin.visual.field.terminalQuickKeys',
      descriptionKey: 'settings.varin.visual.field.terminalQuickKeysTooltip',
      keywords: ['terminal', 'keyboard', 'esc', 'ctrl', 'arrows'],
      availability: { mobile: false } },
  },

  // ── Chat ─────────────────────────────────────────────────────────────────
  {
    id: 'chat.render-mode', category: 'chat', owner: 'app',
    field: { path: 'chatRenderMode', kind: 'enum',
      options: [{ value: 'sorted' }, { value: 'live' }, { value: 'dialogue' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.replyLayout',
      keywords: ['messages', 'conversation', 'rendering', 'dialogue', 'collapsed', '对话优先'] },
  },
  {
    id: 'chat.message-transport', category: 'chat', owner: 'app',
    field: { path: 'messageStreamTransport', kind: 'enum',
      options: [{ value: 'auto' }, { value: 'ws' }, { value: 'sse' }] },
    apply: 'restart',
    ui: { page: 'general', titleKey: 'settings.varin.visual.section.messageStreamTransport',
      keywords: ['streaming', 'sse', 'websocket'] },
  },
  {
    id: 'chat.session-goal', category: 'chat', owner: 'app',
    field: { path: 'sessionGoalEnabled', kind: 'boolean' },
    apply: 'next-run',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.field.sessionGoal',
      keywords: ['goal', 'objective', 'auto continue', 'small model'] },
  },
  {
    id: 'chat.session-goal-budget', category: 'chat', owner: 'app',
    fields: [
      { path: 'sessionGoalDefaultBudgetEnabled', kind: 'boolean' },
      { path: 'sessionGoalDefaultBudget', kind: 'number', min: 1, integer: true, unit: 'tokens' },
    ],
    apply: 'next-run',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.goal.budgetLabel',
      keywords: ['goal', 'budget', 'tokens', 'limit'] },
  },
  {
    id: 'chat.reasoning-traces', category: 'chat', owner: 'app',
    field: { path: 'showReasoningTraces', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.thinking',
      keywords: ['thinking', 'reasoning'] },
  },
  {
    id: 'chat.reasoning', category: 'chat', owner: 'app',
    field: { path: 'collapsibleThinkingBlocks', kind: 'boolean',
      note: 'true starts thinking in a one-line preview; false automatically expands its reading window. Manual expansion and collapse remain available.' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.section.reasoning',
      keywords: ['thinking', 'traces', 'expand', 'collapse'] },
  },
  {
    id: 'chat.sticky-user-header', category: 'chat', owner: 'app',
    field: { path: 'stickyUserHeader', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.stickyUser',
      keywords: ['messages', 'header'] },
  },
  {
    id: 'chat.prompt-navigator', category: 'chat', owner: 'app',
    field: { path: 'promptNavigatorEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.navigator',
      keywords: ['prompt', 'navigator', 'navigation', 'timeline', 'scroll'] },
  },
  {
    id: 'chat.collapsible-user-messages', category: 'chat', owner: 'app',
    field: { path: 'collapsibleUserMessages', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.collapseUser',
      keywords: ['collapse', 'expand', 'clamp', 'long messages', 'user messages'] },
  },
  {
    id: 'chat.content-width', category: 'chat', owner: 'app',
    field: { path: 'chatContentWidth', kind: 'number', min: 0, integer: true, default: 960, unit: 'px',
      note: 'Maximum message and composer width; 0 fills the available pane.' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.width.title',
      keywords: ['layout', 'wide', 'width', 'messages', '宽度', '宽聊天布局'] },
  },
  {
    id: 'chat.message-appearance', category: 'chat', owner: 'app',
    field: { path: 'userMessageRenderingMode', kind: 'enum',
      options: [{ value: 'markdown' }, { value: 'plain' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.reading',
      keywords: ['layout', 'messages', 'appearance'] },
  },
  {
    id: 'chat.activity-display', category: 'chat', owner: 'app',
    field: { path: 'activityRenderMode', kind: 'enum', options: [{ value: 'collapsed' }, { value: 'summary' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.activity', keywords: ['activity', 'process', 'collapse', 'expand'] },
  },
  {
    id: 'chat.diagram-format', category: 'chat', owner: 'app',
    field: { path: 'mermaidRenderingMode', kind: 'enum', options: [{ value: 'svg' }, { value: 'ascii' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.diagrams', keywords: ['diagram', 'mermaid', 'svg', 'ascii'] },
  },
  {
    id: 'chat.code-block-line-wrap', category: 'chat', owner: 'app',
    field: { path: 'codeBlockLineWrap', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.wrapCode',
      keywords: ['code', 'wrap', 'line wrap', 'markdown'] },
  },
  {
    id: 'chat.draft-starters-visible', category: 'chat', owner: 'app',
    field: { path: 'draftStartersVisible', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.starters',
      keywords: ['starter', 'starters', 'new session', 'welcome', 'suggestions'] },
  },
  {
    id: 'chat.tool-file-icons', category: 'chat', owner: 'app',
    field: { path: 'showToolFileIcons', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.fileIcons',
      keywords: ['tools', 'files', 'icons'] },
  },
  {
    id: 'chat.tools-and-files', category: 'chat', owner: 'app',
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.files',
      keywords: ['tools', 'files', 'dotfiles'] },
  },
  {
    id: 'chat.expanded-tools', category: 'chat', owner: 'app',
    fields: [
      { path: 'showExpandedBashTools', kind: 'boolean', default: false },
      { path: 'showExpandedEditTools', kind: 'boolean', default: false },
    ],
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.section.showToolsOpenedByDefault',
      keywords: ['tools', 'bash', 'edit', 'expanded', 'open by default'] },
  },
  {
    id: 'chat.changed-files', category: 'chat', owner: 'app',
    field: { path: 'showTurnChangedFiles', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.changedFiles',
      keywords: ['changed files', 'turns'] },
  },
  {
    id: 'chat.server-permission-auto-accept', category: 'chat', owner: 'app', writable: false,
    field: { path: 'serverPermissionAutoAcceptEnabled', kind: 'boolean', note: 'Legacy saved preference only. No current execution owner consumes this flag; it cannot approve tool operations.' },
    apply: 'unsupported',
    helpRef: 'This preexisting compatibility field has no operating approval feature. Saved values are retained but not writable through the catalog.',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.field.serverPermissionAutoAccept',
      descriptionKey: 'settings.varin.visual.field.serverPermissionAutoAcceptTooltip',
      keywords: ['permission', 'permissions', 'auto accept', 'approve', 'unattended', 'backend'] },
  },
  {
    id: 'chat.dotfiles', category: 'chat', owner: 'app',
    field: { path: 'directoryShowHidden', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.field.showDotfiles',
      keywords: ['hidden files'] },
  },
  {
    id: 'chat.file-viewer-preview', category: 'chat', owner: 'app',
    field: { path: 'defaultFileViewerPreview', kind: 'boolean', default: false },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.defaults.field.openFilesPreview',
      keywords: ['files', 'viewer', 'preview', 'open'] },
  },
  {
    id: 'chat.follow-up-behavior', category: 'chat', owner: 'app',
    field: { path: 'followUpBehavior', kind: 'enum',
      options: [{ value: 'steer' }, { value: 'queue' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.section.followUpBehavior',
      descriptionKey: 'settings.varin.visual.field.followUpBehaviorDescription',
      keywords: ['follow up', 'queue', 'steer', 'send immediately'] },
  },
  {
    id: 'chat.bot-task-inactivity', category: 'chat', owner: 'app',
    field: { path: 'botTaskInactivityMinutes', kind: 'number', min: 0, integer: true, default: 20, unit: 'min' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.botInactivity', descriptionKey: 'settings.chat.botInactivityHint', keywords: ['bot', 'task', 'inactivity', 'watchdog'] },
  },
  {
    id: 'chat.bot-follow-up-behavior', category: 'chat', owner: 'app',
    field: { path: 'botFollowUpBehavior', kind: 'enum', options: [{ value: 'steer' }, { value: 'queue' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.section.botFollowUpBehavior',
      descriptionKey: 'settings.varin.visual.field.botFollowUpBehaviorDescription',
      keywords: ['bot', 'Varin', 'follow up', 'queue', 'steer'] },
  },
  {
    id: 'chat.persist-drafts', category: 'chat', owner: 'client',
    field: { path: 'enabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.field.persistDraftMessages',
      keywords: ['draft', 'message'] },
  },
  {
    id: 'chat.composer', category: 'chat', owner: 'app',
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.input',
      keywords: ['input', 'draft', 'spellcheck'] },
  },
  {
    id: 'chat.spellcheck', category: 'chat', owner: 'app',
    field: { path: 'inputSpellcheckEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.field.enableSpellcheckInTextInputs',
      keywords: ['spelling', 'input'],
      availability: { mobile: false } },
  },

  // ── Sessions ─────────────────────────────────────────────────────────────
  {
    id: 'sessions.default-model', category: 'model', owner: 'agent-settings',
    fields: [
      modelField('defaultModel', 'user-or-project'),
      { path: 'defaultProvider', kind: 'string', scope: 'user-or-project',
        note: 'provider id paired with defaultModel' },
    ],
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.field.defaultModel',
      keywords: ['model', 'provider', 'new sessions'] },
  },
  {
    id: 'sessions.default-thinking', category: 'model', owner: 'agent-settings',
    field: { path: 'defaultThinkingLevel', kind: 'string', scope: 'user-or-project',
      optionsSource: 'thinking-levels' },
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.field.defaultThinking',
      keywords: ['thinking', 'reasoning', 'variant'] },
  },
  {
    id: 'sessions.default-agent', category: 'model', owner: 'agent-settings',
    field: { path: 'defaultAgent', kind: 'string', scope: 'user-or-project' },
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.field.defaultModel',
      keywords: ['agent', 'default agent', 'new sessions'] },
  },
  {
    id: 'sessions.deletion-dialog', category: 'sessions', owner: 'app',
    field: { path: 'showDeletionDialog', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.field.showDeletionDialog',
      keywords: ['delete', 'confirmation'] },
  },
  {
    id: 'sessions.retry', category: 'model', owner: 'agent-settings',
    field: { path: 'retry', kind: 'json', scope: 'user', note: 'Automatic model request retries: enabled, maxRetries, initialDelayMs, maxDelayMs, ordered matching rules' },
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.retry.title', descriptionKey: 'settings.retry.description', keywords: ['retry', '重试', 'backoff', 'network'] },
  },
  {
    id: 'sessions.small-model', category: 'model', owner: 'agent-settings',
    fields: [
      { path: 'utilityModel', kind: 'json', scope: 'user', note: '{providerId,modelId}; reset inherits the native default model' },
      { path: 'utilityThinkingLevel', kind: 'string', scope: 'user',
        note: 'Independent auxiliary-model thinking level; reset uses the selected model default, or defaultThinkingLevel when inheriting the global default model' },
    ],
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'thread.settings.utilityModel',
      descriptionKey: 'settings.varin.defaults.utilityModel.description',
      keywords: ['auxiliary', 'utility', 'title', 'commit', 'pull request'] },
  },
  {
    id: 'sessions.title-updates', category: 'sessions', owner: 'agent-settings',
    field: { path: 'titleUpdateInterval', kind: 'number', scope: 'user', min: 0, integer: true, default: 5,
      note: 'Completed user/Agent exchanges between automatic title checks; zero keeps initial naming only. Context always uses the recent three complete exchanges.' },
    apply: 'immediate',
    ui: { page: 'sessions', titleKey: 'settings.titleUpdates.label', descriptionKey: 'settings.titleUpdates.description', keywords: ['title', 'rename', '标题', '命名', 'frequency'] },
  },
  {
    id: 'sessions.auto-cleanup', category: 'sessions', owner: 'app',
    field: { path: 'autoDeleteEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'history', titleKey: 'settings.varin.sessionRetention.field.enableAutoCleanup',
      descriptionKey: 'settings.varin.sessionRetention.tooltip',
      keywords: ['retention', 'archive', 'delete'] },
  },
  {
    id: 'sessions.retention-period', category: 'sessions', owner: 'app',
    field: { path: 'autoDeleteAfterDays', kind: 'number', min: 1, integer: true, unit: 'days' },
    apply: 'immediate',
    ui: { page: 'history', titleKey: 'settings.varin.sessionRetention.field.retentionPeriod',
      keywords: ['days', 'cleanup', 'retention'] },
  },
  {
    id: 'sessions.retention-action', category: 'sessions', owner: 'app',
    field: { path: 'sessionRetentionAction', kind: 'enum',
      options: [{ value: 'archive' }, { value: 'delete' }] },
    apply: 'immediate',
    ui: { page: 'history', titleKey: 'settings.varin.sessionRetention.field.whenSessionsExpire',
      keywords: ['archive', 'delete', 'expire'] },
  },
  {
    id: 'sessions.recovery', category: 'sessions', owner: 'app',
    fields: [
      { path: 'recoveryPreference', kind: 'string',
        note: 'RecoveryPreference value for crashed/interrupted sessions' },
      { path: 'checkpointRetentionLimit', kind: 'number', min: 0, integer: true },
    ],
    apply: 'immediate',
    ui: { page: 'history', titleKey: 'settings.varin.sessionRetention.field.enableAutoCleanup',
      keywords: ['recovery', 'checkpoint', 'restore', 'crash'] },
  },
  {
    id: 'sessions.message-limit', category: 'sessions', owner: 'app',
    field: { path: 'messageLimit', kind: 'number', min: 20, integer: true, default: 200,
      note: 'history fetch/trim/Load More chunk size' },
    apply: 'immediate',
    ui: { page: 'history', titleKey: 'settings.varin.defaults.field.showDeletionDialog',
      keywords: ['history', 'messages', 'limit', 'load more'] },
  },
  {
    id: 'sessions.desktop-launch-at-login', category: 'sessions', owner: 'client',
    field: { path: 'enabled', kind: 'boolean' },
    apply: 'manual',
    ui: { page: 'general', titleKey: 'settings.varin.desktopNetwork.field.launchAtLogin',
      descriptionKey: 'settings.varin.desktopNetwork.field.launchAtLoginDescription',
      keywords: ['desktop', 'startup', 'login', 'launch', 'background', 'autostart'],
      availability: { desktopLocal: true } },
  },
  {
    id: 'sessions.desktop-window-controls-position', category: 'appearance', owner: 'app',
    field: { path: 'desktopWindowControlsPosition', kind: 'enum',
      options: [{ value: 'left' }, { value: 'right' }] },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.desktopNetwork.field.windowControlsPosition',
      descriptionKey: 'settings.varin.desktopNetwork.field.windowControlsPositionDescription',
      keywords: ['desktop', 'window', 'controls', 'minimize', 'maximize', 'close', 'titlebar', 'linux', 'windows'],
      availability: { desktop: true, platform: 'not-mac' } },
  },
  {
    id: 'sessions.desktop-window-controls-style', category: 'appearance', owner: 'app',
    field: { path: 'desktopWindowControlsStyle', kind: 'enum',
      options: [{ value: 'classic' }, { value: 'traffic-lights' }] },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.desktopNetwork.field.windowControlsStyle',
      keywords: ['desktop', 'window', 'controls', 'style', 'traffic', 'lights', 'classic', 'macos', 'titlebar'],
      availability: { desktop: true, platform: 'not-mac' } },
  },
  {
    id: 'sessions.desktop-mac-menu-bar', category: 'sessions', owner: 'app',
    field: { path: 'desktopMacMenuBarEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.desktopNetwork.field.macMenuBar',
      descriptionKey: 'settings.varin.desktopNetwork.field.macMenuBarDescription',
      keywords: ['desktop', 'menu bar', 'tray', 'status item', 'macos', 'background'],
      availability: { desktopLocal: true, platform: 'mac' } },
  },
  {
    id: 'sessions.desktop-minimize-to-tray', category: 'sessions', owner: 'app',
    field: { path: 'desktopMinimizeToTrayEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.desktopNetwork.field.minimizeToTray',
      descriptionKey: 'settings.varin.desktopNetwork.field.minimizeToTrayDescription',
      keywords: ['desktop', 'tray', 'system tray', 'minimize', 'close', 'background', 'windows', 'linux'],
      availability: { desktopLocal: true, platform: 'not-mac' } },
  },
  {
    id: 'sessions.desktop-companion', category: 'appearance', owner: 'app',
    field: { path: 'desktopCompanionEnabled', kind: 'boolean' }, apply: 'immediate',
    ui: { page: 'companion', titleKey: 'companion.library.wake',
      descriptionKey: 'companion.library.description',
      keywords: ['desktop', 'companion', 'pet', 'animation', 'download', 'wake', 'sleep', '桌宠', '唤醒', '下载'], availability: { desktopLocal: true } },
  },
  {
    id: 'sessions.desktop-keep-awake', category: 'sessions', owner: 'app',
    field: { path: 'desktopKeepAwakeEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.desktopNetwork.field.keepAwake',
      descriptionKey: 'settings.varin.desktopNetwork.field.keepAwakeDescription',
      keywords: ['desktop', 'sleep', 'awake', 'server', 'mobile', 'phone'],
      availability: { desktopLocal: true } },
  },
  {
    id: 'sessions.desktop-ui-password', category: 'sessions', owner: 'app',
    field: { path: 'desktopUiPassword', kind: 'secret' },
    apply: 'restart',
    ui: { page: 'access', titleKey: 'settings.varin.desktopPassword.field.password',
      descriptionKey: 'settings.varin.desktopPassword.field.passwordDescription',
      keywords: ['desktop', 'password', 'auth', 'login'],
      availability: { desktopLocal: true } },
  },
  {
    id: 'sessions.desktop-lan-access', category: 'sessions', owner: 'app', authority: 'permissions',
    field: { path: 'desktopLanAccessEnabled', kind: 'boolean' },
    apply: 'restart',
    ui: { page: 'access', titleKey: 'settings.varin.desktopNetwork.field.allowLanAccess',
      descriptionKey: 'settings.varin.desktopNetwork.field.allowLanAccessDescription',
      keywords: ['desktop', 'lan', 'network', 'phone', 'tablet'],
      availability: { desktopLocal: true } },
  },

  // ── Notifications ────────────────────────────────────────────────────────
  {
    id: 'notifications.delivery', category: 'notifications', owner: 'app',
    fields: [
      { path: 'nativeNotificationsEnabled', kind: 'boolean' },
      { path: 'notificationMode', kind: 'enum',
        options: [{ value: 'always' }, { value: 'hidden-only' }] },
    ],
    apply: 'immediate',
    ui: { page: 'notifications', titleKey: 'settings.notifications.page.delivery.title',
      keywords: ['desktop notifications', 'system notifications'] },
  },
  {
    id: 'notifications.events', category: 'notifications', owner: 'app',
    fields: [
      { path: 'notifyOnCompletion', kind: 'boolean' },
      { path: 'notifyOnError', kind: 'boolean' },
      { path: 'notifyOnQuestion', kind: 'boolean' },
      { path: 'notifyOnSubtasks', kind: 'boolean' },
    ],
    apply: 'immediate',
    ui: { page: 'notifications', titleKey: 'settings.notifications.page.events.title',
      keywords: ['completion', 'subtasks', 'errors', 'questions'] },
  },
  {
    id: 'notifications.templates', category: 'notifications', owner: 'app',
    field: { path: 'notificationTemplates', kind: 'json',
      note: 'per-event {completion,error,question,subtask} → {title,message} templates' },
    apply: 'immediate',
    ui: { page: 'notifications', titleKey: 'settings.notifications.page.events.title',
      keywords: ['notification', 'template', 'message'] },
  },
  {
    id: 'notifications.push', category: 'notifications', owner: 'action',
    actionRef: { domain: 'service:notifications',
      note: 'web push subscription is per-device and browser-granted; agent cannot subscribe another device' },
    apply: 'manual',
    ui: { page: 'notifications', titleKey: 'settings.notifications.page.push.title',
      keywords: ['background', 'push'],
      availability: { web: true } },
  },

  // ── Git ──────────────────────────────────────────────────────────────────
  {
    id: 'git.github-account', category: 'git', owner: 'action',
    actionRef: { domain: 'service:git', verbs: ['status'],
      note: 'GitHub OAuth connect is an interactive flow; agents can only report status' },
    ui: { page: 'git', titleKey: 'settings.github.page.actions.connect',
      keywords: ['github', 'account', 'oauth', 'prs', 'issues'] },
  },
  {
    id: 'git.identities', category: 'git', owner: 'action',
    actionRef: { domain: 'service:git', verbs: ['list', 'create', 'update', 'delete'],
      note: 'git identity profiles (author/email/signing) via the git identity service' },
    ui: { page: 'git', titleKey: 'settings.gitIdentities.page.section.title',
      descriptionKey: 'settings.gitIdentities.page.empty.description',
      keywords: ['identity', 'profile', 'author', 'email', 'credentials', 'signing', 'commit signing', 'ssh signing', 'gpg'] },
  },
  {
    id: 'git.default-identity', category: 'git', owner: 'app',
    field: { path: 'defaultGitIdentityId', kind: 'string', optionsSource: 'git-identities',
      note: '"global" or a profile id; empty/unset = per-repo default' },
    apply: 'immediate',
    ui: { page: 'git', titleKey: 'settings.gitIdentities.page.section.title',
      keywords: ['identity', 'default', 'author'] },
  },
  {
    id: 'git.changes-view', category: 'git', owner: 'app',
    field: { path: 'gitChangesViewMode', kind: 'enum',
      options: [{ value: 'flat' }, { value: 'tree' }] },
    apply: 'immediate',
    ui: { page: 'git', titleKey: 'settings.varin.git.changesViewTitle',
      keywords: ['changes', 'flat list', 'tree view'] },
  },
  {
    id: 'git.gitmoji', category: 'git', owner: 'app',
    field: { path: 'gitmojiEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'git', titleKey: 'settings.varin.git.enableGitmoji',
      keywords: ['commit', 'emoji'] },
  },
  {
    id: 'git.gitignored-files', category: 'git', owner: 'app',
    field: { path: 'filesViewShowGitignored', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'git', titleKey: 'settings.varin.git.showGitignored',
      keywords: ['ignored', 'files', 'gitignore'] },
  },

  // ── Projects ─────────────────────────────────────────────────────────────
  {
    id: 'projects.trust', category: 'projects', owner: 'action', apply: 'manual',
    actionRef: { domain: 'page:ui', note: 'User-confirmed trust for canonical project folders. The settings catalog cannot grant trust.' },
    ui: { page: 'projects', titleKey: 'settings.projectTrust.title', descriptionKey: 'settings.projectTrust.description',
      keywords: ['trust', 'trusted', 'untrusted', 'workspace', '信任', '撤销信任'] },
  },
  {
    id: 'projects.name', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: ['rename'],
      note: 'project metadata lives inside the projects[] entries of the app document; edits need a target project id' },
    ui: { page: 'projects', titleKey: 'settings.projects.page.field.projectName',
      keywords: ['label', 'display name', 'project metadata'] },
  },
  {
    id: 'projects.default-model', category: 'projects', owner: 'agent-settings', scope: 'project',
    fields: [
      { path: 'defaultProvider', kind: 'string', scope: 'user-or-project', note: 'Provider paired with defaultModel in the admitted project’s native settings.' },
      modelField('defaultModel', 'user-or-project'),
      { path: 'defaultThinkingLevel', kind: 'string', scope: 'user-or-project', optionsSource: 'thinking-levels',
        note: 'Reset when changing models unless the new model supports the same thinking level.' },
    ],
    apply: 'next-run',
    ui: { page: 'projects', titleKey: 'settings.projects.page.field.defaultModel',
      descriptionKey: 'settings.projects.page.field.defaultModelDescription',
      keywords: ['model', 'new chat', 'project default'] },
  },
  {
    id: 'projects.default-work-focus', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: ['set-default-work-focus'],
      note: 'per-project code|research work focus' },
    ui: { page: 'projects', titleKey: 'workFocus.projectDefault',
      descriptionKey: 'workFocus.projectDefaultDescription',
      keywords: ['research', 'science', 'coding', 'focus', 'new conversation', '科研', '工作侧重'] },
  },
  {
    id: 'projects.accent-color', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: ['set-color'] },
    ui: { page: 'projects', titleKey: 'settings.projects.page.field.accentColor',
      keywords: ['color', 'appearance', 'project metadata'] },
  },
  {
    id: 'projects.icon', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: ['set-icon'] },
    ui: { page: 'projects', titleKey: 'settings.projects.page.field.projectIcon',
      keywords: ['icon', 'favicon', 'upload', 'project metadata'] },
  },
  {
    id: 'projects.worktree', category: 'projects', owner: 'app', writable: false,
    field: { path: 'autoCreateWorktree', kind: 'boolean',
      note: 'Legacy stored preference only. No current session-creation owner consumes this flag; it does not create worktrees.' },
    apply: 'unsupported',
    ui: { page: 'projects', titleKey: 'settings.projects.page.section.worktree',
      keywords: ['worktree', 'branch', 'repository'] },
  },
  {
    id: 'projects.worktree.setup.wait', category: 'projects', owner: 'agent-settings', writable: false,
    field: { path: 'harness.worktree.setupTimeoutMs', kind: 'number', scope: 'user-or-project',
      min: 0, integer: true, unit: 'ms',
      note: 'Legacy saved setup wait time. The current native source pipeline does not run setup commands from this preference.' },
    apply: 'unsupported',
    ui: { page: 'projects', titleKey: 'settings.varin.worktrees.setup.waitForCommands',
      keywords: ['worktree', 'setup commands', 'bootstrap', 'wait'] },
  },
  {
    id: 'projects.actions', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: [],
      note: 'per-project automation (open url, ssh forward)' },
    ui: { page: 'projects', titleKey: 'settings.projects.actions.title',
      descriptionKey: 'settings.projects.actions.description',
      keywords: ['command', 'automation', 'open url', 'ssh forward'] },
  },

  // ── Remote instances ─────────────────────────────────────────────────────
  {
    id: 'remote-instances.client-auth', category: 'remote', owner: 'action',
    actionRef: { domain: 'service:remote-instances', verbs: ['status'],
      note: 'pairing links and client tokens are issued interactively; agents get status only' },
    ui: { page: 'access', titleKey: 'settings.remoteInstances.clientAuth.title',
      descriptionKey: 'settings.remoteInstances.clientAuth.description',
      keywords: ['pairing link', 'client token', 'connect desktop', 'remote access', 'relay', 'devices', 'connect from anywhere'] },
  },
  {
    id: 'remote-instances.direct-hosts', category: 'remote', owner: 'client',
    field: { path: 'defaultHostId', kind: 'string', nullable: true,
      note: 'hosts themselves are added by pairing; the writable field is the default selection' },
    apply: 'immediate',
    ui: { page: 'remote-instances', titleKey: 'settings.remoteInstances.direct.title',
      descriptionKey: 'settings.remoteInstances.direct.description',
      keywords: ['server url', 'connection token', 'import link', 'host switcher', 'additional headers', 'request headers', 'cloudflare access', 'service token'],
      availability: { desktop: true } },
  },

  {
    id: 'extensions.packages', category: 'extensions', owner: 'action',
    actionRef: { domain: 'service:extension-packages', verbs: ['list', 'remove'],
      note: 'Native extension package catalog. Stage/apply use the extension_package tool with the Run’s admitted source; removal requires id and expectedRevision and preserves data.' },
    ui: { page: 'extensions', titleKey: 'settings.varin.extensions.workbench.title', keywords: ['package', 'install', 'extension', 'source'] },
  },

  // ── Agents ──────────────────────────────────────────────────────────────
  {
    id: 'self.bot-profile', category: 'agents', owner: 'action', apply: 'next-request',
    actionRef: { domain: 'service:self-bot', verbs: ['read', 'update'],
      note: 'The Bot bound to the admitted calling Thread, never a caller-supplied Bot id. Update name, instructions or preferred model with expectedRevision. Profile changes affect this Bot’s direct conversations at safe request boundaries; delegated Agent work keeps its own model.' },
    ui: { page: 'harness-bots', titleKey: 'settings.varin.agents.catalog.title',
      keywords: ['self', 'bot', 'my name', 'instructions', 'persona', 'preferred model', '自己', '人格'] },
  },
  {
    id: 'self.conversation-model', category: 'agents', owner: 'action', apply: 'next-request',
    actionRef: { domain: 'service:self-conversation', verbs: ['read', 'select-model'],
      note: 'Inspect active/desired model selection and select the admitted current Run’s model, thinking level or temperature. This does not edit Bot profile or future-session defaults; accepted requests keep their immutable original selection.' },
    ui: { page: 'agents', titleKey: 'settings.varin.agents.catalog.title',
      keywords: ['self', 'current conversation', 'current run', 'model', 'thinking', 'temperature', '当前会话', '思考'] },
  },
  {
    id: 'agents.catalog', category: 'agents', owner: 'action',
    actionRef: { domain: 'service:agents', verbs: ['list', 'read', 'create', 'update', 'enable', 'disable', 'delete'],
      note: 'Native Agent profiles. Save requires expectedRevision and config from the profile snapshot; custom creation also requires explicit tools. Use returned profile identities for dispatch.' },
    ui: { page: 'agents', titleKey: 'settings.varin.agents.catalog.title',
      descriptionKey: 'settings.varin.agents.description',
      keywords: ['agent', 'subagent', 'workflow', 'role', 'model', 'fallback', 'thinking'] },
  },
  {
    id: 'mcp.runtime', category: 'agents', owner: 'action',
    actionRef: { domain: 'runtime:mcp', verbs: ['status', 'reconnect', 'connect', 'disconnect', 'login', 'reply', 'cancel'],
      note: 'MCP server runtime status; reconnect/oauth are runtime actions' },
    ui: { page: 'mcp', titleKey: 'settings.varin.mcp.runtime.title',
      keywords: ['server', 'status', 'reconnect', 'oauth', 'tools', 'resources'] },
  },
  {
    id: 'mcp.configuration', category: 'agents', owner: 'action',
    actionRef: { domain: 'runtime:mcp', verbs: ['read', 'write', 'patch'],
      note: 'MCP definitions belong to the native MCP settings owner; write requires a source path from read and its expectedRevision' },
    ui: { page: 'mcp', titleKey: 'settings.varin.mcp.config.title',
      keywords: ['json', 'jsonc', 'config', 'stdio', 'url', 'environment', 'headers', 'timeout'] },
  },
  {
    id: 'extensions.workbench', category: 'extensions', owner: 'action',
    actionRef: { domain: 'service:extensions', verbs: ['list'],
      note: 'workbench profile/shell state lives in the host workbench document, resolved per surface' },
    ui: { page: 'extensions', titleKey: 'settings.varin.extensions.workbench.title',
      keywords: ['profile', 'shell', 'layout', 'workbench', 'ide'] },
  },
  {
    id: 'extensions.workbench.profile', category: 'extensions', owner: 'action',
    actionRef: { domain: 'service:extensions', verbs: ['select'],
      note: 'profile selection persists in the host workbench document (user scope) — select applies after the shell proves ready' },
    apply: 'immediate',
    ui: { page: 'extensions', titleKey: 'settings.varin.extensions.workbench.profile',
      keywords: ['profile', 'agent', 'ide', 'layout'] },
  },
  {
    id: 'extensions.workbench.shell', category: 'extensions', owner: 'action',
    actionRef: { domain: 'service:extensions', verbs: ['select', 'clear'],
      note: 'shell replacement is a workbench layout layer keyed by surface — select writes it, clear restores the profile default' },
    apply: 'immediate',
    ui: { page: 'extensions', titleKey: 'settings.varin.extensions.workbench.selectedShell',
      keywords: ['shell', 'recovery', 'enable', 'disable'] },
  },
  {
    id: 'extensions.workbench.extensionSet', category: 'extensions', owner: 'action',
    actionRef: { domain: 'service:extensions', verbs: ['list', 'enable', 'disable'],
      note: 'extension set enablement goes through the Varin extension service, not a config field' },
    ui: { page: 'extensions', titleKey: 'settings.varin.extensions.workbench.extensionSet',
      keywords: ['apply', 'enable', 'extensions', 'set'] },
  },
  {
    id: 'language-support.workspace', category: 'language', owner: 'action',
    actionRef: { domain: 'runtime:language-support', verbs: ['status'],
      note: 'per-workspace language/grammar detection state' },
    ui: { page: 'language-support', titleKey: 'settings.languageSupport.section.workspace',
      descriptionKey: 'settings.page.languageSupport.description',
      keywords: ['language', 'grammar', 'structure', 'tree-sitter', 'lsp', 'language server'] },
  },
  {
    id: 'language-support.pack', category: 'language', owner: 'action',
    actionRef: { domain: 'runtime:language-support', verbs: ['prepare', 'status'],
      note: 'prepare ensures the managed language server for args.languageId; status reports language-support readiness' },
    ui: { page: 'language-support', titleKey: 'settings.languageSupport.row.structurePack',
      keywords: ['grammar', 'wasm', 'install', 'structure pack'] },
  },
  {
    id: 'providers.connect', category: 'providers', owner: 'action',
    actionRef: { domain: 'runtime:providers', verbs: ['list', 'connect', 'save', 'patch', 'remove'],
      note: 'custom/openai-compatible provider connection is a runtime action' },
    ui: { page: 'providers', titleKey: 'settings.providers.page.connect.title',
      keywords: ['add provider', 'connect provider', 'custom provider', 'openai compatible', 'base url', 'credentials'] },
  },
  {
    id: 'providers.auth', category: 'providers', owner: 'action',
    actionRef: { domain: 'runtime:providers', verbs: ['status', 'login', 'reply', 'cancel'],
      note: 'credentials belong to the native model account owner; reads never return secret material' },
    ui: { page: 'providers', titleKey: 'settings.providers.page.auth.title',
      keywords: ['api key', 'oauth', 'credentials'] },
  },
  {
    id: 'providers.connection-details', category: 'providers', owner: 'action',
    actionRef: { domain: 'runtime:providers', verbs: ['read', 'disconnect'] },
    ui: { page: 'providers', titleKey: 'settings.providers.page.connectionDetails.title',
      keywords: ['config', 'source', 'disconnect'] },
  },
  {
    id: 'providers.model-directory', category: 'providers', owner: 'action',
    actionRef: { domain: 'runtime:providers', verbs: ['models', 'discover-models'],
      note: 'Enumerate usable configured models or refresh the selected existing channel’s model directory through its owning provider.' },
    ui: { page: 'providers', titleKey: 'settings.providers.page.models.title',
      keywords: ['available models', 'discover models', 'refresh', 'model directory'] },
  },
  {
    id: 'providers.models', category: 'providers', owner: 'app',
    fields: [
      { path: 'favoriteModels', kind: 'json', note: '[{providerID, modelID}] pinned models' },
      { path: 'hiddenModels', kind: 'json', note: '[{providerID, modelID}] hidden from pickers' },
      { path: 'collapsedModelProviders', kind: 'string-list' },
    ],
    apply: 'immediate',
    ui: { page: 'providers', titleKey: 'settings.providers.page.models.title',
      keywords: ['models', 'hide', 'show'] },
  },
  {
    id: 'shortcuts.keyboard-shortcuts', category: 'productivity', owner: 'app',
    field: { path: 'shortcutOverrides', kind: 'json',
      note: 'commandId → keybinding override map' },
    apply: 'immediate',
    ui: { page: 'shortcuts', titleKey: 'settings.varin.keyboardShortcuts.title',
      descriptionKey: 'settings.varin.keyboardShortcuts.tooltip',
      keywords: ['keyboard', 'hotkeys', 'bindings'] },
  },
  {
    id: 'voice.playback', category: 'voice', owner: 'client',
    fields: [
      { path: 'voiceProvider', kind: 'enum',
        options: [
          { value: 'browser' }, { value: 'local' }, { value: 'openai' },
          { value: 'openai-compatible' }, { value: 'say' },
        ] },
      { path: 'ttsInputMode', kind: 'enum',
        options: [{ value: 'sanitized' }, { value: 'raw' }, { value: 'summarized' }] },
    ],
    apply: 'immediate',
    ui: { page: 'voice', titleKey: 'settings.voice.page.section.playbackAndSummary',
      keywords: ['tts', 'read aloud', 'voice', 'provider', 'speech rate', 'speech pitch', 'speech volume', 'tts input mode', 'markdown'] },
  },
  {
    id: 'voice.speech-recognition', category: 'voice', owner: 'app',
    fields: [
      { path: 'dictationEnabled', kind: 'boolean' },
      { path: 'sttProvider', kind: 'enum',
        options: [{ value: 'local' }, { value: 'openai-compatible' }] },
      { path: 'sttServerUrl', kind: 'string', nullable: true, authority: 'permissions', note: 'Destination for uploaded speech audio; changing it is not an ordinary speech preference.' },
      { path: 'sttModel', kind: 'string', nullable: true },
      { path: 'sttLocalModel', kind: 'string', nullable: true },
      { path: 'sttLanguage', kind: 'string', nullable: true },
      { path: 'sttSilenceThresholdDb', kind: 'number', nullable: true },
      { path: 'sttSilenceHoldMs', kind: 'number', min: 0, integer: true, nullable: true },
      { path: 'sttTranscribeOnStop', kind: 'boolean', nullable: true },
    ],
    apply: 'immediate',
    ui: { page: 'voice', titleKey: 'settings.voice.page.section.speechRecognition',
      keywords: ['stt', 'dictation', 'voice input', 'transcribe', 'whisper', 'parakeet', 'microphone'] },
  },
  {
    id: 'tunnel.provider', category: 'tunnel', owner: 'app', authority: 'permissions',
    fields: [
      { path: 'tunnelProvider', kind: 'string', nullable: true,
        note: 'e.g. cloudflare, ngrok — validated against installed providers at apply time' },
      { path: 'tunnelMode', kind: 'enum',
        options: [{ value: 'quick' }, { value: 'managed-remote' }, { value: 'managed-local' }] },
    ],
    apply: 'manual',
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.field.provider',
      descriptionKey: 'settings.varin.tunnel.description',
      keywords: ['remote access', 'cloudflare', 'ngrok'] },
  },
  {
    id: 'tunnel.type', category: 'tunnel', owner: 'app', authority: 'permissions',
    field: { path: 'tunnelMode', kind: 'enum',
      options: [{ value: 'quick' }, { value: 'managed-remote' }, { value: 'managed-local' }] },
    apply: 'manual',
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.field.tunnelType',
      keywords: ['quick', 'managed remote', 'managed local'] },
  },
  {
    id: 'tunnel.ttl', category: 'tunnel', owner: 'app', authority: 'permissions',
    fields: [
      { path: 'tunnelBootstrapTtlMs', kind: 'number', min: 0, integer: true, nullable: true, unit: 'ms' },
      { path: 'tunnelSessionTtlMs', kind: 'number', min: 0, integer: true, unit: 'ms' },
    ],
    apply: 'manual',
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.field.connectLinkTtl',
      descriptionKey: 'settings.varin.tunnel.field.tunnelSessionTtl',
      keywords: ['expiry', 'expiration', 'session ttl', 'connect link ttl'] },
  },
  {
    id: 'tunnel.managed-remote', category: 'tunnel', owner: 'app', authority: 'credentials',
    fields: [
      { path: 'managedRemoteTunnelHostname', kind: 'string', nullable: true },
      { path: 'managedRemoteTunnelToken', kind: 'secret', nullable: true,
        note: 'token is stored in the OS credential store via the settings writer; reads return status only' },
      { path: 'managedRemoteTunnelPresets', kind: 'json',
        note: '[{id, name, hostname}] saved tunnels; tokens go through managedRemoteTunnelPresetTokens' },
      { path: 'managedRemoteTunnelSelectedPresetId', kind: 'string', nullable: true },
    ],
    apply: 'manual',
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.section.savedManagedRemoteTunnels',
      keywords: ['cloudflare', 'hostname', 'token', 'managed remote'] },
  },
  {
    id: 'tunnel.managed-local-config', category: 'tunnel', owner: 'app', authority: 'credentials',
    field: { path: 'managedLocalTunnelConfigPath', kind: 'string', nullable: true,
      note: 'path to the cloudflared config file used by managed-local tunnels' },
    apply: 'manual',
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.field.configurationFile',
      descriptionKey: 'settings.varin.tunnel.note.managedLocalUsesConfig',
      keywords: ['cloudflared', 'config', 'yaml', 'json', 'managed local'] },
  },
  {
    id: 'tunnel.start', category: 'tunnel', owner: 'action',
    actionRef: { domain: 'service:tunnel', verbs: ['start', 'stop', 'status'],
      note: 'starting a tunnel is a real host action producing one-time connect links' },
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.actions.startTunnel',
      descriptionKey: 'settings.varin.tunnel.note.connectLinksOneTime',
      keywords: ['connect link', 'qr code', 'public url', 'remote access'] },
  },
  {
    id: 'global.auto-update-checks', category: 'sessions', owner: 'app',
    field: { path: 'autoUpdateChecksEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.autoSaveEnabled',
      keywords: ['update', 'auto update', 'version check'] },
  },
  {
    id: 'global.skill-catalogs', category: 'agents', owner: 'app',
    field: { path: 'skillCatalogs', kind: 'json',
      note: 'user-added skill catalog sources (SkillCatalogConfig[])' },
    apply: 'next-run',
    ui: { page: 'skills', titleKey: 'settings.varin.skills.catalog.title',
      keywords: ['skill catalog', 'source', 'registry'] },
  },
  {
    id: 'chat.draft-starters', category: 'chat', owner: 'app',
    field: { path: 'draftStarters', kind: 'json',
      note: 'pinned commands/skills shown on the new-session welcome' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.starters',
      keywords: ['starter', 'welcome', 'draft', 'suggestions'] },
  },
  {
    id: 'editor.diff-layout', category: 'editor', owner: 'app',
    field: { path: 'diffLayoutPreference', kind: 'enum',
      options: [{ value: 'dynamic' }, { value: 'inline' }, { value: 'side-by-side' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.diff',
      keywords: ['diff', 'layout', 'side by side', 'inline'] },
  },
];

const withValueSchema = (field: SettingsFieldSpec): SettingsFieldSpec => {
  if (field.kind !== 'json') return field;
  const schema = field.schema ?? settingsValueSchema(field.path);
  return { ...field, updateMode: 'replace', ...(schema ? { schema } : {}),
    note: [field.note, 'Set replaces the entire declared path. Read and retain unchanged members when editing an object; use expectedRevision to prevent stale replacement.'].filter(Boolean).join(' ') };
};
export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = CATALOG_ENTRIES.map(entry => ({ ...entry,
  ...(entry.field ? { field: withValueSchema(entry.field) } : {}),
  ...(entry.fields ? { fields: entry.fields.map(withValueSchema) } : {}),
}));

// ── Query helpers (shared by UI search and the agent catalog service) ───────

export interface SettingsCatalogQuery {
  query?: string;
  category?: SettingsCategory;
  /** Exact stable id lookup. */
  id?: string;
  owner?: SettingsOwnerKind;
}

export function getSettingsCatalogEntry(id: string): SettingsCatalogEntry | null {
  const normalized = id.trim().toLowerCase();
  return SETTINGS_CATALOG.find((entry) => entry.id.toLowerCase() === normalized) ?? null;
}

export function listSettingsCategories(): SettingsCategory[] {
  return [...new Set(SETTINGS_CATALOG.map((entry) => entry.category))];
}

const normalizeText = (value: string): string => value.trim().toLocaleLowerCase();

/**
 * AND-matching over id + category + keywords + title/description keys. The UI
 * additionally matches against translated titles. Host discovery supplies the
 * shared translations so a user's visible setting label is also searchable.
 */
export function querySettingsCatalog(query: SettingsCatalogQuery, translations?: ReadonlyMap<string, string>): SettingsCatalogEntry[] {
  if (query.id) {
    const hit = getSettingsCatalogEntry(query.id);
    return hit ? [hit] : [];
  }
  const terms = normalizeText(query.query ?? '').split(/\s+/).filter(Boolean);
  return SETTINGS_CATALOG.filter((entry) => {
    if (query.category && entry.category !== query.category) return false;
    if (query.owner && entry.owner !== query.owner) return false;
    if (terms.length === 0) return true;
    const haystack = normalizeText([
      entry.id,
      entry.category,
      entry.ui.titleKey,
      entry.ui.descriptionKey ?? '',
      ...(entry.ui.keywords ?? []),
      entry.field?.path ?? '', entry.field?.note ?? '', entry.actionRef?.note ?? '', entry.helpRef ?? '',
      ...(entry.fields?.flatMap((field) => [field.path, field.note ?? '']) ?? []),
      translations?.get(entry.id) ?? '',
    ].join(' '));
    return terms.every((term) => haystack.includes(term));
  });
}
