import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ChatView } from '@/components/views/ChatView';
import { Icon } from '@/components/icon/Icon';
import { useHarnessThreadState } from '@/components/pi-session/HarnessThreadStateContext';
import { projectHarnessThreadState } from '@/components/pi-session/harnessThreadPresentation';
import { useI18n } from '@/lib/i18n';
import { ResearchFactsPanel } from './ResearchFactsPanel';

// Read the same projection as the branch controls and timeline. Selecting this
// shell never creates a research run or changes the conversation's work focus.
const ResearchOverview: React.FC = () => {
  const { t } = useI18n();
  const { rootThreads, loadError, reload } = useHarnessThreadState();
  const researchRoot = rootThreads.find(({ thread, activeRun }) => (activeRun?.frozen?.workFocus ?? thread.manifest.workFocus) === 'research');
  if (loadError) return (
    <div role="alert" className="flex items-center gap-3 border-b border-border/60 px-4 py-2 typography-meta sm:px-6">
      <span className="min-w-0 flex-1 text-muted-foreground">{loadError}</span>
      <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => { void reload().catch(() => undefined); }}>
        {t('research-workbench.retry')}
      </button>
    </div>
  );
  if (!researchRoot) return null;
  const state = projectHarnessThreadState(researchRoot);
  const active = state === 'starting' || state === 'running';
  const conclusion = researchRoot.thread.report?.conclusion;
  return (
    <section className="shrink-0 border-b border-border/60 px-4 py-3 sm:px-6" aria-label={t('research-workbench.mainline')}>
      <div className="flex items-center gap-2 typography-meta text-muted-foreground">
        <Icon name={active ? 'loader-4' : 'flask'} className={active ? 'size-3.5 animate-spin' : 'size-3.5'} />
        <span>{t('research-workbench.mainline')}</span>
        <span className="ml-auto">{t(`harness.threads.state.${state}`)}</span>
      </div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap typography-ui-label text-foreground">{researchRoot.thread.brief}</p>
      {conclusion ? (
        <details className="mt-2 typography-meta">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('research-workbench.latestFinding')}</summary>
          <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-foreground">{conclusion}</p>
        </details>
      ) : null}
      <ResearchFactsPanel />
    </section>
  );
};

const ResearchConversation: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18n();
  return <ChatView active={active} conversationHeader={<ResearchOverview />}
    threadPanelMode="inline" threadPanelTitle={t('research-workbench.branchesAndMaterials')} />;
};

const renderConversation = (active: boolean) => <ResearchConversation active={active} />;

export const ResearchWorkbenchShell: React.FC<Record<string, unknown>> = () => (
  <MainLayout renderConversation={renderConversation} />
);
