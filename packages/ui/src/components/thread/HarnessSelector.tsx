import React from 'react';
import { useExternalAgents } from '@/stores/useExternalAgentStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { HarnessIcon } from './HarnessIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function HarnessSelector({
  value,
  disabled,
  onChange,
}: {
  value?: string | null;
  disabled?: boolean;
  onChange?(id: string | null): void;
}) {
  const settings = useExternalAgents();
  const { t } = useI18n();
  const agent = settings?.agents.find((v) => v.id === value);
  const label = value ? (agent?.name ?? value) : 'Varin';
  const content = (
    <>
      {value ? (
        <HarnessIcon harness={agent?.harness} className="size-3.5" />
      ) : (
        <VarinLogo decorative width={14} height={14} />
      )}
      <span>{label}</span>
    </>
  );
  const style =
    'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground';
  if (!onChange)
    return (
      <span className={style} title={label}>
        {content}
      </span>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${style} hover:bg-interactive-hover hover:text-foreground`}
          disabled={disabled}
          aria-label={t('external.choose')}
        >
          {content}
          <Icon name="arrow-down-s" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" portalToBody className="min-w-48">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <VarinLogo decorative width={16} height={16} />
          <span className="flex-1">Varin</span>
          {!value && <Icon name="check" className="size-3.5" />}
        </DropdownMenuItem>
        {settings?.agents
          .filter((v) => v.enabled || v.id === value)
          .map((v) => (
            <DropdownMenuItem key={v.id} disabled={!v.enabled} onSelect={() => onChange(v.id)}>
              <HarnessIcon harness={v.harness} />
              <span className="flex-1">{v.name}</span>
              {v.id === value && <Icon name="check" className="size-3.5" />}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            useUIStore.getState().setSettingsPage('external-agents');
            useUIStore.getState().setSettingsDialogOpen(true);
          }}
        >
          {t('external.manage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
