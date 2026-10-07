import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { VarinLogo } from '@/components/ui/VarinLogo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import {
  composerAgentSelection,
  type PiComposerAgentSelection,
} from '@/lib/pi-runtime/composerAgent';
import { listPiAgentProviders } from '@/lib/pi-runtime/agent-providers';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { focusChatInput } from '@/components/chat/composer/editor/dom';

interface PiComposerAgentControlProps {
  active: boolean;
  cwd: string;
  disabled?: boolean;
  loading?: boolean;
  onChange(agent: PiComposerAgentSelection | undefined): void;
  selectedAgent?: PiComposerAgentSelection;
  sessionId?: string | null;
}

export const PiComposerAgentControl: React.FC<PiComposerAgentControlProps> = ({
  active,
  cwd,
  disabled = false,
  loading: configurationLoading = false,
  onChange,
  selectedAgent,
  sessionId,
}) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [agents, setAgents] = React.useState<PiComposerAgentSelection[]>([]);

  React.useEffect(() => {
    if (!active) return;
    const target = sessionId ? { sessionId } as const : cwd ? { cwd } as const : null;
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    void listPiAgentProviders(target).then((catalog) => {
      if (cancelled) return;
      setAgents(catalog.agents
        .map(composerAgentSelection)
        .filter((agent): agent is PiComposerAgentSelection => agent !== null)
        .sort((left, right) => left.name.localeCompare(right.name)));
    }).catch(() => {
      if (!cancelled) setAgents([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, cwd, sessionId]);

  const select = React.useCallback((agent: PiComposerAgentSelection | undefined) => {
    onChange(agent);
    setOpen(false);
    requestAnimationFrame(focusChatInput);
  }, [onChange]);

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={isMobile ? () => setOpen(true) : undefined}
      className={cn(
        'flex h-8 min-w-0 max-w-[180px] items-center gap-1.5 px-1 typography-meta font-medium transition-opacity hover:opacity-70',
        selectedAgent ? 'text-foreground' : 'text-muted-foreground',
        disabled && !configurationLoading && 'cursor-not-allowed opacity-40',
      )}
      aria-label={t('chat.autocomplete.tabs.agents')}
    >
      {selectedAgent ? (
        <Icon name="ai-agent" className="size-4 shrink-0" />
      ) : (
        <VarinLogo width={16} height={16} decorative className="size-4 shrink-0" />
      )}
      <span className="truncate">{selectedAgent?.name ?? 'Varin'}</span>
      {configurationLoading ? <Icon name="loader-4" className="size-3 shrink-0 animate-spin" /> : null}
    </button>
  );

  const mobileRows = (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        className={cn(
          'flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left typography-meta',
          !selectedAgent ? 'border-primary/30 bg-primary/10' : 'border-border/40',
        )}
        onClick={() => select(undefined)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <VarinLogo width={16} height={16} decorative className="size-4 shrink-0" />
          <span>Varin</span>
        </span>
        {!selectedAgent ? <Icon name="check" className="size-4 text-primary" /> : null}
      </button>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          className={cn(
            'flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2 text-left',
            selectedAgent?.id === agent.id ? 'border-primary/30 bg-primary/10' : 'border-border/40',
          )}
          onClick={() => select(agent)}
        >
          <span className="min-w-0">
            <span className="block truncate typography-meta font-medium text-foreground">{agent.name}</span>
            {agent.description ? <span className="mt-0.5 block line-clamp-2 typography-micro text-muted-foreground">{agent.description}</span> : null}
          </span>
          {selectedAgent?.id === agent.id ? <Icon name="check" className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
        </button>
      ))}
      {loading ? <Icon name="loader-4" className="mx-auto my-3 size-4 animate-spin text-muted-foreground" /> : null}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileOverlayPanel
          open={open}
          onClose={() => setOpen(false)}
          title={t('chat.autocomplete.tabs.agents')}
        >
          {mobileRows}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={disabled ? undefined : setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(280px,calc(100vw-2rem))]" portalToBody>
        <DropdownMenuLabel>{t('chat.autocomplete.tabs.agents')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => select(undefined)}>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <VarinLogo width={16} height={16} decorative className="size-4 shrink-0" />
              <span>Varin</span>
            </span>
            {!selectedAgent ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
          </div>
        </DropdownMenuItem>
        {agents.length > 0 ? <DropdownMenuSeparator /> : null}
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => select(agent)}>
            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{agent.name}</div>
                {agent.description ? <div className="mt-0.5 line-clamp-2 typography-micro text-muted-foreground">{agent.description}</div> : null}
              </div>
              {selectedAgent?.id === agent.id ? <Icon name="check" className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
            </div>
          </DropdownMenuItem>
        ))}
        {loading ? (
          <div className="flex justify-center py-3">
            <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
