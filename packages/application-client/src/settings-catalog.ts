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
 *  - `pi-settings` Pi `settings.json` (global agent dir + trusted project file),
 *                  written through the Pi `settings.get`/`settings.update`
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

export type SettingsOwnerKind = 'app' | 'pi-settings' | 'client' | 'action';

export type SettingsCategory =
  | 'appearance' | 'notifications' | 'chat' | 'sessions' | 'editor' | 'terminal'
  | 'model' | 'harness' | 'retrieval' | 'web' | 'extensions' | 'agents'
  | 'git' | 'tunnel' | 'projects' | 'usage' | 'voice' | 'runtime'
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
  /** Document key (`app`) or dot path (`pi-settings`, e.g. `harness.shell`). */
  path: string;
  kind: SettingsValueKind;
  options?: readonly { value: string; labelKey?: string }[];
  optionsSource?: SettingsOptionSource;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
  /** Value may be explicitly cleared (null/delete) rather than set. */
  nullable?: boolean;
  multiline?: boolean;
  maxLength?: number;
  /** Free-form note surfaced to agents (units, format, caveats). */
  note?: string;
  /**
   * `pi-settings` scope rule. `user` = global file only; `user-or-project`
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
   * Pi runtime calls; `service:*` are Application Host services; `tool:*`
   * entries defer to an existing agent tool; `page:*` is UI-only management.
   */
  domain:
    | 'runtime:extensions' | 'runtime:resources' | 'runtime:providers'
    | 'runtime:mcp' | 'runtime:language-support' | 'runtime:runtime-update'
    | 'service:git' | 'service:tunnel' | 'service:agent-personalization'
    | 'service:extensions' | 'service:agents'
    | 'service:notifications' | 'service:projects' | 'service:remote-instances'
    | 'tool:resource' | 'tool:extension' | 'page:ui';
  /** What the agent can actually do without opening the UI. */
  verbs?: readonly string[];
  note?: string;
}

