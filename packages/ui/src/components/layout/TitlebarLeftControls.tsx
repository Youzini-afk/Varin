import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { WorkbenchProfileSwitcher } from '@/components/layout/WorkbenchProfileSwitcher';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-interactive-hover transition-colors';

/**
 * In-flow controls in the full-width desktop header. The sidebar opens below
 * this row, so controls and the adjacent title never overlap or change parents.
 * Left padding clears native window controls where the surface needs it.
 */
export const TitlebarLeftControls: React.FC = () => {
  const { t } = useI18n();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  return (
    <div
      className="app-region-no-drag flex shrink-0 select-none items-center pr-3"
      style={{
        paddingLeft: 'var(--varin-titlebar-left-inset, 0.75rem)',
      }}
    >
      <div className="flex items-center gap-1">
        {usesFramelessChrome && windowControlsSide === 'left' ? (
          <WindowsWindowControls visible position="left" />
        ) : null}

        {usesFramelessChrome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t('header.actions.openSessionsAria')}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
            >
              <Icon name="layout-left" className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
          </TooltipContent>
        </Tooltip>

        <WorkbenchProfileSwitcher />
      </div>
    </div>
  );
};
