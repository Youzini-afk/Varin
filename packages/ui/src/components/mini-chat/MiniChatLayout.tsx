import React from 'react';
import { Button } from '@/components/ui/button';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { ThreadSwitcherDropdown } from '@/components/thread/ThreadSwitcherDropdown';
import { ChatView } from '@/components/views/ChatView';
import { invokeDesktop, isDesktopShell } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { Icon } from '@/components/icon/Icon';

export function MiniChatLayout({ unavailable }: { unavailable?: string }) {
  const identity = useThreadStore(state => state.selectedIdentity);
  const summary = useThreadStore(state => state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId));
  const directory = useDirectoryStore(state => state.currentDirectory);
  const projectId = useProjectsStore(state => state.activeProjectId);
  const [pinned, setPinned] = React.useState(false);
  const [openingMain, setOpeningMain] = React.useState(false);
  const opening = React.useRef(false);
  const [windowError, setWindowError] = React.useState<string>();
  const { usesFramelessChrome, side } = useDesktopWindowControlsLayout();
  const mac = typeof window !== 'undefined' && (window.__VARIN_MACOS_MAJOR__ ?? 0) > 0;
  React.useEffect(() => { if (isDesktopShell()) void invokeDesktop('desktop_get_window_pinned').then(result => setPinned(result?.pinned ?? false)).catch(() => {}); }, []);
  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  const openMain = async () => {
    if (opening.current) return;
    opening.current = true;
    setOpeningMain(true);
    setWindowError(undefined);
    try {
      const result = await invokeDesktop('desktop_focus_main_window', identity
        ? { threadId: identity.threadId, branchId: identity.branchId, directory: directory || '' }
        : { mode: 'draft', directory: directory || '', projectId: projectId || '' });
      if (!result?.focused) throw new Error('The main window could not be opened.');
      await invokeDesktop('desktop_close_current_window');
    } catch (error) {
      setWindowError(error instanceof Error ? error.message : 'The main window could not be opened.');
    } finally {
      opening.current = false;
      setOpeningMain(false);
    }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <header style={drag} className={`flex h-14 shrink-0 items-center gap-2 pr-3 ${mac ? 'pl-24' : 'pl-3'}`}>
      <WindowsWindowControls visible={usesFramelessChrome && side === 'left'} position="left" />
      <ThreadSwitcherDropdown><button style={noDrag} className="min-w-0 flex-1 truncate text-left" aria-label="Switch conversation">{summary?.title || 'New conversation'}</button></ThreadSwitcherDropdown>
      <Button style={noDrag} variant="ghost" size="icon" aria-label={pinned ? 'Unpin window' : 'Pin window'} onClick={() => {
        void invokeDesktop('desktop_set_window_pinned', { pinned: !pinned }).then(result => setPinned(result?.pinned ?? pinned)).catch(error => setWindowError(error instanceof Error ? error.message : 'The window could not be pinned.'));
      }}><Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-4" /></Button>
      <Button style={noDrag} variant="ghost" size="icon" aria-label="Open in main window" disabled={openingMain} onClick={() => { void openMain(); }}><Icon name="external-link" className="size-4" /></Button>
      <WindowsWindowControls visible={usesFramelessChrome && side === 'right'} position="right" />
    </header>
    {windowError && <p role="alert" className="px-3 py-2 text-destructive">{windowError}</p>}
    <main className="min-h-0 flex-1">{unavailable ? <p role="alert" className="p-6">{unavailable}</p> : <ChatView />}</main>
  </div>;
}
