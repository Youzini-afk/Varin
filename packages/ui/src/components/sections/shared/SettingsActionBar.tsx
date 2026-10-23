import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { registerSettingsDraft, notifySettingsDraftChanged } from '@/lib/settings/drafts';
import { cn } from '@/lib/utils';
import { SettingsFooterContext, SettingsNavigationContext } from './settings-context';
import './settings.css';
export interface SettingsActionBarProps {
  dirty: boolean;
  saving?: boolean;
  onSave?: () => unknown | Promise<unknown>;
  onCancel: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  error?: string | null;
  children?: React.ReactNode;
  className?: string;
  placement?: 'page' | 'inline';
}
/** One save unit. Docked outside the page scroller, with the owner's real draft/status. */
export function SettingsActionBar({ dirty, saving = false, onSave, onCancel, saveDisabled = false, saveLabel, error, children, className, placement = 'page' }: SettingsActionBarProps) {
  const { t } = useI18n();
  const target = React.useContext(SettingsFooterContext);
  const guardNavigation = React.useContext(SettingsNavigationContext);
  const id = React.useId();
  const current = React.useRef({ dirty, saving, saveDisabled, onSave, onCancel });
  React.useLayoutEffect(() => { current.current = { dirty, saving, saveDisabled, onSave, onCancel }; });
  React.useEffect(() => guardNavigation ? registerSettingsDraft(id, () => current.current) : undefined, [id, guardNavigation]);
  React.useEffect(() => { notifySettingsDraftChanged(); }, [dirty, saving, saveDisabled]);
  React.useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saving]);
  const body = <div className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 px-5 py-3 backdrop-blur-sm', className)} data-settings-action-bar>
    <div className="min-w-0 flex-1 typography-meta text-muted-foreground" role="status" aria-live="polite">
      {error ? <span className="text-destructive">{error}</span> : saving ? <span className="inline-flex items-center gap-2"><Icon name="loader-4" className="size-3.5 animate-spin" />{t('settings.common.actions.saving')}</span> : dirty ? t('assistant.unsaved') : t('settings.common.status.saved')}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      {children}
      <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={onCancel}>{t('settings.common.actions.cancel')}</Button>
      <Button type="button" size="sm" disabled={!dirty || saving || saveDisabled || !onSave} onClick={() => { void onSave?.(); }}>{saveLabel ?? t('settings.common.actions.saveChanges')}</Button>
    </div>
  </div>;
  const visible = Boolean(dirty || saving || error || children);
  const dock = <div className="settings-action-dock" data-visible={visible} data-placement={placement} inert={!visible} aria-hidden={!visible}>
    <div>{body}</div>
  </div>;
  return placement === 'inline' ? dock : target ? createPortal(dock, target) : <div className="sticky bottom-0 z-10">{dock}</div>;
}
