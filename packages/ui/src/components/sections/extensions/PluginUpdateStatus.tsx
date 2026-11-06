import React from 'react';
import type { VarinExtensionUpdateCheck } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
export function PluginUpdateStatus({ update, busy, onCheck, onPreview }: {
  update?: VarinExtensionUpdateCheck; busy: boolean; onCheck(): void; onPreview(): void;
}) {
  const { t } = useI18n();
  return <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-2 typography-micro text-muted-foreground" role="status">
    {update ? <div className="mr-auto min-w-0"><span>{t(`settings.plugins.${update.status}`)}{update.version ? ` · ${update.version}` : ''}</span>
      <p>{t('settings.plugins.checked', { time: new Date(update.checkedAt).toLocaleString() })}</p>{update.message ? <p className="break-words">{update.message}</p> : null}</div> : null}
    <Button size="xs" variant="ghost" disabled={busy} onClick={onCheck}>{t('settings.plugins.checkUpdates')}</Button>
    {update?.status === 'available' ? <Button size="xs" disabled={busy} onClick={onPreview}>{t('settings.plugins.update')}</Button> : null}
  </div>;
}
