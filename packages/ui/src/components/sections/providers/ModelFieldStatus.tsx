import React from 'react';
import type { ModelCatalogField } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { ModelFieldContext } from './model-field-context';

export function ModelFieldStatus({ field }: { field: ModelCatalogField }) {
  const { t } = useI18n();
  const context = React.useContext(ModelFieldContext);
  if (!context?.defaults) return null;
  return context.model.catalog?.overrides.includes(field) ? <span className="inline-flex items-baseline gap-1 typography-micro font-normal text-muted-foreground">
    {t('settings.models.fieldModified')} · <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => context.onFollow(field)}>{t('settings.models.fieldRestore')}</button>
  </span> : <span className="typography-micro font-normal text-muted-foreground">{t('settings.models.fieldDefault')}</span>;
}
export function ModelFieldLabel({ field, children }: { field: ModelCatalogField; children: React.ReactNode }) {
  return <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">{children}<ModelFieldStatus field={field} /></span>;
}
