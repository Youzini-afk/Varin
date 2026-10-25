import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSlidingUnderline } from './railMotion';

export const ContextPanelGitNavigation: React.FC<{
  mode: 'git' | 'pr' | 'diff';
  panelDirectory: string;
  repositoryDirectory: string | null;
  onReturnToChanges: (directory: string) => void;
}> = ({ mode, panelDirectory, repositoryDirectory, onReturnToChanges }) => {
  const { t } = useI18n();
  const openTab = useUIStore((state) => state.openContextPanelTab);
  const underline = React.useRef<HTMLSpanElement>(null);
  useSlidingUnderline(underline, mode === 'pr' ? 'pr' : 'changes');

  return (
    <nav className="relative flex min-w-0 flex-1 items-stretch gap-1 px-2" aria-label={t('layout.rightSidebar.git')}>
      {/* One underline slides between the two views instead of each tab drawing its own. */}
      <span ref={underline} aria-hidden="true" className="tab-underline" data-hidden="" />
      <button
        type="button"
        aria-pressed={mode !== 'pr'}
        onClick={() => {
          if (mode !== 'git' && repositoryDirectory) onReturnToChanges(repositoryDirectory);
        }}
        className={cn(
          'flex min-w-0 items-center gap-1.5 border-b-2 border-transparent px-2 typography-ui-label text-muted-foreground transition-colors hover:text-foreground',
          mode !== 'pr' && 'text-foreground',
        )}
      >
        <Icon name="git-branch" className="size-3.5 shrink-0" />
        <span className="truncate">{t('gitView.changes.title')}</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === 'pr'}
        onClick={() => {
          if (mode !== 'pr' && repositoryDirectory) {
            openTab(panelDirectory, { mode: 'pr', targetDirectory: repositoryDirectory });
          }
        }}
        className={cn(
          'flex min-w-0 items-center gap-1.5 border-b-2 border-transparent px-2 typography-ui-label text-muted-foreground transition-colors hover:text-foreground',
          mode === 'pr' && 'text-foreground',
        )}
      >
        <Icon name="git-pull-request" className="size-3.5 shrink-0" />
        <span className="truncate">{t('contextPanel.mode.pr')}</span>
      </button>
    </nav>
  );
};
