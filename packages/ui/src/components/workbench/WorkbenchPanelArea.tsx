import React from 'react';

import { TerminalView } from '@/components/views/TerminalView';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import {
  peekWorkbenchPanelLayout,
  getWorkbenchOutput,
  getWorkbenchProblems,
  setWorkbenchPanelLayout,
  subscribeWorkbenchPanels,
} from '@/lib/workbench/editors/panels';
import type { WorkbenchPanelId, WorkbenchPanelLayout } from '@/lib/workbench/editors/types';
import { useUIStore } from '@/stores/useUIStore';
import { listAgentFileChangeHints, subscribeAgentFileChangeHints } from '@/lib/agent-editor/hints';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDirtyResourceIds } from '@/lib/documents/hooks';
import { peekEditorSessionLink, revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import {
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SLOTS,
  type VarinWorkbenchPanelViewsSlotProps,
} from '@varin/extension-contract';
import {
  WorkbenchContributionSlot,
  WorkbenchReplacement,
} from '@/lib/extensions/workbench-registry';

type WorkbenchPanelAreaProps = {
  workspaceId: string;
  directory: string;
  replaceable?: boolean;
};

const PANEL_IDS: WorkbenchPanelId[] = ['terminal', 'problems', 'output', 'changes'];

const PANEL_TITLE_KEYS: Record<WorkbenchPanelId, I18nKey> = {
  terminal: 'workbench.panel.terminal',
  problems: 'workbench.panel.problems',
  output: 'workbench.panel.output',
  changes: 'workbench.panel.changes',
};

const HIDDEN_LAYOUT: WorkbenchPanelLayout = {
  workspaceId: '',
  visible: false,
  activePanelId: 'terminal',
  size: 0.3,
};

const EMPTY_HINTS: ReturnType<typeof listAgentFileChangeHints> = [];

export const WorkbenchPanelArea: React.FC<WorkbenchPanelAreaProps> = ({
  workspaceId,
  directory,
  replaceable = false,
}) => {
  const { t } = useI18n();
  const layout = React.useSyncExternalStore(
    subscribeWorkbenchPanels,
    () => peekWorkbenchPanelLayout(workspaceId) ?? HIDDEN_LAYOUT,
    () => HIDDEN_LAYOUT,
  );
  const dirtyIds = useDirtyResourceIds(workspaceId);
  const hints = React.useSyncExternalStore(
    subscribeAgentFileChangeHints,
    () => listAgentFileChangeHints(workspaceId),
    () => EMPTY_HINTS,
  );
  const documentEpoch = React.useSyncExternalStore(
    (onStoreChange) => getDocumentRegistry().subscribeWorkspace(workspaceId, onStoreChange),
    () => getDocumentRegistry().workspaceVersion(workspaceId),
    () => 0,
  );
  const problems = getWorkbenchProblems(workspaceId);
  const output = getWorkbenchOutput(workspaceId);

  if (!layout.visible) return null;

  const content = (
    <>
      <div className="flex items-center gap-1 border-b border-border/40 px-2 py-1 pr-10">
        {PANEL_IDS.map((panelId) => (
          <Button
            key={panelId}
            variant="ghost"
            size="xs"
            aria-pressed={layout.activePanelId === panelId}
            onClick={() => {
              setWorkbenchPanelLayout(workspaceId, { activePanelId: panelId });
              if (panelId === 'terminal') useUIStore.getState().openContextSurface(directory, 'terminal');
            }}
            className={cn(layout.activePanelId === panelId && 'bg-[var(--interactive-selection)]')}
          >
            {t(PANEL_TITLE_KEYS[panelId])}
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className={cn('h-full min-h-0', layout.activePanelId !== 'terminal' && 'hidden')}>
            <TerminalView visible={layout.activePanelId === 'terminal'} />
          </div>
          {layout.activePanelId === 'problems' ? (
            <div className="h-full overflow-auto p-3 typography-ui text-muted-foreground">
              {problems.status === 'failure' ? (
                <div className="text-[color:var(--status-error)]">{t('workbench.panel.problemsFailed', { message: problems.errorMessage })}</div>
              ) : problems.status === 'empty' || (problems.status === 'ready' && problems.items.length === 0) ? (
                <div>{t('workbench.panel.problemsEmpty')}</div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {problems.status === 'ready' ? problems.items.map((item, index) => (
                    <li key={`${item.resourceId}:${item.line ?? 0}:${index}`}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto w-full justify-start whitespace-normal py-1 text-left"
                        aria-label={t('workbench.panel.problemsOpenAria', { resourceId: item.resourceId })}
                        onClick={() => revealResourceInEditor({
                          workspaceId,
                          resourceId: item.resourceId,
                          workspaceRoot: directory,
                          ...(typeof item.line === 'number' ? { line: item.line } : {}),
                          ...(typeof item.column === 'number' ? { column: item.column } : {}),
                        })}
                      >
                        {typeof item.line === 'number'
                          ? t('workbench.panel.problemsItemAtLine', {
                            resourceId: item.resourceId,
                            line: item.line,
                            message: item.message,
                          })
                          : t('workbench.panel.problemsItem', {
                            resourceId: item.resourceId,
                            message: item.message,
                          })}
                      </Button>
                    </li>
                  )) : null}
                </ul>
              )}
            </div>
          ) : null}
          {layout.activePanelId === 'output' ? (
            <div className="h-full overflow-auto p-3 typography-ui text-muted-foreground">
              {output.status === 'failure' ? (
                <div className="text-[color:var(--status-error)]">{t('workbench.panel.outputFailed', { message: output.errorMessage })}</div>
              ) : output.status === 'empty' || (output.status === 'ready' && output.channels.length === 0) ? (
                <div>{t('workbench.panel.outputEmpty')}</div>
              ) : (
                <ul>
                  {output.status === 'ready' ? output.channels.map((channel) => (
                    <li key={channel.id}>{channel.title}</li>
                  )) : null}
                </ul>
              )}
            </div>
          ) : null}
          {layout.activePanelId === 'changes' ? (
            <div className="h-full overflow-auto p-3 typography-ui text-muted-foreground">
              {(() => {
                const ids = new Set<string>([...dirtyIds]);
                for (const hint of hints) ids.add(hint.resourceId);
                const resourceIds = [...ids].sort();
                if (resourceIds.length === 0) return <div>{t('workbench.panel.changesEmpty')}</div>;
                return (
                  <ul className="flex flex-col gap-1">
                    {resourceIds.map((resourceId) => {
                      const meta = getDocumentRegistry().meta({ workspaceId, resourceId });
                      const hint = hints.find((item) => item.resourceId === resourceId);
                      const link = peekEditorSessionLink({ workspaceId, resourceId });
                      const stateLabel = meta?.status === 'conflict'
                        ? t('workbench.panel.changesConflict')
                        : meta?.dirty
                          ? t('workbench.panel.changesDirty')
                          : hint
                            ? t('workbench.panel.changesAgent')
                            : t('workbench.panel.changesOpen');
                      return (
                        <li key={resourceId}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-auto w-full justify-start whitespace-normal py-1 text-left"
                            aria-label={t('workbench.panel.changesOpenAria', { resourceId })}
                            onClick={() => {
                              revealResourceInEditor({
                                workspaceId,
                                resourceId,
                                workspaceRoot: directory,
                                ...(link?.thread ? { thread: link.thread } : {}),
                                ...(link?.entryId ? { entryId: link.entryId } : {}),
                                ...(hint?.toolCallId ? { toolCallId: hint.toolCallId } : {}),
                              });
                              if (link?.entryId) {
                                void openThreadFromNavigation(link.thread);
                              }
                            }}
                          >
                            {t('workbench.panel.changesItem', {
                              resourceId,
                              state: stateLabel,
                              revision: meta?.baseRevision ?? hint?.toolCallId ?? '—',
                            })}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
              <span className="hidden">{documentEpoch}</span>
            </div>
          ) : null}
        </div>
        <div className="max-h-[50%] shrink-0 overflow-auto border-t border-border/40">
          <WorkbenchContributionSlot
            kind="view"
            slot={VARIN_WORKBENCH_SLOTS.panelViews}
            props={{
              workspaceId,
              activePanelId: layout.activePanelId,
            } satisfies VarinWorkbenchPanelViewsSlotProps}
          />
        </div>
      </div>
    </>
  );

  return (
    <section
      className="relative flex min-h-0 flex-col border-t border-border/60 bg-background"
      style={{ height: `${Math.round(layout.size * 100)}%` }}
    >
      <Button
        variant="ghost"
        size="xs"
        className="absolute right-2 top-1 z-10"
        onClick={() => setWorkbenchPanelLayout(workspaceId, { visible: false })}
        aria-label={t('filesView.editor.closeFileAria', { name: t(PANEL_TITLE_KEYS[layout.activePanelId]) })}
      >
        <Icon name="close" className="size-3.5" />
      </Button>
      {replaceable ? (
        <WorkbenchReplacement
          target={VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel}
          fallback={content}
        />
      ) : content}
    </section>
  );
};
