import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import {
  sortContextSurfaces,
  getContextRailMode,
  type ContextSurfaceDescriptor,
} from '@/lib/surfaces/registry';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { contextPanelGitDirectoryScopeKey, useContextPanelGitDirectoryStore } from '@/stores/useContextPanelGitDirectoryStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

const RAIL_TOOLTIP_DELAY_MS = 150;
const EMPTY_TABS: never[] = [];

type RailItemProps = {
  surface: ContextSurfaceDescriptor;
  isActive: boolean;
  label: string;
  description: string;
  badgeAriaLabel?: string;
  badgeCount?: number;
  badgeDescription?: string;
  onSelect: (surface: ContextSurfaceDescriptor) => void;
};

const formatBadgeCount = (count: number): string => count > 99 ? '99+' : String(count);

const ContextPanelRailItem: React.FC<RailItemProps> = ({
  surface,
  isActive,
  label,
  description,
  badgeAriaLabel,
  badgeCount,
  badgeDescription,
  onSelect,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative shrink-0', isDragging && 'z-10 opacity-70')}
    >
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => onSelect(surface)}
            aria-label={badgeAriaLabel ?? label}
            aria-pressed={isActive}
            className={cn(
              'flex h-8 w-8 touch-none select-none items-center justify-center rounded-md transition-colors',
              isActive
                ? 'bg-interactive-selection text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {isActive ? (
              <span aria-hidden="true" className="absolute -left-1 h-4 w-0.5 rounded-full bg-primary" />
            ) : null}
            <Icon name={surface.icon} className="h-[18px] w-[18px]" />
            {badgeCount !== undefined && badgeCount > 0 ? (
              <span
                aria-hidden="true"
                // The count is a live signal; keep it legible on top of the icon
                // with its own status-info chip instead of muted text on the rail.
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-none"
                style={{
                  backgroundColor: 'var(--status-info-background)',
                  color: 'var(--status-info)',
                }}
              >
                {formatBadgeCount(badgeCount)}
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          <div className="flex flex-col gap-0.5">
            <span>{label}</span>
            <span className="typography-micro text-muted-foreground">{description}</span>
            {badgeDescription ? (
              <span className="typography-micro text-muted-foreground">{badgeDescription}</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const ContextPanelRail: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const setContextRailOrder = useUIStore((state) => state.setContextRailOrder);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const gitScopeKey = contextPanelGitDirectoryScopeKey(sessionId, effectiveDirectory);
  const selectedGitDirectory = useContextPanelGitDirectoryStore((state) => gitScopeKey ? state.directories[gitScopeKey] : undefined);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const tabs = panelState?.tabs ?? EMPTY_TABS;
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;
  const activeMode = panelState?.isOpen && activeTab ? getContextRailMode(activeTab.mode) : null;
  const gitStatusDirectory = activeTab && getContextRailMode(activeTab.mode) === 'git' ? activeTab.targetDirectory ?? selectedGitDirectory ?? effectiveDirectory
    : selectedGitDirectory ?? effectiveDirectory;
  const gitStatus = useGitStatus(gitStatusDirectory || null);
  const changedFilesCount = gitStatus?.files.length ?? 0;

  // Content-driven surfaces are hidden (not disabled) until content exists;
  // an existing tab keeps them visible even if the content source went away.
  const surfaces = React.useMemo(() => {
    return sortContextSurfaces(contextRailOrder).filter((surface) => {
      if (surface.id === 'plan' && !planModeEnabled) {
        return false;
      }
      if (surface.availability === 'has-content') {
        return tabs.some((tab) => tab.mode === surface.mode);
      }
      return true;
    });
  }, [contextRailOrder, planModeEnabled, tabs]);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const orderedIds = sortContextSurfaces(useUIStore.getState().contextRailOrder).map((surface) => surface.id);
    const fromIndex = orderedIds.indexOf(active.id as (typeof orderedIds)[number]);
    const toIndex = orderedIds.indexOf(over.id as (typeof orderedIds)[number]);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    setContextRailOrder(arrayMove(orderedIds, fromIndex, toIndex));
  }, [setContextRailOrder]);

  if (!directoryKey) {
    return null;
  }

  return (
    <nav
      id="context-panel-rail"
      aria-label={t('contextRail.aria.rail')}
      className="workbench-resource-rail flex h-full w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto py-2"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={surfaces.map((surface) => surface.id)} strategy={verticalListSortingStrategy}>
          {surfaces.map((surface) => {
            const label = t(surface.labelKey);
            const badgeCount = surface.id === 'git' && changedFilesCount > 0
              ? changedFilesCount
              : undefined;
            return (
              <ContextPanelRailItem
                key={surface.id}
                surface={surface}
                isActive={activeMode === surface.mode}
                label={label}
                description={t(surface.descriptionKey)}
                badgeCount={badgeCount}
                badgeAriaLabel={badgeCount === undefined
                  ? undefined
                  : t('contextRail.surface.git.changesCountAria', { label, count: badgeCount })}
                badgeDescription={badgeCount === undefined
                  ? undefined
                  : t('contextRail.surface.git.changesCountTooltip', { count: badgeCount })}
                onSelect={(selected) => openContextSurface(directoryKey, selected.mode)}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </nav>
  );
};
