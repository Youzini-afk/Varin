import React from 'react';
import { resolveHarnessModelSlot, type PermissionMode } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useWorkspaceHarnessSettings } from '@/components/sections/harness/useHarnessSettings';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function ThreadPermissionControl({ workspacePath, className }: { workspacePath?: string; className?: string }) {
  const { t } = useI18n();
  const { harness, effectivePermissionMode, status, error, update, retry } = useWorkspaceHarnessSettings(workspacePath);
  const mode = harness?.permissions?.mode ?? 'normal';
  const busy = status === 'loading' || status === 'saving';
  const label = t('settings.page.harness.permissions.mode.label');
  const effectiveLabel = effectivePermissionMode ? t(`settings.page.harness.permissions.mode.${effectivePermissionMode}`) : t('common.loading');
  const smartAvailable = Boolean(harness && resolveHarnessModelSlot('permissionJudge', harness.models, null));

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className={cn(className, error ? 'text-destructive' : effectivePermissionMode === 'bypass' && 'text-primary')}
        aria-label={`${label}: ${effectiveLabel}`} title={error ?? `${label}: ${effectiveLabel}`} aria-busy={busy}>
        <Icon name={busy ? 'loader-4' : error ? 'error-warning' : effectivePermissionMode === 'bypass' ? 'shield-check' : effectivePermissionMode === 'accept-edits' ? 'shield-keyhole' : 'shield-user'}
          className={cn('size-4', busy && 'animate-spin')} />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-72" portalToBody>
      <DropdownMenuLabel>{label} · {t('settings.common.scope.global')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={harness ? mode : ''} onValueChange={value => update({ permissions: { mode: value as PermissionMode } })}>
        {(['normal', 'accept-edits', 'bypass', 'smart'] as const).map(value => <DropdownMenuRadioItem key={value} value={value}
          closeOnClick={false} disabled={!harness || busy || value === 'smart' && !smartAvailable}>
          {t(`settings.page.harness.permissions.mode.${value}`)}
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {!smartAvailable && harness ? <p className="px-2 py-2 typography-micro text-muted-foreground">{t('settings.page.harness.permissions.smartUnavailable')}</p> : null}
      {effectivePermissionMode && effectivePermissionMode !== mode ? <p className="border-t border-border/50 px-2 py-2 typography-micro text-muted-foreground">
        {t('settings.common.scope.project')} · {effectiveLabel}
      </p> : null}
      {busy ? <p role="status" className="px-2 py-2 typography-micro text-muted-foreground">{t(status === 'saving' ? 'settings.common.actions.saving' : 'common.loading')}</p> : null}
      {error ? <div role="alert" className="border-t border-border/50 px-2 py-2 typography-micro text-destructive">
        <p>{error}</p><button type="button" className="mt-2 underline" onClick={() => void retry()}>{t('settings.harness.retry')}</button>
      </div> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
