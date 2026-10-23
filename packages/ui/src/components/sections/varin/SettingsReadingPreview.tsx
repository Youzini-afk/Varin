import React from 'react';
import { CODE_FONT_OPTIONS } from '@/lib/fontOptions';
import { Icon } from '@/components/icon/Icon';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/** A static reading sample: no editor instance, language service or process is started. */
export function SettingsReadingPreview({ kind }: { kind: 'editor' | 'terminal' }) {
  const { t } = useI18n();
  const size = useUIStore(state => kind === 'editor' ? state.editorFontSize : state.terminalFontSize);
  const monoFont = useUIStore(state => state.monoFont);
  const settings = useUIStore(state => state.fileEditorSettings);
  return <aside className="settings-preview-pane" aria-label={t('settings.experience.readingPreview')}>
    <p className="mb-3 typography-micro text-muted-foreground">{t('settings.experience.readingPreview')}</p>
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-3 typography-micro text-muted-foreground"><Icon name={kind === 'editor' ? 'code-box' : 'terminal'} className="size-4" />{kind === 'editor' ? 'preview.tsx' : t('settings.page.terminal.title')}</div>
      <pre className="min-h-64 overflow-auto p-5 leading-relaxed" style={{ fontSize: size, lineHeight: kind === 'editor' && settings.lineHeight > 0 ? `${settings.lineHeight}px` : 1.65, tabSize: settings.tabSize, fontVariantLigatures: settings.fontLigatures ? 'normal' : 'none', fontFamily: CODE_FONT_OPTIONS.find(font => font.id === monoFont)?.stack ?? 'monospace', whiteSpace: kind === 'terminal' || settings.wordWrap !== 'off' ? 'pre-wrap' : 'pre', overflowWrap: kind === 'terminal' || settings.wordWrap !== 'off' ? 'anywhere' : 'normal' }}>
        {kind === 'editor' ? 'export function Welcome() {\n  const message = "Ready to work";\n\n  return (\n    <section>\n      <h1>{message}</h1>\n      <p>Review the plan and continue.</p>\n    </section>\n  );\n}' : '$ git status\n\nOn branch main\nYour branch is up to date.\n\nnothing to commit, working tree clean\n\n$ ▍'}
      </pre>
    </div>
  </aside>;
}
