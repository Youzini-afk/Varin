import React from 'react';
import type { SessionSnapshot, WorkFocusId } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface PiWorkFocusControlProps {
  value?: WorkFocusId;
  state?: SessionSnapshot['workFocus'];
  projectDefault?: WorkFocusId;
  inherited?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onChange(value: WorkFocusId | undefined): void | Promise<void>;
}

export const PiWorkFocusControl: React.FC<PiWorkFocusControlProps> = ({
  value,
  state,
  projectDefault,
  inherited = false,
  disabled = false,
  loading = false,
  onChange,
}) => {
  const { t } = useI18n();
  const [saving, setSaving] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const pending = state?.status === 'pending';
  const failed = state?.status === 'failed';
  const label = (focus: WorkFocusId) => t(focus === 'research' ? 'workFocus.research' : 'workFocus.code');
  const triggerLabel = value === undefined && loading ? t('common.loading') : label(value ?? 'code');
  const select = async (next: WorkFocusId | undefined) => {
    setSaving(true);
    try {
      await onChange(next);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || saving}
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 px-1 typography-meta font-medium text-muted-foreground transition-colors hover:text-foreground',
            !loading && 'disabled:opacity-40',
            failed && 'text-destructive',
          )}
          aria-label={`${t('workFocus.label')}: ${triggerLabel}`}
          title={failed ? state?.failure?.message : pending ? t('workFocus.pending') : t('workFocus.label')}
        >
          <Icon name={saving ? 'loader-4' : value === 'research' ? 'flask' : 'compass-3'} className={cn('size-4', saving && 'animate-spin')} />
          <span>{triggerLabel}</span>
          {pending || failed ? <Icon name={failed ? 'error-warning' : 'time'} className="size-3" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64" portalToBody>
        <DropdownMenuLabel>{t('workFocus.label')}</DropdownMenuLabel>
        {(['code', 'research'] as const).map((focus) => (
          <DropdownMenuItem key={focus} disabled={saving} onSelect={() => { void select(focus); }}>
            <div className="flex min-w-0 flex-1 items-start gap-2 py-1">
              <Icon name={focus === 'research' ? 'flask' : 'compass-3'} className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{label(focus)}</div>
                <div className="mt-0.5 typography-micro text-muted-foreground">
                  {t(focus === 'research' ? 'workFocus.researchDescription' : 'workFocus.codeDescription')}
                </div>
              </div>
              {value === focus && !inherited ? <Icon name="check" className="mt-0.5 size-4 shrink-0" /> : null}
            </div>
          </DropdownMenuItem>
        ))}
        {projectDefault !== undefined ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={saving} onSelect={() => { void select(undefined); }}>
              <span className="flex-1">{t('workFocus.useProjectDefault', { focus: label(projectDefault) })}</span>
              {inherited ? <Icon name="check" className="size-4" /> : null}
            </DropdownMenuItem>
          </>
        ) : null}
        {state || inherited ? (
          <div className="border-t border-border/50 px-2 py-2 typography-micro text-muted-foreground" aria-live="polite">
            {failed ? (
              <span className="text-destructive">{t('workFocus.failed', { focus: label(state.active.id) })} {state.failure?.message}</span>
            ) : pending ? t('workFocus.pending')
              : inherited || state?.selected.source === 'project-default' ? t('workFocus.fromProject')
                : t('workFocus.nextTurn')}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
