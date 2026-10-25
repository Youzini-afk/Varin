import React from 'react';
import type { Theme, ThemeMode } from '@/types/theme';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { getDefaultTheme } from '@/lib/theme/themes';
import { getThemePresentation, getThemePreviewVariables } from '@/lib/theme/presentation';

function ThemeMiniature({ theme }: { theme: Theme }) {
  // Ordinary surfaces avoid the global WebKit icon rule that clears SVG fills in buttons.
  return <span aria-hidden="true" className="relative block h-full w-full" style={{ background: theme.colors.surface.background }}>
    <span className="absolute rounded-sm" style={{ left: '6.67%', top: '12.5%', width: '20%', height: '75%', background: theme.colors.sidebar?.background ?? theme.colors.surface.muted }} />
    {[25, 42.19, 59.38].map((top, index) => <span key={top} className="absolute rounded-sm" style={{ left: '36.67%', top: `${top}%`, width: index === 2 ? '32.5%' : '45%', height: '7.81%', background: theme.colors.surface.foreground, opacity: 0.28 - index * 0.04 }} />)}
  </span>;
}

/** The previews read the same theme objects that generate the workbench CSS. */
export function AppearanceThemePreview({ lightTheme, darkTheme, previewVariant, onModeChange }: { lightTheme?: Theme; darkTheme?: Theme;
  previewVariant?: 'light' | 'dark'; onModeChange?(): void }) {
  const { t } = useI18n();
  const { themeMode, setThemeMode, currentTheme } = useThemeSystem();
  const light = lightTheme ?? getDefaultTheme(false);
  const dark = darkTheme ?? getDefaultTheme(true);
  const preview = previewVariant === 'light' ? light : previewVariant === 'dark' ? dark : currentTheme;
  const previewVariables = React.useMemo(() => getThemePreviewVariables(preview), [preview]);
  const previewName = getThemePresentation(preview, t).name;
  const modes: ThemeMode[] = ['light', 'dark', 'system'];
  return <div className="mb-8 grid min-w-0 gap-7 @3xl:grid-cols-2 @3xl:items-center">
    <div className="grid min-w-0 grid-cols-3 gap-3" role="group" aria-label={t('settings.varin.visual.section.colorMode')}>
      {modes.map(mode => <button key={mode} type="button" aria-pressed={themeMode === mode} onClick={() => { onModeChange?.(); setThemeMode(mode); }}
        className="group min-w-0 rounded-lg text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className={cn('relative block h-16 overflow-hidden rounded-lg border transition-shadow', themeMode === mode ? 'border-foreground ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'border-border group-hover:border-foreground/40')}>
          <ThemeMiniature theme={mode === 'dark' ? dark : light} />
          {mode === 'system' && <span className="absolute inset-0" style={{ clipPath: 'polygon(60% 0, 100% 0, 100% 100%, 40% 100%)' }}><ThemeMiniature theme={dark} /></span>}
        </span>
        <span className="mt-2 flex items-center justify-center gap-1 typography-meta text-muted-foreground">
          {t(`settings.varin.visual.option.themeMode.${mode}`)}{themeMode === mode && <Icon name="check" className="size-3" />}
        </span>
      </button>)}
    </div>
    <div className="overflow-hidden rounded-xl border border-border/60 shadow-sm" aria-label={t('settings.appearance.preview.workspace')} data-theme-preview={preview.metadata.id}
      style={{ ...previewVariables, background: 'var(--surface-background)', color: 'var(--surface-foreground)' }}>
      <div className="flex h-8 items-center gap-1.5 border-b px-3" style={{ background: 'var(--workbench-frame)', borderColor: 'var(--interactive-border)' }}>
        {[0, 1, 2].map(dot => <span key={dot} className="size-1.5 rounded-full opacity-20" style={{ background: 'var(--surface-foreground)' }} />)}
        <span className="mx-auto truncate typography-micro" style={{ color: 'var(--surface-muted-foreground)' }}>{previewName} · {t(`settings.varin.visual.option.themeMode.${preview.metadata.variant}`)}</span>
      </div>
      <div className="flex min-h-44">
        <div className="w-16 shrink-0 space-y-3 p-2" style={{ background: 'var(--sidebar-base)' }}>
          {[0, 1, 2, 3].map(line => <div key={line} className="rounded px-1.5 py-2" style={{ background: line === 1 ? 'var(--interactive-selection)' : undefined }}>
            <div className="h-1.5 rounded" style={{ background: line === 1 ? 'var(--primary-base)' : 'var(--surface-muted-foreground)', opacity: line === 1 ? 1 : 0.35 }} />
          </div>)}
        </div>
        <div className="min-w-0 flex-1 space-y-4 p-4">
          <div><p className="font-medium" style={{ color: 'var(--markdown-heading1)' }}>{t('settings.appearance.preview.greeting')}</p><p className="mt-1 typography-micro" style={{ color: 'var(--markdown-body)' }}>{t('settings.appearance.preview.answer')}</p></div>
          <p className="rounded-md px-3 py-2 typography-meta" style={{ background: 'var(--chat-user-message-bg)', color: 'var(--chat-user-message)' }}>{t('settings.appearance.preview.prompt')}</p>
          <div className="break-words rounded-md px-3 py-2 font-mono typography-micro" style={{ background: 'var(--syntax-background)', color: 'var(--syntax-foreground)' }}>
            <span style={{ color: 'var(--syntax-keyword)' }}>const</span>{' '}<span style={{ color: 'var(--syntax-variable)' }}>message</span>{' = '}
            <span style={{ color: 'var(--syntax-string)' }}>"Hello"</span>;
          </div>
          <div className="flex h-8 items-center rounded-md border px-3" style={{ background: 'var(--surface-muted)', borderColor: 'var(--interactive-border)' }}>
            <span className="h-1 w-2/3 rounded opacity-30" style={{ background: 'var(--surface-muted-foreground)' }} />
            <span className="ml-auto flex size-5 items-center justify-center rounded-full" style={{ background: 'var(--primary-base)', color: 'var(--primary-foreground)' }}><Icon name="arrow-up" className="size-3" /></span>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
