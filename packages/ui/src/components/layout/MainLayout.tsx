import React, { useRef, useEffect } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ProjectContextPanel } from './RightSidebarTabs';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { PiSessionSidebar } from '@/components/pi-session/PiSessionSidebar';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { MultiRunLauncher } from '@/components/multirun';
import { TerminalView } from '@/components/views/TerminalView';
import { DrawerProvider } from '@/contexts/DrawerContext';
import { WorkspaceOverlays } from '@/components/workspace/WorkspaceOverlays';
import {
    WorkbenchContributionSlot,
    WorkbenchReplacement,
    WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';

import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { workspaceEvents } from '@/lib/workspaceEvents';

import { RegularChatView } from '@/components/views/RegularChatView';

// Keep TerminalView eager: the bottom dock reserves its height immediately, so
// suspending here leaves a large blank panel on slower machines.
// Other heavy views stay on-demand: Files can load Monaco and Diff loads its
// renderer; Plan's embedded CodeMirror is also irrelevant until selected.
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then(m => ({ default: m.PlanView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then(m => ({ default: m.GitView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then(m => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then(m => ({ default: m.FilesView })));
const DiagramView = lazyWithChunkRecovery(() => import('@/components/views/DiagramView').then(m => ({ default: m.DiagramView })));
const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));
const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then(m => ({ default: m.SettingsWindow })));

interface MainLayoutProps {
    renderConversation?: (active: boolean) => React.ReactNode;
    renderNavigator?: (isVisible: boolean) => React.ReactNode;
    navigationTitle?: string;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ renderConversation, renderNavigator, navigationTitle }) => {
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isContextRailOpen = useUIStore((state) => state.isContextRailOpen);
    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    // Rendering a closed lazy dialog still asks React to fetch its component.
    // Mount it after the first real open, then retain it for close animation and
    // in-window state just as before.
    const [settingsWindowMounted, setSettingsWindowMounted] = React.useState(isSettingsDialogOpen);
    React.useEffect(() => {
        if (isSettingsDialogOpen) setSettingsWindowMounted(true);
    }, [isSettingsDialogOpen]);
    const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
    const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
    const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);
    const isScheduledTasksPageOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
    const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
    const worktreesPageProjectId = useUIStore((state) => state.worktreesPageProjectId);
    // Any full-page surface replacing the chat area. While open, the chat and
    // secondary views are fully hidden (not just covered) so none of their
    // floating chrome bleeds through, and selecting a session / draft / main
    // tab anywhere closes the surface.
    const isSurfacePageOpen = isScheduledTasksPageOpen || isArchivePageOpen || Boolean(worktreesPageProjectId) || isMultiRunLauncherOpen;

    React.useEffect(() => {
        const closeSurfacePages = () => useUIStore.getState().closeMainSurfaces();
        const unsubscribeSession = usePiSessionStore.subscribe((state, prev) => {
            const sessionSelected = Boolean(state.currentSessionId) && state.currentSessionId !== prev.currentSessionId;
            if (sessionSelected) closeSurfacePages();
        });
        const unsubscribeTab = useUIStore.subscribe((state, prev) => {
            if (state.activeMainTab !== prev.activeMainTab) closeSurfacePages();
        });
        return () => {
            unsubscribeSession();
            unsubscribeTab();
        };
    }, []);
    const { isMobile } = useDeviceInfo();
    const mobilePanelsResetRef = React.useRef(false);

    // Mobile drawer state
    const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = React.useState(false);
    const [mobileRightSidebarOpen, setMobileRightSidebarOpen] = React.useState(false);
    const [mobileLeftDrawerVisible, setMobileLeftDrawerVisible] = React.useState(false);
    const [mobileRightDrawerVisible, setMobileRightDrawerVisible] = React.useState(false);
    const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
    const setMobileSessionPanelOpen = React.useCallback((open: boolean) => {
        setMobileLeftDrawerOpen(open);
        useUIStore.getState().setSessionSwitcherOpen(open);
    }, []);
    const initialDrawerWidthRef = React.useRef(typeof window === 'undefined' ? 0 : window.innerWidth);

    // Left drawer motion value
    const leftDrawerX = useMotionValue(-initialDrawerWidthRef.current);
    const leftDrawerWidth = useRef(0);

    // Right drawer motion value
    const rightDrawerX = useMotionValue(initialDrawerWidthRef.current);
    const rightDrawerWidth = useRef(0);

    // Compute drawer width
    useEffect(() => {
        if (isMobile) {
            leftDrawerWidth.current = window.innerWidth;
            rightDrawerWidth.current = window.innerWidth;
        }
    }, [isMobile]);

    // Sync left drawer state and motion value
    useEffect(() => {
        if (!isMobile) {
            setMobileLeftDrawerVisible(false);
            return;
        }
        if (mobileLeftDrawerOpen) {
            setMobileLeftDrawerVisible(true);
        }
        animate(leftDrawerX, mobileLeftDrawerOpen ? 0 : -leftDrawerWidth.current, {
            type: 'spring',
            stiffness: 400,
            damping: 35,
            mass: 0.8,
        });
    }, [mobileLeftDrawerOpen, isMobile, leftDrawerX]);

    // Sync right drawer state and motion value
    useEffect(() => {
        if (!isMobile) {
            setMobileRightDrawerVisible(false);
            return;
        }
        if (mobileRightSidebarOpen) {
            setMobileRightDrawerVisible(true);
        }
        animate(rightDrawerX, mobileRightSidebarOpen ? 0 : rightDrawerWidth.current, {
            type: 'spring',
            stiffness: 400,
            damping: 35,
            mass: 0.8,
        });
    }, [isMobile, mobileRightSidebarOpen, rightDrawerX]);

    useEffect(() => {
        if (!isMobile) return;
        return leftDrawerX.on('change', (value) => {
            const width = leftDrawerWidth.current || initialDrawerWidthRef.current;
            const visible = mobileLeftDrawerOpen || value > -width + 0.5;
            setMobileLeftDrawerVisible((previous) => previous === visible ? previous : visible);
        });
    }, [isMobile, leftDrawerX, mobileLeftDrawerOpen]);

    useEffect(() => {
        if (!isMobile) return;
        return rightDrawerX.on('change', (value) => {
            const width = rightDrawerWidth.current || initialDrawerWidthRef.current;
            const visible = mobileRightSidebarOpen || value < width - 0.5;
            setMobileRightDrawerVisible((previous) => previous === visible ? previous : visible);
        });
    }, [isMobile, mobileRightSidebarOpen, rightDrawerX]);

    // Sync session switcher close events to left drawer.
    useEffect(() => {
        if (isMobile && !isSessionSwitcherOpen && mobileLeftDrawerOpen) {
            setMobileSessionPanelOpen(false);
        }
    }, [isSessionSwitcherOpen, isMobile, mobileLeftDrawerOpen, setMobileSessionPanelOpen]);

    useEffect(() => {
        if (!isMobile) {
            mobilePanelsResetRef.current = false;
            return;
        }

        if (mobilePanelsResetRef.current) {
            return;
        }

        mobilePanelsResetRef.current = true;
        setMobileSessionPanelOpen(false);
        setMobileRightSidebarOpen(false);
    }, [isMobile, setMobileSessionPanelOpen]);

    // Ensure mobile drawers are closed when opening full-screen settings
    useEffect(() => {
        if (!isMobile || !isSettingsDialogOpen) {
            return;
        }

        setMobileSessionPanelOpen(false);
        setMobileRightSidebarOpen(false);
    }, [isMobile, isSettingsDialogOpen, setMobileSessionPanelOpen]);

    useUpdatePolling();

    React.useEffect(() => workspaceEvents.onDirectoryRequest(() => {
        setDirectoryDialogOpen(true);
    }), []);

    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    const handleToggleMobileRightDrawer = React.useCallback(() => {
        if (mobileLeftDrawerOpen) {
            setMobileSessionPanelOpen(false);
        }
        setMobileRightSidebarOpen(!mobileRightSidebarOpen);
    }, [mobileLeftDrawerOpen, mobileRightSidebarOpen, setMobileSessionPanelOpen]);

    const secondaryView = React.useMemo(() => {
        // Desktop surfaces live in the context panel; the only full-view
        // overlays left there are the terminal (promoted by project actions)
        // and the diagram viewer. Mobile keeps the full tab set.
        if (!isMobile && activeMainTab !== 'terminal' && activeMainTab !== 'diagram') {
            return null;
        }
        switch (activeMainTab) {
            case 'plan':
                return <React.Suspense fallback={null}><PlanView /></React.Suspense>;
            case 'git':
                return <React.Suspense fallback={null}><GitView isActive={!mobileRightSidebarOpen} /></React.Suspense>;
            case 'diff':
                return <React.Suspense fallback={null}><DiffView /></React.Suspense>;
            case 'terminal':
                return <TerminalView />;
            case 'files':
                return <React.Suspense fallback={null}><FilesView /></React.Suspense>;
            case 'context':
                return <React.Suspense fallback={null}><ProjectContextPanel /></React.Suspense>;
            case 'diagram':
                return <React.Suspense fallback={null}><DiagramView /></React.Suspense>;
            default:
                return null;
        }
    }, [activeMainTab, isMobile, mobileRightSidebarOpen]);

    const isChatActive = activeMainTab === 'chat';
    const conversationActive = isChatActive && !isSettingsDialogOpen && !isSurfacePageOpen;
    const conversation = renderConversation
        ? renderConversation(conversationActive)
        : <RegularChatView active={conversationActive} />;

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                className={cn(
                    'main-content-safe-area',
                    isMobile ? 'flex h-[100dvh] flex-col' : 'relative flex h-[100dvh] flex-col',
                    'bg-background'
                )}
            >
                <CommandPalette />
                <PiInteractionHost />
                <HelpDialog />
                <WorkspaceOverlays />
                <WorkbenchContributionSlot kind="panel" slot="workbench.overlay" />
                <DirectoryExplorerDialog
                    open={directoryDialogOpen}
                    onOpenChange={setDirectoryDialogOpen}
                />

                {isMobile ? (
                <DrawerProvider value={{
                    leftDrawerOpen: mobileLeftDrawerOpen,
                    rightDrawerOpen: mobileRightSidebarOpen,
                    toggleLeftDrawer: () => {
                        const nextOpen = !mobileLeftDrawerOpen;
                        if (mobileRightSidebarOpen) {
                            setMobileRightSidebarOpen(false);
                        }
                        setMobileSessionPanelOpen(nextOpen);
                    },
                    toggleRightDrawer: handleToggleMobileRightDrawer,
                    leftDrawerX,
                    rightDrawerX,
                    leftDrawerWidth,
                    rightDrawerWidth,
                    setMobileLeftDrawerOpen: setMobileSessionPanelOpen,
                    setRightSidebarOpen: setMobileRightSidebarOpen,
                }}>
                    {/* Mobile: header + drawer mode */}
                    {!isSettingsDialogOpen && <Header
                        navigationTitle={navigationTitle}
                        onToggleLeftDrawer={() => {
                            const nextOpen = !mobileLeftDrawerOpen;
                            if (mobileRightSidebarOpen) {
                                setMobileRightSidebarOpen(false);
                            }
                            setMobileSessionPanelOpen(nextOpen);
                        }}
                        onToggleRightDrawer={() => {
                            handleToggleMobileRightDrawer();
                        }}
                        leftDrawerOpen={mobileLeftDrawerOpen}
                        rightDrawerOpen={mobileRightSidebarOpen}
                    />}

                    {/* Main content area (fixed) */}
                    <div
                        data-page-scroll-lock="true"
                        className={cn(
                            'flex flex-1 overflow-hidden relative',
                            isSettingsDialogOpen && 'hidden'
                        )}
                    >
                        <main className="w-full h-full overflow-hidden bg-background relative" data-page-scroll-lock="true">
                            <div className={cn('absolute inset-0', (!isChatActive || isSurfacePageOpen) && 'invisible')}>
                                <ErrorBoundary>{conversation}</ErrorBoundary>
                            </div>
                            {secondaryView && (
                                <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                                    <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                </div>
                            )}
                            {isMultiRunLauncherOpen && (
                                <div className="absolute inset-0 z-10 bg-background">
                                    <ErrorBoundary>
                                        <MultiRunLauncher
                                            initialPrompt={multiRunLauncherPrefillPrompt}
                                            onCreated={() => setMultiRunLauncherOpen(false)}
                                            onCancel={() => setMultiRunLauncherOpen(false)}
                                        />
                                    </ErrorBoundary>
                                </div>
                            )}
                            <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
                            <ErrorBoundary><ArchiveView /></ErrorBoundary>
                            <ErrorBoundary><WorktreesView /></ErrorBoundary>
                            {/* Always mount SessionSidebar on mobile to match desktop behavior.
                                Conditional mount (mobileLeftDrawerVisible && ...) caused a
                                data-loading cascade on every drawer open: paginated sessions
                                fetch, worktree discovery, repo status, PR status, and 10+ memo
                                recomputations. On Android PWA this manifested as a >10s delay
                                before the drawer became interactive (issue #1695). Visibility is
                                controlled by the leftDrawerX transform (off-screen when closed).
                                The invisible class matters when fully hidden: leftDrawerWidth is
                                not recomputed on resize/rotation, so a closed drawer translated by
                                the old width could otherwise peek into the viewport; it also keeps
                                the off-screen sidebar out of the tab order and skips painting it. */}
                            <motion.div
                                className={cn(
                                    'absolute inset-0 z-20 bg-sidebar',
                                    !mobileLeftDrawerVisible && 'pointer-events-none invisible',
                                )}
                                data-page-scroll-lock="true"
                                style={{ x: leftDrawerX }}
                                aria-hidden={!mobileLeftDrawerOpen}
                            >
                                <ErrorBoundary>
                                    <WorkbenchReplacement
                                        target={WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator}
                                        fallback={renderNavigator ? renderNavigator(mobileLeftDrawerVisible) : <PiSessionSidebar mobileVariant isVisible={mobileLeftDrawerVisible} />}
                                    />
                                </ErrorBoundary>
                            </motion.div>
                            {mobileRightDrawerVisible && (
                                <motion.div className="absolute inset-0 z-20 bg-sidebar" data-page-scroll-lock="true" style={{ x: rightDrawerX }} aria-hidden={!mobileRightSidebarOpen}>
                                    <ErrorBoundary>
                                        <React.Suspense fallback={null}><GitView isActive={mobileRightSidebarOpen} /></React.Suspense>
                                    </ErrorBoundary>
                                </motion.div>
                            )}
                        </main>
                    </div>

                    {/* Mobile settings: full screen */}
                    {isSettingsDialogOpen && (
                        <div
                            className="absolute inset-0 z-10 bg-background"
                            style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
                        >
                            <ErrorBoundary>
                                <WorkbenchReplacement
                                    target={WORKBENCH_REPLACEMENT_TARGETS.settings}
                                    fallback={(
                                        <React.Suspense fallback={null}>
                                            <SettingsView onClose={() => setSettingsDialogOpen(false)} />
                                        </React.Suspense>
                                    )}
                                />
                            </ErrorBoundary>
                        </div>
                    )}
                </DrawerProvider>
            ) : (
                <>
                    <Header navigationTitle={navigationTitle} />
                    {/* Desktop navigation and work area share the row below the titlebar. */}
                    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
                        <Sidebar
                            isOpen={isSidebarOpen}
                            isMobile={isMobile}
                            className="border-border"
                        >
                            <WorkbenchReplacement
                                target={WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator}
                                fallback={renderNavigator ? renderNavigator(isSidebarOpen) : <PiSessionSidebar isVisible={isSidebarOpen} />}
                            />
                        </Sidebar>
                        <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                            <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                                <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden border-t border-border bg-background" data-page-scroll-lock="true">
                                    <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                        <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true">
                                            <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                                <div className={cn('absolute inset-0', (!isChatActive || isSurfacePageOpen) && 'invisible')}>
                                                    <ErrorBoundary>{conversation}</ErrorBoundary>
                                                </div>
                                                {secondaryView && (
                                                    <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                                                        <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                                    </div>
                                                )}
                                                {isMultiRunLauncherOpen && (
                                                    <div className="absolute inset-0 z-10 bg-background">
                                                        <ErrorBoundary>
                                                            {/* isWindowed: the app Header already shows the surface
                                                                title, so skip the launcher's own title bar. */}
                                                            <MultiRunLauncher
                                                                isWindowed
                                                                initialPrompt={multiRunLauncherPrefillPrompt}
                                                                onCreated={() => setMultiRunLauncherOpen(false)}
                                                                onCancel={() => setMultiRunLauncherOpen(false)}
                                                            />
                                                        </ErrorBoundary>
                                                    </div>
                                                )}
                                                <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
                                                <ErrorBoundary><ArchiveView /></ErrorBoundary>
                                                <ErrorBoundary><WorktreesView /></ErrorBoundary>
                                            </main>
                                            <WorkbenchContributionSlot kind="panel" slot="workbench.secondary.before" />
                                            <WorkbenchReplacement
                                                target={WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer}
                                                fallback={<ContextPanel />}
                                            />
                                            <WorkbenchContributionSlot kind="panel" slot="workbench.secondary.after" />
                                        </div>
                                    </div>
                                </div>
                                <div data-page-scroll-lock="true">
                                    <WorkbenchContributionSlot kind="panel" slot="workbench.bottom.before" />
                                    {isContextRailOpen ? <ErrorBoundary><ContextPanelRail /></ErrorBoundary> : null}
                                    <WorkbenchContributionSlot kind="panel" slot="workbench.bottom.after" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Desktop settings: windowed dialog with blur */}
                    {settingsWindowMounted ? (
                        <WorkbenchReplacement
                            target={WORKBENCH_REPLACEMENT_TARGETS.settings}
                            fallback={(
                                <React.Suspense fallback={null}>
                                    <SettingsWindow
                                        open={isSettingsDialogOpen}
                                        onOpenChange={setSettingsDialogOpen}
                                    />
                                </React.Suspense>
                            )}
                        />
                    ) : null}
                </>
            )}

        </div>
    </DiffWorkerProvider>
    );
};