export interface SettingsCatalogEntry {
  /** Stable identifier — also the settings-page focus target. */
  id: string;
  category: SettingsCategory;
  owner: SettingsOwnerKind;
  /** Single-path field. */
  field?: SettingsFieldSpec;
  /** Multi-path group — update accepts a subset of `fields`. */
  fields?: readonly SettingsFieldSpec[];
  /** Non-field entries: the domain action this row points at. */
  actionRef?: SettingsActionRef;
  /**
   * How a saved change reaches the running product. `immediate` = live once
   * saved; `next-run` = applied when the owning run/session starts;
   * `restart` = needs a host/surface restart; `manual` = requires a user or
   * domain action the catalog cannot perform.
   */
  apply?: 'immediate' | 'next-run' | 'restart' | 'manual';
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

export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = [
  {
    id: 'agent.memory', category: 'knowledge', owner: 'action',
    actionRef: { domain: 'service:agent-personalization', verbs: ['read', 'write', 'delete'],
      note: 'Always-loaded ordinary assistant notes. Read returns revision; write takes revision, scope {kind:global|project|session,id?}, content and optional id. Delete takes revision and id.' },
    apply: 'next-run', ui: { page: 'agent-memory', titleKey: 'assistant.memory.title', keywords: ['memory', 'global', 'project', 'session'] },
  },
  {
    id: 'agent.system-prompt', category: 'model', owner: 'action',
    actionRef: { domain: 'service:agent-personalization', verbs: ['read', 'write', 'reset'],
      note: 'Ordinary assistant prompt sections. Write takes revision, scope {kind:global|project|session,id?}, profile {sections:{sectionName:string|null}}. Null removes a section. Reset removes scope overrides. Bot instructions have their own owner.' },
    apply: 'next-run', ui: { page: 'agent-prompt', titleKey: 'assistant.prompt.title', keywords: ['system', 'prompt', 'instructions', 'style', 'autonomy'] },
  },
  // ── Harness (pi-settings owner) ──────────────────────────────────────────
  {
    id: 'harness.tools', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.tools', kind: 'json', scope: 'user-or-project',
      note: 'Record<toolName, boolean> enablement map; absent tools use the assembled default set' },
    apply: 'next-run',
    helpRef: 'docs/design/agent-settings-design.md#harness',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.section.tools',
      keywords: ['bash', 'grep', 'apply_patch', 'diagnostics', 'tools'] },
  },
  {
    id: 'harness.shell', category: 'harness', owner: 'pi-settings',
    fields: [
      { path: 'harness.shell', kind: 'enum', scope: 'user-or-project',
        options: [
          { value: 'auto' }, { value: 'git-bash' }, { value: 'powershell' }, { value: 'wsl' },
        ], default: 'auto' },
      { path: 'harness.bash.waitMs', kind: 'number', scope: 'user-or-project',
        min: 0, integer: true, unit: 'ms', default: 10000,
        note: 'foreground wait before the shell tool returns a background handle' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.shell.label',
      descriptionKey: 'settings.page.harness.bash.waitMs.description',
      keywords: ['shell', 'powershell', 'wsl', 'background'] },
  },
  {
    id: 'harness.output', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.output.visibleBytes', kind: 'number', scope: 'user-or-project',
      min: 1024, integer: true, unit: 'bytes', default: 32768 },
    apply: 'next-run',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.section.output',
      keywords: ['bytes', 'output', 'KiB'] },
  },
  {
    id: 'harness.permissions.mode', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.permissions.mode', kind: 'enum', scope: 'user-or-project',
      options: [
        { value: 'normal' }, { value: 'accept-edits' }, { value: 'smart' }, { value: 'bypass' },
      ], default: 'normal' },
    apply: 'next-run',
    ui: { page: 'harness-permissions', titleKey: 'settings.page.harness.permissions.mode.label',
      keywords: ['smart', 'approval', 'bypass', 'permission'] },
  },
  {
    id: 'harness.permissions.rules', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.permissions.rules', kind: 'json', scope: 'user-or-project',
      note: 'PermissionRule[] — ordered allow/deny/ask patterns; validated by Pi' },
    apply: 'next-run',
    helpRef: 'permission rules are validated by the Pi settings owner; invalid entries are rejected',
    ui: { page: 'harness-permissions', titleKey: 'settings.harness.rules.title',
      keywords: ['allow', 'deny', 'ask', 'regex', 'rules'] },
  },
  {
    id: 'harness.models.explore', category: 'retrieval', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.explore', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-retrieval', titleKey: 'settings.harness.role.explore', keywords: ["explore", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.execution', category: 'agents', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.quickImplement', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.hardImplement', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.frontend', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.retrievalAgent', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'agents', titleKey: 'settings.harness.models.execution', keywords: ["quickImplement", "hardImplement", "frontend", "retrievalAgent", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.research', category: 'agents', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.researchInvestigation', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.researchExperimentalDesign', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.researchFastExploration', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.researchHighThroughputExecution', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'agents', titleKey: 'settings.harness.models.research', keywords: ["researchInvestigation", "researchExperimentalDesign", "researchFastExploration", "researchHighThroughputExecution", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.assistance', category: 'agents', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.review', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
      { path: 'harness.models.check', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'agents', titleKey: 'settings.harness.models.assistance', keywords: ["review", "check", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.reader', category: 'web', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.reader', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.harness.role.reader', keywords: ["reader", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'knowledge.model', category: 'knowledge', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.memoryOrganizer', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-bots', titleKey: 'settings.harness.role.memoryOrganizer', keywords: ["memoryOrganizer", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.models.permissionJudge', category: 'harness', owner: 'pi-settings',
    fields: [
      { path: 'harness.models.permissionJudge', kind: 'json', scope: 'user', note: '{enabled?: boolean, providerId?: string, modelId?: string}; false disables the role while retaining its model' },
    ],
    apply: 'next-run',
    ui: { page: 'harness-permissions', titleKey: 'settings.harness.role.permissionJudge', keywords: ["permissionJudge", "agent", "model", "enable", "disable"] },
  },
  {
    id: 'harness.agents', category: 'agents', owner: 'pi-settings',
    field: { path: 'harness.agents', kind: 'json', scope: 'user',
      note: 'ID → {name, description, instructions, enabled, tools: string[], worktree: "none"|"isolated", workFocus: ("code"|"research")[], model?: {providerId,modelId}}. Empty workFocus means both. Native dispatch uses preset:"custom:ID"; models inherit only when omitted. Prefer agents.catalog actions for editing one definition with its catalog revision.' },
    apply: 'next-run', ui: { page: 'agents', titleKey: 'settings.page.agents.title', keywords: ['custom agent', 'team', 'multiagent', 'instructions', 'tools'] },
  },
  {
    id: 'harness.next-step', category: 'harness', owner: 'pi-settings',
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
    id: 'harness.context', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.context', kind: 'json', scope: 'user',
      note: '{backgroundPreparation: boolean, preparationWaterline: 0<n<1} — user-owned background compaction prep',
      default: { backgroundPreparation: true, preparationWaterline: 0.75 } },
    apply: 'next-run',
    ui: { page: 'harness-context', titleKey: 'settings.page.harness.context.backgroundPreparation',
      keywords: ['compaction', 'context'] },
  },
  {
    id: 'harness.codeRetrieval', category: 'retrieval', owner: 'pi-settings',
    field: { path: 'harness.codeRetrieval.decision', kind: 'enum', scope: 'user', default: 'auto',
      options: [
        { value: 'auto' }, { value: 'llm' }, { value: 'fast-decision' },
        { value: 'rerank' }, { value: 'source' },
      ], note: 'one result judgment method per explore query; configured model failures retain source ranking' },
    apply: 'immediate',
    ui: { page: 'harness-retrieval', titleKey: 'settings.page.harness.codeRetrieval.title',
      keywords: ['explore', 'LLM', 'fast decision', 'rerank', 'ranking'] },
  },
  {
    id: 'harness.embedding', category: 'retrieval', owner: 'pi-settings',
    field: { path: 'harness.embedding', kind: 'json', scope: 'user',
      note: 'dedicated embedding backend {provider, model, endpoint?, credentialRef?}; user-owned' },
    apply: 'next-run',
    ui: { page: 'harness-index', titleKey: 'settings.page.harness.section.embedding',
      keywords: ['embedding', 'MiniLM', 'vector'] },
  },
  {
    id: 'harness.semanticIndex', category: 'retrieval', owner: 'action',
    actionRef: { domain: 'page:ui', note: 'Host-owned index storage, request pacing and progress' },
    apply: 'restart',
    ui: { page: 'harness-index', titleKey: 'settings.page.harness.page.index.title',
      keywords: ['index', 'storage', 'progress', 'concurrency', 'embedding'] },
  },
  {
    id: 'harness.rerank', category: 'retrieval', owner: 'pi-settings',
    field: { path: 'harness.rerank', kind: 'json', scope: 'user',
      note: 'dedicated rerank backend; user-owned' },
    apply: 'next-run',
    ui: { page: 'harness-retrieval', titleKey: 'settings.page.harness.section.rerank',
      keywords: ['rerank', 'ranking'] },
  },
  {
    id: 'harness.fastDecision', category: 'retrieval', owner: 'pi-settings',
    field: { path: 'harness.fastDecision', kind: 'json', scope: 'user',
      note: 'Fast Decision Model {default?: {protocol:"pi-classifier",providerId,modelId,endpoint?}, purposes?: {explore|web|scholarly?: binding|"off"}} — typed candidate/action judgment, not a chat slot; user-owned; applies to the next query' },
    apply: 'next-run',
    ui: { page: 'harness-retrieval', titleKey: 'settings.page.harness.section.fastDecision',
      keywords: ['fast decision', 'jev', 'typesafe', 'selection'] },
  },
  {
    id: 'harness.web.search', category: 'web', owner: 'pi-settings',
    field: { path: 'harness.web.search', kind: 'json', scope: 'user',
      note: '{provider: brave|exa|tavily|jina|searxng, endpoint?, credentialRef?} — credentialRef names a Pi auth.json entry; secret material is never returned' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.section.web',
      keywords: ['brave', 'tavily', 'exa', 'jina', 'searxng', 'API key', 'search'] },
  },
  {
    id: 'harness.web.render', category: 'web', owner: 'pi-settings',
    field: { path: 'harness.web.render', kind: 'boolean', scope: 'user',
      note: 'browser rendering access for webfetch; user-owned' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.render',
      keywords: ['browser', 'webfetch', 'render'] },
  },
  {
    id: 'harness.document-reading', category: 'web', owner: 'pi-settings',
    field: { path: 'harness.documentReading', kind: 'json', scope: 'user',
      note: '{doclingCommand?, tesseractCommand?, ocrLanguage?} — direct Host executable names/paths and OCR language; user-owned',
      default: { doclingCommand: 'docling', tesseractCommand: 'tesseract', ocrLanguage: 'eng' } },
    apply: 'next-run',
    helpRef: 'Optional Host-side PDF structure parsing and OCR executables; base text and page-image reading do not require them.',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.documentReading.title',
      descriptionKey: 'settings.page.harness.web.documentReading.description',
      keywords: ['document reading', 'PDF', 'Docling', 'Tesseract', 'OCR'] },
  },
  {
    id: 'harness.web.domains', category: 'web', owner: 'pi-settings',
    field: { path: 'harness.web.domains', kind: 'json', scope: 'user-or-project',
      note: '{allow?: string[], block: string[]} — project scope can only narrow the user policy' },
    apply: 'next-run',
    ui: { page: 'harness-web', titleKey: 'settings.page.harness.web.domains.title',
      keywords: ['domain', 'allow', 'block'] },
  },
  {
    id: 'harness.dispatch', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.dispatch', kind: 'json', scope: 'user-or-project',
      note: '{concurrency: number, askBefore: Record<string, boolean>} child-run dispatch policy' },
    apply: 'next-run',
    ui: { page: 'harness-tools', titleKey: 'settings.page.harness.section.tools',
      keywords: ['concurrency', 'dispatch', 'ask before', 'child'] },
  },
  {
    id: 'harness.worktree', category: 'harness', owner: 'pi-settings',
    field: { path: 'harness.worktree', kind: 'json', scope: 'user-or-project',
      note: '{setup?, setupTimeoutMs?, copyIgnored?, shareDependencies?, reclaimIdle?, budget?}' },
    apply: 'next-run',
    ui: { page: 'projects', titleKey: 'settings.projects.page.section.worktree',
      keywords: ['worktree', 'setup commands', 'bootstrap'] },
  },
  {
    id: 'harness.knowledge.retention', category: 'harness', owner: 'pi-settings',
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
    ui: { page: 'appearance', titleKey: 'settings.appearance.language.label',
      descriptionKey: 'settings.appearance.language.description',
      keywords: ['locale', 'translation', 'ui language'] },
  },
  {
    id: 'appearance.time-format', category: 'appearance', owner: 'app',
    field: { path: 'timeFormatPreference', kind: 'enum',
      options: [{ value: 'auto' }, { value: '12h' }, { value: '24h' }] },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.timeFormat',
      keywords: ['clock', '12h', '24h'] },
  },
  {
    id: 'appearance.week-start', category: 'appearance', owner: 'app',
    field: { path: 'weekStartPreference', kind: 'enum',
      options: [{ value: 'auto' }, { value: 'sunday' }, { value: 'monday' }] },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.weekStartsOn',
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
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.installAppName',
      descriptionKey: 'settings.varin.visual.field.installAppNameHint',
      keywords: ['pwa', 'installed app'],
      availability: { web: true } },
  },
  {
    id: 'appearance.pwa-orientation', category: 'appearance', owner: 'app',
    field: { path: 'pwaOrientation', kind: 'enum',
      options: [{ value: 'system' }, { value: 'portrait' }, { value: 'landscape' }] },
    apply: 'manual',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.installOrientation',
      descriptionKey: 'settings.varin.visual.field.installOrientationHint',
      keywords: ['pwa', 'portrait', 'landscape'],
      availability: { web: true } },
  },
  {
    id: 'appearance.mobile-keyboard-mode', category: 'appearance', owner: 'app',
    field: { path: 'mobileKeyboardMode', kind: 'enum',
      options: [{ value: 'native' }, { value: 'resize-content' }] },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.mobileKeyboardMode',
      descriptionKey: 'settings.varin.visual.field.mobileKeyboardModeHint',
      keywords: ['mobile', 'keyboard', 'resize'],
      availability: { mobile: true, web: true } },
  },
  {
    id: 'appearance.interface-font-size', category: 'appearance', owner: 'app',
    fields: [
      { path: 'fontSize', kind: 'number', min: 50, max: 200, integer: true, unit: '%' },
      { path: 'uiFont', kind: 'string', nullable: true, note: 'font family override' },
      { path: 'monoFont', kind: 'string', nullable: true, note: 'monospace font override' },
    ],
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.interfaceFontSize',
      keywords: ['font', 'text size', 'ui scale'],
      availability: { mobile: false } },
  },
  {
    id: 'appearance.terminal-font-size', category: 'appearance', owner: 'app',
    field: { path: 'terminalFontSize', kind: 'number', min: 9, max: 52, integer: true, unit: 'px' },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.terminalFontSize',
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
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.terminalShell',
      descriptionKey: 'settings.varin.visual.field.terminalShellHint',
      keywords: ['terminal', 'shell', 'bash', 'zsh', 'fish', 'pwsh', 'powershell'] },
  },
  {
    id: 'appearance.editor-font-size', category: 'editor', owner: 'app',
    field: { path: 'editorFontSize', kind: 'number', min: 8, max: 32, unit: 'px' },
    apply: 'immediate',
    ui: { page: 'appearance', titleKey: 'settings.varin.visual.field.editorFontSize',
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
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.autoSaveEnabled',
      descriptionKey: 'settings.varin.visual.field.autoSaveEnabledInfo',
      keywords: ['editor', 'autosave', 'auto-save', 'files', 'save'] },
  },
  {
    id: 'appearance.expanded-editor-toolbar', category: 'editor', owner: 'app',
    field: { path: 'expandedEditorToolbar', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.expandedEditorToolbar',
      keywords: ['editor', 'toolbar', 'tabs', 'docked', 'files'] },
  },
  {
    id: 'appearance.file-editor-keymap', category: 'editor', owner: 'client',
    field: { path: 'keymap', kind: 'enum', options: [{ value: 'default' }, { value: 'vim' }] },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.fileEditorKeymap',
      keywords: ['editor', 'vim', 'keymap'] },
  },
  {
    id: 'appearance.file-editor', category: 'editor', owner: 'app',
    field: { path: 'fileEditorSettings', kind: 'json',
      note: 'editor options object (minimap, wrap, whitespace, indentation, format)' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.editor.section.title',
      descriptionKey: 'settings.varin.editor.section.description',
      keywords: ['editor', 'minimap', 'wrap', 'whitespace', 'indentation', 'format'] },
  },
  {
    id: 'appearance.terminal-quick-keys', category: 'terminal', owner: 'client',
    field: { path: 'enabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'general', titleKey: 'settings.varin.visual.field.terminalQuickKeys',
      descriptionKey: 'settings.varin.visual.field.terminalQuickKeysTooltip',
      keywords: ['terminal', 'keyboard', 'esc', 'ctrl', 'arrows'],
      availability: { mobile: false } },
  },

  // ── Chat ─────────────────────────────────────────────────────────────────
  {
    id: 'chat.render-mode', category: 'chat', owner: 'app',
    field: { path: 'chatRenderMode', kind: 'enum',
      options: [{ value: 'sorted' }, { value: 'live' }] },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.chat.replyLayout',
      keywords: ['messages', 'conversation', 'rendering'] },
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
    field: { path: 'collapsibleThinkingBlocks', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'chat', titleKey: 'settings.varin.visual.section.reasoning',
      keywords: ['thinking', 'traces'] },
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
    id: 'chat.server-permission-auto-accept', category: 'chat', owner: 'app',
    field: { path: 'serverPermissionAutoAcceptEnabled', kind: 'boolean' },
    apply: 'immediate',
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
    id: 'sessions.default-model', category: 'model', owner: 'pi-settings',
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
    id: 'sessions.default-thinking', category: 'model', owner: 'pi-settings',
    field: { path: 'defaultThinkingLevel', kind: 'string', scope: 'user-or-project',
      optionsSource: 'thinking-levels' },
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.field.defaultThinking',
      keywords: ['thinking', 'reasoning', 'variant'] },
  },
  {
    id: 'pi.cache-warming', category: 'model', owner: 'pi-settings',
    field: { path: 'cacheWarming', kind: 'enum', scope: 'user',
      options: [{ value: 'off' }, { value: 'streaming' }, { value: 'idle' }], default: 'streaming',
      note: 'Native Pi policy; refreshes are additional billed inference requests and record their usage.' },
    apply: 'next-run', ui: { page: 'sessions', titleKey: 'settings.pi.cacheWarming.title',
      descriptionKey: 'settings.pi.cacheWarming.description', keywords: ['cache', 'cost', 'warming'] },
  },
  {
    id: 'pi.codemode', category: 'model', owner: 'pi-settings',
    field: { path: 'codemode.mode', kind: 'enum', scope: 'user-or-project',
      options: [{ value: 'on' }, { value: 'only' }], default: 'on',
      note: 'Presentation when codemode is active. Activation follows native defaultTools or MCP autoEnableCodemode.' },
    apply: 'next-run', ui: { page: 'sessions', titleKey: 'settings.pi.codemode.title',
      descriptionKey: 'settings.pi.codemode.description', keywords: ['codemode', 'tools', 'scripts'] },
  },
  {
    id: 'sessions.default-agent', category: 'model', owner: 'pi-settings',
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
    id: 'sessions.small-model', category: 'model', owner: 'app',
    fields: [
      { path: 'smallModelUseDefault', kind: 'boolean',
        note: 'reuse the default model for utility work' },
      { path: 'smallModelOverride', kind: 'string', optionsSource: 'models',
        note: 'provider/model for recap, suggestions, goal audit' },
    ],
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.smallModel.title',
      descriptionKey: 'settings.varin.defaults.smallModel.description',
      keywords: ['small model', 'utility', 'summary', 'recap', 'cheap', 'override'] },
  },
  {
    id: 'sessions.walkthrough-model', category: 'model', owner: 'app',
    field: { path: 'walkthroughModelOverride', kind: 'string', optionsSource: 'models' },
    apply: 'next-run',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.walkthroughModel.title',
      descriptionKey: 'settings.varin.defaults.walkthroughModel.description',
      keywords: ['walkthrough', 'review', 'diff', 'model'] },
  },
  {
    id: 'sessions.auto-cleanup', category: 'sessions', owner: 'app',
    field: { path: 'autoDeleteEnabled', kind: 'boolean' },
    apply: 'immediate',
    ui: { page: 'sessions', titleKey: 'settings.varin.sessionRetention.field.enableAutoCleanup',
      descriptionKey: 'settings.varin.sessionRetention.tooltip',
      keywords: ['retention', 'archive', 'delete'] },
  },
  {
    id: 'sessions.retention-period', category: 'sessions', owner: 'app',
    field: { path: 'autoDeleteAfterDays', kind: 'number', min: 1, integer: true, unit: 'days' },
    apply: 'immediate',
    ui: { page: 'sessions', titleKey: 'settings.varin.sessionRetention.field.retentionPeriod',
      keywords: ['days', 'cleanup', 'retention'] },
  },
  {
    id: 'sessions.retention-action', category: 'sessions', owner: 'app',
    field: { path: 'sessionRetentionAction', kind: 'enum',
      options: [{ value: 'archive' }, { value: 'delete' }] },
    apply: 'immediate',
    ui: { page: 'sessions', titleKey: 'settings.varin.sessionRetention.field.whenSessionsExpire',
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
    ui: { page: 'sessions', titleKey: 'settings.varin.sessionRetention.field.enableAutoCleanup',
      keywords: ['recovery', 'checkpoint', 'restore', 'crash'] },
  },
  {
    id: 'sessions.message-limit', category: 'sessions', owner: 'app',
    field: { path: 'messageLimit', kind: 'number', min: 20, integer: true, default: 200,
      note: 'history fetch/trim/Load More chunk size' },
    apply: 'immediate',
    ui: { page: 'sessions', titleKey: 'settings.varin.defaults.field.showDeletionDialog',
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
    ui: { page: 'general', titleKey: 'settings.varin.desktopPassword.field.password',
      descriptionKey: 'settings.varin.desktopPassword.field.passwordDescription',
      keywords: ['desktop', 'password', 'auth', 'login'],
      availability: { desktopLocal: true } },
  },
  {
    id: 'sessions.desktop-lan-access', category: 'sessions', owner: 'app',
    field: { path: 'desktopLanAccessEnabled', kind: 'boolean' },
    apply: 'restart',
    ui: { page: 'general', titleKey: 'settings.varin.desktopNetwork.field.allowLanAccess',
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
    actionRef: { domain: 'service:git', verbs: ['list', 'create', 'delete'],
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

  // ── Usage ────────────────────────────────────────────────────────────────
  {
    id: 'usage.header-menu', category: 'usage', owner: 'app',
    field: { path: 'usageDropdownProviders', kind: 'string-list',
      note: 'provider ids shown in the header usage dropdown; empty hides the menu' },
    apply: 'immediate',
    ui: { page: 'usage', titleKey: 'settings.usage.page.options.showInHeader',
      descriptionKey: 'settings.usage.page.options.showInHeaderTooltip',
      keywords: ['quota', 'header', 'dropdown'] },
  },
  {
    id: 'usage.display', category: 'usage', owner: 'app',
    fields: [
      { path: 'usageAutoRefresh', kind: 'boolean' },
      { path: 'usageRefreshIntervalMs', kind: 'number', min: 30000, integer: true, unit: 'ms' },
      { path: 'usageDisplayMode', kind: 'enum',
        options: [{ value: 'usage' }, { value: 'remaining' }] },
      { path: 'usageShowPredValues', kind: 'boolean' },
    ],
    apply: 'immediate',
    ui: { page: 'usage', titleKey: 'settings.usage.page.section.modelQuotas',
      keywords: ['refresh', 'display', 'usage', 'remaining'] },
  },
  {
    id: 'usage.model-quotas', category: 'usage', owner: 'app',
    fields: [
      { path: 'usageSelectedModels', kind: 'json',
        note: 'providerId → selected model names shown in quota tracking' },
      { path: 'usageModelGroups', kind: 'json',
        note: 'providerId → custom grouping/assignment/rename config' },
    ],
    apply: 'immediate',
    ui: { page: 'usage', titleKey: 'settings.usage.page.section.modelQuotas',
      keywords: ['models', 'quota', 'limits', 'tokens'] },
  },

  // ── Projects ─────────────────────────────────────────────────────────────
  {
    id: 'projects.name', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: ['rename'],
      note: 'project metadata lives inside the projects[] entries of the app document; edits need a target project id' },
    ui: { page: 'projects', titleKey: 'settings.projects.page.field.projectName',
      keywords: ['label', 'display name', 'project metadata'] },
  },
  {
    id: 'projects.default-model', category: 'projects', owner: 'action',
    actionRef: { domain: 'service:projects', verbs: ['set-default-model'],
      note: 'per-project defaultModel inside the projects[] entries' },
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
    id: 'projects.worktree', category: 'projects', owner: 'app',
    field: { path: 'autoCreateWorktree', kind: 'boolean',
      note: 'auto-create a worktree for new sessions; per-repo worktree policy lives in harness.worktree' },
    apply: 'next-run',
    ui: { page: 'projects', titleKey: 'settings.projects.page.section.worktree',
      keywords: ['worktree', 'branch', 'repository'] },
  },
  {
    id: 'projects.worktree.setup.wait', category: 'projects', owner: 'pi-settings',
    field: { path: 'harness.worktree.setupTimeoutMs', kind: 'number', scope: 'user-or-project',
      min: 0, integer: true, unit: 'ms',
      note: 'how long session setup waits for worktree setup commands' },
    apply: 'next-run',
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
    ui: { page: 'remote-instances', titleKey: 'settings.remoteInstances.clientAuth.title',
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

  // ── Agents ──────────────────────────────────────────────────────────────
  {
    id: 'agents.providers', category: 'agents', owner: 'action',
    actionRef: { domain: 'service:agents', verbs: ['list', 'status'],
      note: 'agent provider plugins (pi-subagents, magic context, historian, …) via plugin settings' },
    ui: { page: 'agents', titleKey: 'settings.varin.agents.providers.title',
      descriptionKey: 'settings.varin.agents.providers.description',
      keywords: ['provider', 'pi-subagents', 'magic context', 'historian', 'dreamer', 'sidekick'] },
  },
  {
    id: 'agents.catalog', category: 'agents', owner: 'action',
    actionRef: { domain: 'service:agents', verbs: ['list', 'read', 'create', 'update', 'enable', 'disable', 'delete'],
      note: 'Native and plugin agents. Mutations take providerId, agentId (except create), and input matching the provider. Varin input is {expectedRevision: definition.revision, config?: definition.config.agent or builtin binding}; create supplies a HarnessCustomAgent config. Use returned identities for dispatch; do not edit internal files.' },
    ui: { page: 'agents', titleKey: 'settings.varin.agents.catalog.title',
      descriptionKey: 'settings.varin.agents.description',
      keywords: ['agent', 'subagent', 'workflow', 'role', 'model', 'fallback', 'thinking'] },
  },
  {
    id: 'skills.editor', category: 'agents', owner: 'action',
    actionRef: { domain: 'runtime:resources', verbs: ['list', 'read', 'write', 'delete'],
      note: 'skills are Pi resources (agent/user/project/package scope); read-only scopes stay read-only' },
    ui: { page: 'skills', titleKey: 'settings.varin.skills.catalog.title',
      descriptionKey: 'settings.varin.skills.description',
      keywords: ['skill', 'skill.md', 'markdown', 'user', 'project', 'package', 'copy'] },
  },
  {
    id: 'mcp.runtime', category: 'agents', owner: 'action',
    actionRef: { domain: 'runtime:mcp', verbs: ['status', 'reconnect'],
      note: 'MCP server runtime status; reconnect/oauth are runtime actions' },
    ui: { page: 'mcp', titleKey: 'settings.varin.mcp.runtime.title',
      keywords: ['server', 'status', 'reconnect', 'oauth', 'tools', 'resources'] },
  },
  {
    id: 'mcp.configuration', category: 'agents', owner: 'action',
    actionRef: { domain: 'runtime:mcp', verbs: ['read', 'write'],
      note: 'MCP servers are configured in Pi config documents (JSON/JSONC) through config.document.*' },
    ui: { page: 'mcp', titleKey: 'settings.varin.mcp.config.title',
      keywords: ['json', 'jsonc', 'config', 'stdio', 'url', 'environment', 'headers', 'timeout'] },
  },
  {
    id: 'plugins.packages', category: 'extensions', owner: 'action',
    actionRef: { domain: 'runtime:extensions', verbs: ['list', 'install', 'remove', 'update'],
      note: 'Pi packages/plugins — install/update/remove are real package operations' },
    ui: { page: 'plugins', titleKey: 'settings.varin.plugins.configured.title',
      descriptionKey: 'settings.varin.plugins.configured.description',
      keywords: ['pi', 'packages', 'plugins', 'update', 'remove'] },
  },
  {
    id: 'plugins.source', category: 'extensions', owner: 'action',
    actionRef: { domain: 'runtime:extensions', verbs: ['install'],
      note: 'install from npm/git/url/local path' },
    ui: { page: 'plugins', titleKey: 'settings.varin.plugins.source.title',
      descriptionKey: 'settings.varin.plugins.source.description',
      keywords: ['install', 'npm', 'git', 'url', 'local path', 'source'] },
  },
  {
    id: 'plugins.recommended', category: 'extensions', owner: 'action',
    actionRef: { domain: 'runtime:extensions', verbs: ['list', 'install'],
      note: 'curated plugin recommendations' },
    ui: { page: 'plugins', titleKey: 'settings.varin.plugins.recommended.title',
      descriptionKey: 'settings.varin.plugins.recommended.description',
      keywords: ['subagents', 'magic context', 'mcp', 'web access', 'workspace history', 'wtf', 'background tasks'] },
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
    id: 'plugin-settings.configuration', category: 'extensions', owner: 'action',
    actionRef: { domain: 'runtime:extensions', verbs: ['read', 'write'],
      note: 'per-plugin JSON/JSONC settings via Pi config documents; validated by the owning plugin schema' },
    helpRef: 'plugin settings schemas are defined by each plugin — read the plugin config doc for valid keys',
    ui: { page: 'plugin-settings', titleKey: 'settings.varin.pluginSettings.integrations.title',
      descriptionKey: 'settings.varin.pluginSettings.description',
      keywords: [
        'json', 'jsonc', 'settings', 'subagents', 'agents', 'workflows', 'roles',
        'create agent', 'model overrides', 'fallback models', 'thinking',
        'delegation', 'review', 'watchdog', 'worktree', 'intercom',
        'budget', 'scheduled runs', 'magic context', 'historian', 'dreamer',
        'sidekick', 'memory', 'embedding', 'synapse', 'sqlite', 'mural',
        'context compression', 'aft', 'cortexkit', 'hashline',
        'semantic search', 'cron', 'web access', 'web search', 'curator',
        'search routing', 'exa', 'brave', 'searxng', 'firecrawl', 'gemini web',
        'browser cookies', 'ssrf', 'domain policy', 'openai codex compat',
        'responses lite', 'remote compaction', 'observational memory',
        'observations', 'reflections', 'observation pool', 'pi-lens', 'lint',
        'lsp diagnostics', 'read guard', 'opengrep', 'trivy', 'helm render',
        'technical debt', 'hermes memory', 'persistent memory',
        'memory insights', 'memory policy', 'memory review', 'session search',
        'rtk', 'rtk optimizer', 'command rewrite', 'output compaction',
        'smart truncation',
      ] },
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
    id: 'runtime.current', category: 'runtime', owner: 'action',
    actionRef: { domain: 'runtime:runtime-update', verbs: ['status'],
      note: 'active Pi runtime version/path' },
    ui: { page: 'runtime', titleKey: 'settings.runtime.section.current',
      descriptionKey: 'settings.page.runtime.description',
      keywords: ['pi', 'runtime', 'version', 'path', 'node'] },
  },
  {
    id: 'runtime.status', category: 'runtime', owner: 'action',
    actionRef: { domain: 'runtime:runtime-update', verbs: ['status'] },
    ui: { page: 'runtime', titleKey: 'settings.runtime.field.status',
      keywords: ['ready', 'missing', 'upgrade', 'failed'] },
  },
  {
    id: 'runtime.version', category: 'runtime', owner: 'action',
    actionRef: { domain: 'runtime:runtime-update', verbs: ['status', 'upgrade'] },
    ui: { page: 'runtime', titleKey: 'settings.runtime.field.version',
      keywords: ['pi version', 'sdk'] },
  },
  {
    id: 'runtime.commandPath', category: 'runtime', owner: 'action',
    actionRef: { domain: 'runtime:runtime-update', verbs: ['status', 'choose'] },
    ui: { page: 'runtime', titleKey: 'settings.runtime.field.commandPath',
      keywords: ['path', 'executable', 'pi.cmd'] },
  },
  {
    id: 'runtime.packageRoot', category: 'runtime', owner: 'action',
    actionRef: { domain: 'runtime:runtime-update', verbs: ['status'] },
    ui: { page: 'runtime', titleKey: 'settings.runtime.field.packageRoot',
      keywords: ['package', 'module', 'node_modules'] },
  },
  {
    id: 'runtime.actions', category: 'runtime', owner: 'action',
    actionRef: { domain: 'runtime:runtime-update', verbs: ['install', 'upgrade', 'rediscover'],
      note: 'install/upgrade run the real runtime manager, not a saved flag' },
    ui: { page: 'runtime', titleKey: 'settings.runtime.section.actions',
      keywords: ['install', 'upgrade', 'rediscover', 'detect', 'choose'] },
  },
  {
    id: 'providers.connect', category: 'providers', owner: 'action',
    actionRef: { domain: 'runtime:providers', verbs: ['list', 'connect'],
      note: 'custom/openai-compatible provider connection is a runtime action' },
    ui: { page: 'providers', titleKey: 'settings.providers.page.connect.title',
      keywords: ['add provider', 'connect provider', 'custom provider', 'openai compatible', 'base url', 'credentials'] },
  },
  {
    id: 'providers.auth', category: 'providers', owner: 'action',
    actionRef: { domain: 'runtime:providers', verbs: ['status', 'login'],
      note: 'credentials live in Pi auth.json; reads return status/labels only, never secret material' },
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
      { path: 'sttServerUrl', kind: 'string', nullable: true },
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
    id: 'tunnel.provider', category: 'tunnel', owner: 'app',
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
    id: 'tunnel.type', category: 'tunnel', owner: 'app',
    field: { path: 'tunnelMode', kind: 'enum',
      options: [{ value: 'quick' }, { value: 'managed-remote' }, { value: 'managed-local' }] },
    apply: 'manual',
    ui: { page: 'tunnel', titleKey: 'settings.varin.tunnel.field.tunnelType',
      keywords: ['quick', 'managed remote', 'managed local'] },
  },
  {
    id: 'tunnel.ttl', category: 'tunnel', owner: 'app',
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
    id: 'tunnel.managed-remote', category: 'tunnel', owner: 'app',
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
    id: 'tunnel.managed-local-config', category: 'tunnel', owner: 'app',
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
 * additionally matches against translated titles; the host-side directory
 * matches on the same base fields so both consumers agree on membership.
 */
export function querySettingsCatalog(query: SettingsCatalogQuery): SettingsCatalogEntry[] {
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
      entry.field?.path ?? '',
      ...(entry.fields?.map((field) => field.path) ?? []),
    ].join(' '));
    return terms.every((term) => haystack.includes(term));
  });
}
