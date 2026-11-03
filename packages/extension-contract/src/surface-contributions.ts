import type { JsonObject, VarinExtensionManifest } from './types.js';

/** Public presentation locations. These extend a view; they do not own a conversation or its work. */
export const VARIN_CONVERSATION_SLOTS = {
  composerLeading: 'chat.composer.actions.leading',
  composerTrailing: 'chat.composer.actions.trailing',
  messages: 'chat.timeline.entries',
  tools: 'chat.timeline.tools',
  sessionDecorations: 'sessions.navigator.row.decorations',
} as const;

export interface VarinCommandContributionDataV1 {
  /** Literal author-supplied label, not a key in Varin's private translation catalog. */
  title: string;
  keywords?: string[];
}
export interface VarinCommandExecutionContextV1 {
  currentDirectory: string | null;
  isMobile: boolean;
}
export interface VarinSettingsPageContributionDataV1 {
  slug: string;
  title: string;
  group?: 'general' | 'projects' | 'harness' | 'connections';
  kind?: 'single' | 'split';
  keywords?: string[];
}
export interface VarinSettingsPageMountPropsV1 {
  region: 'content' | 'sidebar';
  /** A split page can dismiss its mobile sidebar after choosing an item. */
  onItemSelect?(): void;
}

/** Detached read-only presentation snapshots, never runtime owners or mutation APIs. Observing a result does not transfer execution authority. */
export interface VarinMessageRendererPropsV1 {
  cwd: string;
  sessionId: string;
  entry: Readonly<JsonObject> & { readonly id: string; readonly type: string };
}
export interface VarinToolRendererPropsV1 {
  cwd: string;
  call: Readonly<JsonObject> & { readonly id: string; readonly name: string };
  execution?: Readonly<JsonObject>;
  result?: Readonly<JsonObject>;
}
export interface VarinSessionDecorationPropsV1 {
  session: Readonly<JsonObject> & { readonly id: string };
  busy: boolean;
  current: boolean;
  pinned: boolean;
  attention?: Readonly<JsonObject>;
}

const nonempty = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be nonempty text`);
  return value;
};
const keywords = (data: JsonObject): { keywords?: string[] } => {
  if (data.keywords === undefined) return {};
  if (!Array.isArray(data.keywords) || data.keywords.some(value => typeof value !== 'string')) {
    throw new TypeError('keywords must be an array of strings');
  }
  return { keywords: [...data.keywords] as string[] };
};
export const parseVarinCommandContributionData = (data: JsonObject): VarinCommandContributionDataV1 => ({
  title: nonempty(data.title, 'Command title'), ...keywords(data),
});
export const parseVarinSettingsPageContributionData = (data: JsonObject): VarinSettingsPageContributionDataV1 => {
  const slug = nonempty(data.slug, 'Settings page slug');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new TypeError('Settings page slug must be lowercase words separated by hyphens');
  const group = data.group ?? 'general', kind = data.kind ?? 'single';
  if (!['general', 'projects', 'harness', 'connections'].includes(String(group))) throw new TypeError('Unknown settings page group');
  if (kind !== 'single' && kind !== 'split') throw new TypeError('Settings page kind must be single or split');
  return { slug, title: nonempty(data.title, 'Settings page title'), group: group as NonNullable<VarinSettingsPageContributionDataV1['group']>, kind, ...keywords(data) };
};

export interface VarinSurfaceAuthorDiagnostic {
  contributionId: string;
  code: 'no-product-consumer' | 'unhosted-contribution' | 'implementation-required' | 'invalid-public-data' | 'unsupported-execution-mode';
  message: string;
}
/** Author guidance, not a permission check or proof that any particular window mounted a view. */
export const inspectVarinSurfaceContributions = (manifest: VarinExtensionManifest): VarinSurfaceAuthorDiagnostic[] => {
  const diagnostics: VarinSurfaceAuthorDiagnostic[] = [];
  for (const contribution of manifest.contributions ?? []) {
    if (contribution.contractVersion !== 1) continue;
    const add = (code: VarinSurfaceAuthorDiagnostic['code'], message: string) => diagnostics.push({ contributionId: contribution.id, code, message });
    if (['keybinding', 'menu-item', 'sidebar', 'status-item'].includes(contribution.kind)) {
      add('no-product-consumer', `${contribution.kind} has no dedicated product consumer. Use a mounted view in a Shell's declared slot; this kind does not create a menu, shortcut or navigation route.`);
    }
    if (!contribution.placement?.slot && !contribution.replacement && !['command', 'settings-page', 'editor', 'shell', 'transition-scene'].includes(contribution.kind)) {
      add('unhosted-contribution', 'Declare a placement.slot or replacement target hosted by the selected Shell. Registering a contribution does not create a page or mount it.');
    }
    const entries = (manifest.entrypoints?.surfaces ?? []).filter(entry => (!contribution.entrypoint || contribution.entrypoint === entry.id)
      && contribution.supports.some(surface => entry.supports.includes(surface)));
    const executable = entries.some(entry => entry.mode !== 'declarative');
    if (['command', 'message-renderer', 'tool-renderer', 'session-decoration'].includes(contribution.kind)
      && entries.some(entry => entry.mode === 'isolated') && !entries.some(entry => entry.mode === 'managed' || entry.mode === 'native')) {
      add('unsupported-execution-mode', `${contribution.kind} needs a callable ${contribution.kind === 'command' ? 'execute' : 'matches'} implementation in a managed/native Surface. The isolated message bridge does not export this synchronous callable contract.`);
    }
    if (!executable) add('implementation-required', 'This declaration has no executable Surface entrypoint. Declarations support discovery and lazy activation; the product does not supply a data-only renderer or command implementation.');
    try {
      // Existing distribution metadata uses private translation keys; public authors use literal labels.
      if (contribution.kind === 'command' && !contribution.data.titleKey) parseVarinCommandContributionData(contribution.data);
      if (contribution.kind === 'settings-page' && !contribution.data.titleKey) parseVarinSettingsPageContributionData(contribution.data);
    } catch (error) { add('invalid-public-data', error instanceof Error ? error.message : String(error)); }
  }
  return diagnostics;
};
