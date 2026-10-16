import React from 'react';
import type { Theme, ThemeMode } from '@/types/theme';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { getDefaultTheme } from '@/lib/theme/themes';

function ThemeMiniature({ theme }: { theme: Theme }) {
  // Ordinary surfaces avoid the global WebKit icon rule that clears SVG fills in buttons.
  return <span aria-hidden="true" className="relative block h-full w-full" style={{ background: theme.colors.surface.background }}>
    <span className="absolute rounded-sm" style={{ left: '6.67%', top: '12.5%', width: '20%', height: '75%', background: theme.colors.sidebar?.background ?? theme.colors.surface.muted }} />
    {[25, 42.19, 59.38].map((top, index) => <span key={top} className="absolute rounded-sm" style={{ left: '36.67%', top: `${top}%`, width: index === 2 ? '32.5%' : '45%', height: '7.81%', background: theme.colors.surface.foreground, opacity: 0.28 - index * 0.04 }} />)}
  </span>;
}

/** The previews read the same theme objects that generate the workbench CSS. */
export function AppearanceThemePreview({ lightTheme, darkTheme }: { lightTheme?: Theme; darkTheme?: Theme }) {
  const { t } = useI18n();
  const { themeMode, setThemeMode, currentTheme } = useThemeSystem();
  const light = lightTheme ?? getDefaultTheme(false);
  const dark = darkTheme ?? getDefaultTheme(true);
  const modes: ThemeMode[] = ['light', 'dark', 'system'];
  return <div className="mb-8 grid min-w-0 gap-7 @3xl:grid-cols-2 @3xl:items-center">
    <div className="min-w-0 space-y-5">
      <div>
        <p className="mb-2 typography-micro tracking-widest text-muted-foreground">VARIN · WORKSPACE</p>
        <h2 className="text-xl font-medium tracking-tight">{t('settings.appearance.preview.title')}</h2>
        <p className="mt-2 typography-meta text-muted-foreground">{t('settings.appearance.preview.description')}</p>
      </div>
      <div className="grid grid-cols-3 gap-3" role="group" aria-label={t('settings.varin.visual.section.colorMode')}>
        {modes.map(mode => <button key={mode} type="button" aria-pressed={themeMode === mode} onClick={() => setThemeMode(mode)}
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
    </div>
    <div className="overflow-hidden rounded-xl border border-border/60 shadow-sm" aria-label={t('settings.appearance.preview.workspace')}
      style={{ background: currentTheme.colors.surface.background, color: currentTheme.colors.surface.foreground }}>
      <div className="flex h-8 items-center gap-1.5 border-b px-3" style={{ background: currentTheme.colors.header?.background, borderColor: currentTheme.colors.interactive.border }}>
        {[0, 1, 2].map(dot => <span key={dot} className="size-1.5 rounded-full opacity-20" style={{ background: currentTheme.colors.surface.foreground }} />)}
        <span className="mx-auto typography-micro opacity-60">Varin · {t('settings.appearance.preview.workspace')}</span>
      </div>
      <div className="flex min-h-44">
        <div className="w-16 shrink-0 space-y-3 p-3" style={{ background: currentTheme.colors.sidebar?.background }}>
          {[0, 1, 2, 3].map(line => <div key={line} className="h-1.5 rounded opacity-15" style={{ background: currentTheme.colors.surface.foreground }} />)}
        </div>
        <div className="min-w-0 flex-1 space-y-4 p-4">
          <div><p className="font-medium">{t('settings.appearance.preview.greeting')}</p><p className="mt-1 typography-micro opacity-55">{t('settings.appearance.preview.answer')}</p></div>
          <p className="rounded-md px-3 py-2 typography-meta" style={{ background: currentTheme.colors.chat?.userMessageBackground }}>{t('settings.appearance.preview.prompt')}</p>
          <div className="flex h-8 items-center rounded-md border px-3" style={{ borderColor: currentTheme.colors.interactive.border }}><span className="h-1 w-2/3 rounded opacity-20" style={{ background: currentTheme.colors.surface.foreground }} /><Icon name="arrow-up" className="ml-auto size-3 opacity-50" /></div>
        </div>
      </div>
    </div>
  </div>;
}
