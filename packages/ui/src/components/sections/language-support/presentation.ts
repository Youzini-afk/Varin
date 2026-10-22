import type {
  LanguageSupportCapabilities,
  LanguageSupportLanguageRow,
  LanguageSupportServerInfo,
  VarinLanguageProviderStatus,
  StructureGrammarStatus,
} from '@varin/application-client';
import type { I18nKey } from '@/lib/i18n/store';

export type StatusTone = 'success' | 'warning' | 'danger' | 'muted';

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  typescript: 'TypeScript', typescriptreact: 'TSX', javascript: 'JavaScript', javascriptreact: 'JSX',
  python: 'Python', rust: 'Rust', go: 'Go', c: 'C', cpp: 'C++', csharp: 'C#', java: 'Java',
  ruby: 'Ruby', php: 'PHP', bash: 'Bash', shell: 'Shell', shellscript: 'Shell',
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less', json: 'JSON', jsonc: 'JSONC',
  yaml: 'YAML', toml: 'TOML', markdown: 'Markdown', vue: 'Vue', svelte: 'Svelte',
  swift: 'Swift', kotlin: 'Kotlin', lua: 'Lua', sql: 'SQL', dockerfile: 'Dockerfile',
  dart: 'Dart', powershell: 'PowerShell', scala: 'Scala', elixir: 'Elixir', zig: 'Zig',
  solidity: 'Solidity', hcl: 'HCL', terraform: 'Terraform', ocaml: 'OCaml', ini: 'INI',
  zsh: 'Zsh', fish: 'Fish', xml: 'XML',
};
export const languageDisplayName = (languageId: string): string => LANGUAGE_NAMES[languageId] ?? languageId;

export const serverAvailabilityKey = (status: LanguageSupportServerInfo['status']): I18nKey => {
  switch (status) {
    case 'bundled': return 'settings.languageSupport.server.bundled';
    case 'available': return 'settings.languageSupport.server.available';
    case 'preparing': return 'settings.languageSupport.server.preparing';
    case 'installed': return 'settings.languageSupport.server.installed';
    case 'failed': return 'settings.languageSupport.lsp.failed';
    case 'needs-runtime': return 'settings.languageSupport.server.needsRuntime';
    case 'unsupported': return 'settings.languageSupport.server.unsupported';
  }
};

export const languageServerStatusKey = (
  status: VarinLanguageProviderStatus['status'],
): I18nKey => {
  switch (status) {
    case 'absent':
      return 'settings.languageSupport.lsp.absent';
    case 'starting':
      return 'settings.languageSupport.lsp.starting';
    case 'ready':
      return 'settings.languageSupport.lsp.ready';
    case 'degraded':
      return 'settings.languageSupport.lsp.degraded';
    case 'failed':
      return 'settings.languageSupport.lsp.failed';
  }
};

export const languageServerStatusTone = (
  status: VarinLanguageProviderStatus['status'],
): StatusTone => {
  switch (status) {
    case 'ready':
      return 'success';
    case 'starting':
    case 'degraded':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'absent':
      return 'muted';
  }
};

export const grammarStatusKey = (status: StructureGrammarStatus): I18nKey => {
  switch (status) {
    case 'bundled':
      return 'settings.languageSupport.grammar.bundled';
    case 'installed':
      return 'settings.languageSupport.grammar.installed';
    case 'available':
      return 'settings.languageSupport.grammar.available';
    case 'absent':
      return 'settings.languageSupport.grammar.absent';
    case 'user-unverified':
      return 'settings.languageSupport.grammar.userUnverified';
    case 'unknown':
      return 'settings.languageSupport.grammar.unknown';
  }
};

/**
 * A grammar that is present but produces no outline is not a success: the
 * parser is on disk and nothing in the product can use it. Tone follows what
 * the language can actually do, not whether bytes were downloaded (D-128).
 */
export const grammarStatusTone = (
  status: StructureGrammarStatus,
  capabilities?: LanguageSupportCapabilities,
): StatusTone => {
  switch (status) {
    case 'bundled':
    case 'installed':
    case 'user-unverified':
      return capabilities?.outline ? 'success' : 'warning';
    case 'available':
      return 'warning';
    case 'absent':
    case 'unknown':
      return 'muted';
  }
};

/**
 * The one line that tells a reader whether this language does anything. Ordered
 * by what would surprise them most.
 */
export const structureNoteKey = (row: LanguageSupportLanguageRow): I18nKey | null => {
  if (row.grammarStatus === 'unknown') return 'settings.languageSupport.note.storeUnreadable';
  if (row.capabilities.outline) return null;
  if (row.grammarStatus === 'bundled' || row.grammarStatus === 'installed' || row.grammarStatus === 'user-unverified') {
    return 'settings.languageSupport.note.installedWithoutQuery';
  }
  if (row.grammarStatus === 'available' && row.pack && !row.pack.providesOutline) {
    return 'settings.languageSupport.note.packWithoutQuery';
  }
  return null;
};

export const canInstallGrammar = (status: StructureGrammarStatus): boolean => status === 'available';

export const canImportGrammar = (status: StructureGrammarStatus): boolean => (
  status !== 'bundled' && status !== 'unknown'
);

/** Pack sizes reach several megabytes and there is no resume, so show them. */
export const formatPackBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

export const statusToneClass = (tone: StatusTone): string => {
  switch (tone) {
    case 'success':
      return 'text-[var(--status-success)]';
    case 'warning':
      return 'text-[var(--status-warning)]';
    case 'danger':
      return 'text-[var(--status-error)]';
    case 'muted':
      return 'text-muted-foreground';
  }
};
