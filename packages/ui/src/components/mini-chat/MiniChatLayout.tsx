import React from 'react';
import { Button } from '@/components/ui/button';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { ThreadSwitcherDropdown } from '@/components/thread/ThreadSwitcherDropdown';
import { ChatView } from '@/components/views/ChatView';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { Icon } from '@/components/icon/Icon';

export function MiniChatLayout({ unavailable }: { unavailable?: string }) {
  const identity = useThreadStore(state => state.selectedIdentity);
  const summary = useThreadStore(state => state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId));
  const directory = useDirectoryStore(state => state.currentDirectory);
  const [pinned, setPinned] = React.useState(false);
  const { usesFramelessChrome, side } = useDesktopWindowControlsLayout();
  const mac = typeof window !== 'undefined' && (window.__VARIN_MACOS_MAJOR__ ?? 0) > 0;
  React.useEffect(() => { if (isElectronShell()) void invokeDesktop('desktop_get_window_pinned').then(result => setPinned(result?.pinned ?? false)); }, []);
  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  const openMain = () => { void invokeDesktop('desktop_focus_main_window', identity ? { threadId: identity.threadId, branchId: identity.branchId, directory: directory || '' }
    : { mode: 'draft', directory: directory || '' }).then(result => result?.focused ? invokeDesktop('desktop_close_current_window') : null); };
  return <div className="flex h-full min-h-0 flex-col">
    <header style={drag} className={`flex h-14 shrink-0 items-center gap-2 pr-3 ${mac ? 'pl-24' : 'pl-3'}`}>
      <WindowsWindowControls visible={usesFramelessChrome && side === 'left'} position="left" />
      <ThreadSwitcherDropdown><button style={noDrag} className="min-w-0 flex-1 truncate text-left" aria-label="Switch conversation">{summary?.title || 'New conversation'}</button></ThreadSwitcherDropdown>
      <Button style={noDrag} variant="ghost" size="icon" aria-label={pinned ? 'Unpin window' : 'Pin window'} onClick={() => {
        void invokeDesktop('desktop_set_window_pinned', { pinned: !pinned }).then(result => setPinned(result?.pinned ?? pinned));
      }}><Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-4" /></Button>
      <Button style={noDrag} variant="ghost" size="icon" aria-label="Open in main window" onClick={openMain}><Icon name="external-link" className="size-4" /></Button>
      <WindowsWindowControls visible={usesFramelessChrome && side === 'right'} position="right" />
    </header>
    <main className="min-h-0 flex-1">{unavailable ? <p role="alert" className="p-6">{unavailable}</p> : <ChatView />}</main>
  </div>;
}
