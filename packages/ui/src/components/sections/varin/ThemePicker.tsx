import React from 'react';
import type { Theme } from '@/types/theme';
import { useI18n } from '@/lib/i18n';
import { getThemePresentation, getThemeSwatchColors, getThemeColorGroup, THEME_COLOR_GROUPS } from '@/lib/theme/presentation';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';

function Palette({ theme }: { theme: Theme }) {
  return <span aria-hidden="true" className="flex shrink-0 gap-0.5">
    {getThemeSwatchColors(theme).map((color, index) => (
      <span key={index} className="size-3 rounded-full border" style={{ backgroundColor: color,
        borderColor: `color-mix(in srgb, ${theme.colors.surface.foreground} 25%, ${theme.colors.surface.background})` }} />
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
        {THEME_COLOR_GROUPS.map(group => {
          const grouped = entries.filter(entry => getThemeColorGroup(entry.theme) === group);
          return grouped.length ? <SelectGroup key={group}>
            <SelectLabel>{t(`settings.theme.group.${group}`)}</SelectLabel>
            {grouped.map(({ theme, name, description }) => <SelectItem key={theme.metadata.id} value={theme.metadata.id} label={name}>
              <span className="flex min-w-0 items-center gap-3">
                <Palette theme={theme} />
                <span className="min-w-0">
                  <span className="block">{name}</span>
                  {description ? <span className="mt-0.5 block typography-meta text-muted-foreground">{description}</span> : null}
                </span>
              </span>
            </SelectItem>)}
          </SelectGroup> : null;
        })}
      </SelectContent>
    </Select>
    {current?.description ? <p id={descriptionId} className="sr-only">{current.description}</p> : null}
  </div>;
}
