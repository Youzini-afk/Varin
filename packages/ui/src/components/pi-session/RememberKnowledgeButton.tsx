import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import type { HarnessKnowledgeScope } from './harnessKnowledgePresentation';
import { knowledgeRememberEndpoint, knowledgeRememberPayload } from './knowledgeSuggestionRequest';

export const RememberKnowledgeButton: React.FC<{
  content: string;
  kind: string;
  className?: string;
}> = ({ content, kind, className }) => {
  const { t } = useI18n();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const [busy, setBusy] = React.useState(false);
  // BC1: an explicit user remember commits immediately; "workspace" means the
  // session's owning scope (Bot memory on Bot entry chats, workspace memory
  // for bound sessions), "user" is the cross-workspace user store.
  const remember = React.useCallback(async (scope: HarnessKnowledgeScope) => {
    if (!sessionId || !content.trim() || busy) return;
    setBusy(true);
    try {
      const response = await runtimeFetch(knowledgeRememberEndpoint(sessionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(knowledgeRememberPayload(scope, content.trim(), kind)),
      });
      if (!response.ok) throw new Error(`Unable to save memory (${response.status})`);
      toast.success(t('harness.knowledge.created'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, content, kind, sessionId, t]);

  if (!sessionId || !content.trim()) return null;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              className={className ?? 'flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50'}
              aria-label={t('chat.messageBody.actions.remember')}
            >
              <Icon name={busy ? 'loader-4' : 'brain'} className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('chat.messageBody.actions.remember')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem onClick={() => void remember('workspace')}>
          <Icon name="folder" className="mr-2 size-3.5" />
          {t('harness.knowledge.rememberWorkspace')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void remember('user')}>
          <Icon name="user" className="mr-2 size-3.5" />
          {t('harness.knowledge.rememberUser')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
