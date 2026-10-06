import React from 'react';
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { BUILTIN_EDITOR_PROVIDER_IDS, type EditorGroupLeaf, type EditorTab } from '@/lib/workbench/editors/types';
import { ScrollingFileName } from '@/components/workbench/FilesExplorer';
import {
  VARIN_WORKBENCH_SLOTS,
  type VarinWorkbenchEditorActionsSlotProps,
} from '@varin/extension-contract';
import { WorkbenchContributionSlot } from '@/lib/extensions/workbench-registry';

type EditorGroupTabsProps = {
  group: EditorGroupLeaf;
  workspaceRoot: string;
  workspaceId?: string;
  dirtyResourceIds: ReadonlySet<string>;
  isActiveGroup: boolean;
  alwaysShowActions: boolean;
  isMobile: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onPin: (tabId: string, pinned: boolean) => void;
  onMoveToGroup?: (tabId: string, targetGroupId: string) => void;
  otherGroupIds?: Array<{ groupId: string; label: string }>;
};

export const EditorGroupTabs: React.FC<EditorGroupTabsProps> = ({
  group,
  workspaceRoot,
  workspaceId,
  dirtyResourceIds,
  isActiveGroup,
  alwaysShowActions,
  isMobile,
  onActivate,
  onClose,
  onPin,
  onMoveToGroup,
  otherGroupIds,
}) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const selectionId = React.useId();
  const reducedMotion = usePrefersReducedMotion();
  const nameOf = (tab: EditorTab): string => {
    if (tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser) {
      try { return new URL(tab.viewState.browserUrl ?? '').hostname || t('contextPanel.mode.browser'); }
      catch { return t('contextPanel.mode.browser'); }
    }
    return tab.resourceId.split('/').pop() ?? tab.resourceId;
  };

  if (isMobile) {
    const active = group.tabs.find((tab) => tab.tabId === group.activeTabId) ?? group.tabs[0];
    if (!active) {
      return <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>;
    }
    const name = nameOf(active);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
            aria-label={t('filesView.editor.openFilesAria')}
          >
            <FileTypeIcon filePath={active.resourceId} className="size-3.5 flex-shrink-0" />
            <ScrollingFileName name={name} />
            <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
          {group.tabs.map((tab) => {
            const tabName = nameOf(tab);
            const isActive = tab.tabId === group.activeTabId;
            return (
              <DropdownMenuItem
                key={tab.tabId}
                onSelect={() => onActivate(tab.tabId)}
                className={cn(
                  'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                  isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <FileTypeIcon filePath={tab.resourceId} className="size-3.5 flex-shrink-0" />
                  <ScrollingFileName name={tabName} />
                  {dirtyResourceIds.has(tab.resourceId) ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(tab.tabId);
                  }}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                  aria-label={t('filesView.editor.closeFileAria', { name: tabName })}
                >
                  <Icon name="close" className="size-3.5" />
                </button>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (group.tabs.length === 0) {
    return <div className="typography-ui-label font-medium truncate px-3 py-1.5">{t('filesView.editor.selectFile')}</div>;
  }
  const activeTab = group.tabs.find((tab) => tab.tabId === group.activeTabId) ?? group.tabs[0];

  return (
    <div className={cn('relative flex min-w-0 flex-1 items-center', !isActiveGroup && 'opacity-80')}>
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none px-3 py-1.5"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {group.tabs.map((tab) => {
          const isActive = tab.tabId === group.activeTabId;
          const tabName = nameOf(tab);
          const path = tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? tab.viewState.browserUrl : workspacePathFromResourceId(workspaceRoot, tab.resourceId);
          return (
            <ContextMenu key={tab.tabId}>
              <ContextMenuTrigger
                render={(
                  <div
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/varin-tab', tab.tabId);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const moved = event.dataTransfer.getData('text/varin-tab');
                      if (moved && onMoveToGroup) onMoveToGroup(moved, group.groupId);
                    }}
                    title={path}
                    className={cn(
                      'workbench-editor-tab group relative inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-meta transition-colors whitespace-nowrap',
                      tab.preview && 'italic',
                      isActive
                        ? 'bg-transparent border-transparent text-[var(--interactive-selection-foreground)]'
                        : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]',
                    )}
                  />
                )}
              >
                {isActive ? <motion.span layoutId={`editor-selection:${selectionId}`} aria-hidden="true"
                  className="workbench-editor-tab-selection pointer-events-none absolute inset-0 rounded-md border border-[var(--primary-muted)] bg-interactive-selection"
                  transition={{ duration: reducedMotion ? 0 : .24, ease: [.22, 1, .36, 1] }} /> : null}
                {tab.pinned ? <Icon name="pushpin-2" className="size-3 shrink-0" /> : null}
                {tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? <Icon name="global" className="size-3.5 shrink-0" /> : <FileTypeIcon filePath={tab.resourceId} className="size-3.5 flex-shrink-0" />}
                <button type="button" onClick={() => onActivate(tab.tabId)} onDoubleClick={() => onPin(tab.tabId, true)} className="max-w-[12rem] truncate text-left">
                  {tabName}
                </button>
                {dirtyResourceIds.has(tab.resourceId) ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={cn(
                    'w-6 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                    !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100',
                  )}
                  aria-label={t('filesView.editor.closeFileAria', { name: tabName })}
                  title={t('filesView.editor.closeFileAria', { name: tabName })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.tabId);
                  }}
                >
                  <Icon name="close" className="size-3.5" />
                </Button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => onPin(tab.tabId, !tab.pinned)}>
                  {t(tab.pinned ? 'filesView.editor.unpinTab' : 'filesView.editor.pinTab')}
                </ContextMenuItem>
                {otherGroupIds?.map((target) => (
                  <ContextMenuItem key={target.groupId} onClick={() => onMoveToGroup?.(tab.tabId, target.groupId)}>
                    {t('filesView.editor.moveTab')} · {target.label}
                  </ContextMenuItem>
                ))}
                <ContextMenuItem onClick={() => onClose(tab.tabId)}>
                  {t('filesView.editor.closeFileAria', { name: tabName })}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      {isActiveGroup && workspaceId ? (
        <div className="flex shrink-0 items-center gap-1 px-1">
          <WorkbenchContributionSlot
            kind="view"
            slot={VARIN_WORKBENCH_SLOTS.editorActions}
            props={{
              workspaceId,
              groupId: group.groupId,
              ...(activeTab ? { resourceId: activeTab.resourceId, viewId: activeTab.viewId } : {}),
            } satisfies VarinWorkbenchEditorActionsSlotProps}
          />
        </div>
      ) : null}
    </div>
  );
};
