import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { registerSettingsDraft, stayInSettings, getPendingSettingsNavigation, finishSettingsNavigation } from '@/lib/settings/drafts';
import { SettingsView } from './SettingsView';
import { SettingsWindow } from './SettingsWindow';
import type { SettingsPageRegistration } from '@/lib/settings/page-types';

const registrations: SettingsPageRegistration[] = ['general','projects','model-roles','about'].map(slug => ({
  contributionId: slug, meta: { slug, title:slug, kind: slug==='projects' ? 'split':'single', group:'general', order:1, icon:'stack' },
  implementation: { renderContent: () => <p>{slug} content</p>, renderSidebar: ({ onItemSelect }) => <button onClick={onItemSelect}>Project A</button> },
}));
vi.mock('@/lib/settings/surface-registry', () => ({ useSettingsPageRegistrations: () => registrations }));
vi.mock('@/lib/settings/metadata', () => ({ getSettingsPageMeta: (slug:string) => registrations.find(page=>page.meta.slug===slug)?.meta, getSettingsNavIcon: () => 'stack', resolveSettingsSlug: (slug:string) => slug }));
vi.mock('@/lib/settings/search', () => ({ buildSettingsSearchResults: () => [] }));
vi.mock('./settingsMotion', () => ({ useNavPill: () => {}, staggerSettingsPage: () => {} }));
vi.mock('@/components/sections/shared/SettingsDraftDialog', () => ({ SettingsDraftDialog: () => null }));
vi.mock('@/components/motion/SwapText', () => ({SwapText: ({text}:{text:string}) => <span>{text}</span>}));
vi.mock('motion/react', () => ({ AnimatePresence: ({children}:React.PropsWithChildren) => children, motion:{div: ({children}:React.PropsWithChildren) => <div>{children}</div>}, useIsPresent:()=>true }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({children}:React.PropsWithChildren) => children, TooltipTrigger: ({children}:React.PropsWithChildren) => children }));
vi.mock('@/lib/i18n', () => ({useI18n: () => ({ t: (key:string)=>key })}));
vi.mock('@/lib/device', () => ({useDeviceInfo: () => ({isMobile:false})}));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({usePrefersReducedMotion:()=>true}));
vi.mock('@/components/icon/Icon', () => ({Icon:()=>null}));
let root: Root; let container: HTMLElement; let width=1280;
beforeEach(() => {
  const {window,document} = parseHTML('<html><body><div id="app"></div></body></html>');
  for(const [key,val] of Object.entries({window,document,HTMLElement:window.HTMLElement,Element:window.Element,IS_REACT_ACT_ENVIRONMENT:true})) vi.stubGlobal(key,val);
  window.matchMedia=((query:string)=>({matches:width <= Number(query.match(/max-width: (\d+)/)?.[1] || 0),addEventListener:()=>{},removeEventListener:()=>{}})) as unknown as typeof window.matchMedia;
  container=document.getElementById('app')!; root=createRoot(container); width=1280; useUIStore.getState().setSettingsPage('general');
});
afterEach(async()=>{ await act(async()=>root.unmount()); stayInSettings(); vi.unstubAllGlobals(); });
function click(text:string) { const item=[...container.querySelectorAll('button')].find(button=>button.textContent===text || button.getAttribute('aria-label')===text); expect(item,text).toBeDefined(); return act(async()=>item!.click()); }
function escape() { const event=new window.Event('keydown',{bubbles:true,cancelable:true}); Object.assign(event,{key:'Escape'}); return act(async()=>document.dispatchEvent(event)); }

it('uses one workspace surface, shows localized groups, and guards Escape and Return before leaving a live draft',async()=>{
  const close=vi.fn(); await act(async()=>root.render(<SettingsWindow onClose={close}/>));
  expect(container.querySelector('main [data-settings-view]')).not.toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect([...container.querySelectorAll('summary')].map(el=>el.textContent)).toContain('settings.view.nav.group.models');
  await click('model-roles'); expect(container.textContent).toContain('model-roles content');
  const dispose=registerSettingsDraft('fixture',()=>({dirty:true,saving:false,saveDisabled:false,onCancel:()=>{}}));
  try {
    await escape(); expect(close).not.toHaveBeenCalled(); expect(getPendingSettingsNavigation()).not.toBeNull();
    stayInSettings(); await click('settings.shell.return'); expect(close).not.toHaveBeenCalled();
    await act(async()=>{await finishSettingsNavigation(false);}); expect(close).toHaveBeenCalledOnce();
  } finally {dispose();}
});
it('keeps phone drill-down reversible and can reopen the same split page after Back',async()=>{
  width=390; useUIStore.getState().setSettingsPage('home');
  const close=vi.fn(); const back=React.createRef<(()=>void)|null>();
  await act(async()=>root.render(<SettingsView onClose={close} backActionRef={back}/>));
  await click('projects'); await click('Project A'); expect(container.textContent).toContain('projects content');
  await act(async()=>back.current?.()); expect(container.textContent).toContain('Project A');
  await act(async()=>back.current?.()); await click('projects'); expect(container.textContent).toContain('Project A');
  await act(async()=>back.current?.()); await act(async()=>back.current?.()); expect(close).toHaveBeenCalledOnce();
});
it('gives a narrow desktop both object panes without keeping the settings navigation visible',async()=>{
  width=820; useUIStore.getState().setSettingsPage('projects');
  await act(async()=>root.render(<SettingsView onClose={vi.fn()}/>));
  expect(container.textContent).toContain('Project A'); expect(container.textContent).toContain('projects content');
  expect(container.querySelector('summary')).toBeNull();
  await click('settings.view.actions.backToSettings'); expect(container.querySelector('summary')).not.toBeNull();
});
