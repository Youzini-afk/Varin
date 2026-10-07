import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ContextRailIcon } from '@/components/icons/ContextRailIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** Panel and rail are independent views over the existing per-directory layout. */
export const ContextPanelControls: React.FC = () => {
  const { t } = useI18n();
  const directory = useEffectiveDirectory();
  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  const railOpen = useUIStore((state) => state.isContextRailOpen);
  const toggleRail = useUIStore((state) => state.toggleContextRail);
  const panelOpen = useUIStore((state) => {
    const panel = state.contextPanelByDirectory[directoryKey];
    return Boolean(panel?.isOpen && panel.tabs.length > 0);
  });
  const togglePanel = useUIStore((state) => state.toggleContextPanel);
  const railLabel = t(railOpen ? 'contextRail.actions.collapse' : 'contextRail.actions.expand');
  const panelLabel = t(panelOpen ? 'contextPanel.actions.closePanel' : 'contextPanel.actions.openPanel');
  const buttonClass = 'workbench-icon-button app-region-no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  if (!directoryKey) return null;

  return <div className="app-region-no-drag flex shrink-0 items-center gap-0.5">
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={panelLabel} aria-expanded={panelOpen}
          onClick={() => togglePanel(directoryKey)}
          className={cn(buttonClass, panelOpen && 'bg-interactive-selection text-foreground')}>
          <Icon name="layout-right" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{panelLabel}</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={railLabel} aria-expanded={railOpen}
          aria-controls={railOpen ? 'context-panel-rail' : undefined}
          onClick={toggleRail}
          className={buttonClass}>
          <ContextRailIcon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{railLabel}</TooltipContent>
    </Tooltip>
  </div>;
};
