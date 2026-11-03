import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FRONTEND_RECOVERED_DRAFTS_KEY, NATIVE_MIGRATION_RECOVERY_KEY } from '@varin/application-client/desktop';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
const recoveryBrowser=vi.hoisted(()=>({open:vi.fn(),settings:vi.fn(),tab:vi.fn(),invoke:vi.fn(async()=>({packs:[]}))}));
vi.mock('@/lib/desktop',()=>({invokeDesktop:recoveryBrowser.invoke}));
vi.mock('@/stores/useDirectoryStore',()=>({useDirectoryStore:(selector:(state:{currentDirectory:string})=>unknown)=>selector({currentDirectory:'/work'})}));
vi.mock('@/stores/useUIStore',()=>({useUIStore:{getState:()=>({openContextBrowser:recoveryBrowser.open,setSettingsPage:recoveryBrowser.settings,setSettingsDialogOpen:recoveryBrowser.tab})}}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useThreadStore', () => ({
  useThreadStore: (selector: (state: unknown) => unknown) => selector({ selectedDraftKey: 'current' }), selectedComposerKey: (state: {
    selectedDraftKey: string;
  }) => state.selectedDraftKey
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: {
    open: boolean;
    children: React.ReactNode;
  }) => open ? <div>{children}</div> : null, DialogContent: ({ children }: {
    children: React.ReactNode;
  }) => <div>{children}</div>, DialogHeader: ({ children }: {
    children: React.ReactNode;
  }) => <div>{children}</div>, DialogTitle: ({ children }: {
    children: React.ReactNode;
  }) => <h2>{children}</h2>, DialogDescription: ({ children }: {
    children: React.ReactNode;
  }) => <p>{children}</p>
}));
import { DesktopMigrationRecovery } from './DesktopMigrationRecovery';
let root: Root;
let container: HTMLElement;
beforeEach(() => { vi.clearAllMocks();const { window } = parseHTML('<html><body><div id="root"></div></body></html>'); vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }); container = document.getElementById('root')!; root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); delete window.__VARIN_DESKTOP_RUNTIME__; useThreadDraftStore.setState({ drafts: {} }); vi.unstubAllGlobals(); });
const click = (text: string) => { const button = [...container.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeTruthy(); act(() => button!.click()); };
const render = () => act(() => root.render(<DesktopMigrationRecovery />));
it('keeps migrated queues inspectable and inserts only text after the user chooses, without sending or destroying recovery', () => {
  window.__VARIN_DESKTOP_RUNTIME__ = { runtime: 'tauri', arch: 'x64', macVibrancy: false, macVibrancySupported: false, trayEnabled: false };
  localStorage.setItem(FRONTEND_RECOVERED_DRAFTS_KEY, JSON.stringify({ schema: 1, drafts: [{ target: 'host/workspace/thread', message: { id: 'queued', content: 'Review these findings', attachments: [{ filename: 'paper.pdf' }] } }] }));
  useThreadDraftStore.getState().patch('current', { text: 'Existing draft' });
  render();
  expect(useThreadDraftStore.getState().drafts.current?.text).toBe('Existing draft');
  click('desktopMigration.review');
  expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('desktopMigration.draft');
  click('desktopMigration.insert');
  expect(useThreadDraftStore.getState().drafts.current?.text).toBe('Existing draft\n\nReview these findings');
  expect(useThreadDraftStore.getState().drafts.current?.files).toBeUndefined();
  expect(localStorage.getItem(FRONTEND_RECOVERED_DRAFTS_KEY)).toContain('Review these findings');
  click('desktopMigration.review');
  click('desktopMigration.dismiss');
  expect(JSON.parse(localStorage.getItem(FRONTEND_RECOVERED_DRAFTS_KEY)!).drafts).toEqual([]);
});
it('does not install a migration UI in ordinary Web even if an unrelated origin has the same storage key', () => { localStorage.setItem(FRONTEND_RECOVERED_DRAFTS_KEY, JSON.stringify({ schema: 1, drafts: [{ target: 'x', message: { content: 'not desktop' } }] })); render(); expect(container.textContent).toBe(''); });

it('explains the intentional browser reset without offering failed-import repairs or opening sites',()=>{
 window.__VARIN_DESKTOP_RUNTIME__={runtime:'tauri',arch:'x64',macVibrancy:false,macVibrancySupported:false,trayEnabled:false};
 localStorage.setItem(NATIVE_MIGRATION_RECOVERY_KEY,JSON.stringify({schema:1,credentialSlotsPending:[],browserStatus:'not-migrated',browserRequiresLogin:true}));
 render();expect(recoveryBrowser.open).not.toHaveBeenCalled();click('desktopMigration.review');
 expect(container.textContent).toContain('desktopMigration.browserReset');expect(container.textContent).not.toContain('desktopMigration.credentials');
 expect(container.textContent).not.toContain('desktopMigration.openSite');
 click('desktopMigration.closeNotice');expect(JSON.parse(localStorage.getItem(NATIVE_MIGRATION_RECOVERY_KEY)!).browserNoticeAcknowledged).toBe(true);
 expect(recoveryBrowser.open).not.toHaveBeenCalled();
});

it('keeps failed artwork recoverable without blocking the workbench or automatically starting a download',async()=>{
 window.__VARIN_DESKTOP_RUNTIME__={runtime:'tauri',arch:'x64',macVibrancy:false,macVibrancySupported:false,trayEnabled:false};
 localStorage.setItem(NATIVE_MIGRATION_RECOVERY_KEY,JSON.stringify({schema:1,credentialSlotsPending:['sttApiKey'],browserStatus:'not-migrated',browserRequiresLogin:true,companionFailures:[{id:'varin',reason:'asset-integrity'}]}));
 render();click('desktopMigration.review');expect(container.textContent).toContain('desktopMigration.packIntegrity');expect(container.textContent).toContain('desktopMigration.browserReset');expect(recoveryBrowser.invoke).not.toHaveBeenCalled();
 await act(async()=>{click('desktopMigration.retryPack: varin');await Promise.resolve();});
 expect(recoveryBrowser.invoke).toHaveBeenCalledWith('desktop_companion_library',{action:'download',id:'varin'});expect(recoveryBrowser.settings).toHaveBeenCalledWith('companion');expect(recoveryBrowser.tab).toHaveBeenCalledWith(true);
 expect(localStorage.getItem(NATIVE_MIGRATION_RECOVERY_KEY)).toContain('asset-integrity');
 click('desktopMigration.review');click('desktopMigration.openVoice');expect(recoveryBrowser.settings).toHaveBeenCalledWith('voice');
});
