import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { ServiceRoutingOption } from '@/lib/extensions/service-routing-options';

export interface ServiceRoutingControlProps {
  busy: boolean;
  composition?: 'ordered';
  extensionNames: ReadonlyMap<string, string>;
  inheritedSelection?: string | readonly string[];
  onSelect: (selection: string | readonly string[] | null) => void;
  providers: readonly ServiceRoutingOption[];
  selection: string | readonly string[] | null;
}

/** The control edits only the exact scope rule. Inherited choices and missing members are
 * projected without turning automatic routing into a new selection or selecting extra owners. */
export const ServiceRoutingControl: React.FC<ServiceRoutingControlProps> = ({
  busy, composition, extensionNames, inheritedSelection, onSelect, providers, selection,
}) => {
  const { t } = useI18n();
  const ordered = selection !== null && typeof selection !== 'string' ? selection : null;
  const value = ordered ? (ordered.length ? '__ordered__' : '__empty__') : typeof selection === 'string' ? selection : '__automatic__';
  const label = (key: string): string => {
    const provider = providers.find((candidate) => candidate.providerKey === key);
    return provider ? extensionNames.get(provider.extensionId) ?? provider.extensionId : key;
  };
  const available = (key: string): boolean => providers.some((provider) => provider.providerKey === key);
  const selectedLabel = ordered ? t(ordered.length ? 'settings.varin.extensions.routing.ordered' : 'settings.varin.extensions.routing.empty')
    : typeof selection === 'string' ? available(selection) ? t('settings.varin.extensions.routing.single', { name: label(selection) })
      : `${selection} · ${t('settings.varin.extensions.routing.missing')}` : t('settings.varin.extensions.routing.automatic');
  const move = (index: number, offset: number): void => {
    if (!ordered) return;
    const next = [...ordered];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onSelect(next);
  };
  const additions = providers.filter((provider) => (
    provider.descriptor.contract?.composition === 'ordered' && !ordered?.includes(provider.providerKey)
  ));
  return (
    <div className="min-w-0 space-y-2">
      <Select
        value={value}
        disabled={busy}
        onValueChange={(next) => {
          if (next === '__automatic__') onSelect(null);
          else if (next === '__empty__') onSelect([]);
          else if (next === '__ordered__') onSelect(typeof selection === 'string' ? [selection] : ordered ?? []);
          else onSelect(next);
        }}
      >
        <SelectTrigger aria-label={t('settings.varin.extensions.routing.selection')}><SelectValue>{selectedLabel}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="__automatic__">{t('settings.varin.extensions.routing.automatic')}</SelectItem>
          {composition === 'ordered' || ordered ? (
            <>
              <SelectItem value="__ordered__" disabled={composition !== 'ordered'}>{t('settings.varin.extensions.routing.ordered')}</SelectItem>
              <SelectItem value="__empty__" disabled={composition !== 'ordered'}>{t('settings.varin.extensions.routing.empty')}</SelectItem>
            </>
          ) : null}
          {typeof selection === 'string' && !available(selection) ? (
            <SelectItem value={selection}>{selection} · {t('settings.varin.extensions.routing.missing')}</SelectItem>
          ) : null}
          {providers.map((provider) => (
            <SelectItem key={provider.providerKey} value={provider.providerKey}>
              {t('settings.varin.extensions.routing.single', { name: label(provider.providerKey) })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {ordered ? (
        <>
          <p className="typography-micro text-muted-foreground">
            {t(ordered.length ? 'settings.varin.extensions.routing.orderedHelp' : 'settings.varin.extensions.routing.emptyHelp')}
          </p>
          {composition !== 'ordered' ? (
            <p role="status" className="typography-micro text-[var(--status-warning)]">{t('settings.varin.extensions.routing.unsupportedCollection')}</p>
          ) : null}
          <ol className="space-y-2" aria-label={t('settings.varin.extensions.routing.ordered')}>
            {ordered.map((key, index) => (
              <li key={key} className="flex min-w-0 items-start gap-2" data-provider-key={key}>
                <span className="pt-1 typography-meta text-muted-foreground">{index + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="break-words typography-meta">{label(key)}</div>
                  <div className="break-all typography-micro text-muted-foreground">{key}</div>
                  {!available(key) ? <div className="typography-micro text-[var(--status-warning)]">{t('settings.varin.extensions.routing.missing')}</div> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" variant="ghost" size="xs" disabled={busy || index === 0}
                    aria-label={t('settings.varin.extensions.routing.moveUp', { name: label(key) })} onClick={() => move(index, -1)}>↑</Button>
                  <Button type="button" variant="ghost" size="xs" disabled={busy || index === ordered.length - 1}
                    aria-label={t('settings.varin.extensions.routing.moveDown', { name: label(key) })} onClick={() => move(index, 1)}>↓</Button>
                  <Button type="button" variant="ghost" size="xs" disabled={busy}
                    aria-label={t('settings.varin.extensions.routing.remove', { name: label(key) })}
                    onClick={() => onSelect(ordered.filter((_, position) => position !== index))}>×</Button>
                </div>
              </li>
            ))}
          </ol>
          {composition === 'ordered' && additions.length ? (
            <div className="flex flex-wrap gap-1" aria-label={t('settings.varin.extensions.routing.addProvider')}>
              {additions.map((provider) => (
                <Button key={provider.providerKey} type="button" variant="outline" size="xs" disabled={busy}
                  onClick={() => onSelect([...ordered, provider.providerKey])}>
                  {t('settings.varin.extensions.routing.add', { name: label(provider.providerKey) })}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {selection === null && inheritedSelection !== undefined ? (
        <div className="typography-micro text-muted-foreground">
          <p>{t('settings.varin.extensions.routing.inherited')}</p>
          {typeof inheritedSelection === 'string' ? <p className="break-all">{inheritedSelection}</p>
            : inheritedSelection.length ? <ol className="list-inside list-decimal">{inheritedSelection.map((key) => <li key={key} className="break-all">{key}</li>)}</ol>
              : <p>{t('settings.varin.extensions.routing.empty')}</p>}
        </div>
      ) : null}
    </div>
  );
};
