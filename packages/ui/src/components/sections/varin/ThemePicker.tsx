import React from 'react';
import type { Theme } from '@/types/theme';
import { useI18n } from '@/lib/i18n';
import { getThemePresentation } from '@/lib/theme/presentation';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function Palette({ theme }: { theme: Theme }) {
  return <span aria-hidden="true" className="flex shrink-0 -space-x-0.5">
    {[theme.colors.surface.background, theme.colors.primary.base, theme.colors.syntax.base.keyword, theme.colors.syntax.base.string].map((color, index) => (
      <span key={index} className="size-3 rounded-full border border-border/70" style={{ backgroundColor: color }} />
    ))}
  </span>;
}

export function ThemePicker({ themes, selected, onChange, label }: {
  themes: Theme[];
  selected: Theme | undefined;
  onChange: (themeId: string) => void;
  label: string;
}) {
  const { t, locale } = useI18n();
  const entries = React.useMemo(() => themes.map((theme) => ({ theme, ...getThemePresentation(theme, t) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale)), [themes, t, locale]);
  const current = selected ? getThemePresentation(selected, t) : undefined;
  const descriptionId = React.useId();
  return <div className="w-full min-w-40 max-w-56">
    <Select value={selected?.metadata.id ?? ''} onValueChange={onChange}>
      <SelectTrigger size="settings" className="w-full" aria-label={label} aria-describedby={current?.description ? descriptionId : undefined}>
        <SelectValue placeholder={t('settings.varin.visual.field.selectThemePlaceholder')}>
          {selected ? <><Palette theme={selected} /><span className="truncate">{current?.name}</span></> : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="w-[min(24rem,var(--available-width))]">
        {entries.map(({ theme, name, description }) => <SelectItem key={theme.metadata.id} value={theme.metadata.id} label={name}>
          <span className="flex min-w-0 items-center gap-3">
            <Palette theme={theme} />
            <span className="min-w-0">
              <span className="block">{name}</span>
              {description ? <span className="mt-0.5 block typography-meta text-muted-foreground">{description}</span> : null}
            </span>
          </span>
        </SelectItem>)}
      </SelectContent>
    </Select>
    {current?.description ? <p id={descriptionId} className="sr-only">{current.description}</p> : null}
  </div>;
}
