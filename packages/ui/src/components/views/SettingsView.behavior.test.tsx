import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { registerSettingsDraft, stayInSettings, getPendingSettingsNavigation, finishSettingsNavigation } from '@/lib/settings/drafts';
import { SettingsView } from './SettingsView';
import { SettingsWindow } from './SettingsWindow';
import { SettingsTitlebar } from '@/components/layout/SettingsTitlebar';
import type { SettingsPageRegistration } from '@/lib/settings/page-types';

const registrations: SettingsPageRegistration[] = ['general','projects','model-roles','about'].map(slug => ({
  contributionId: slug, meta: { slug, title:slug, kind: slug==='projects' ? 'split':'single', group:'general', order:1, icon:'stack' },
  implementation: { renderContent: () => <p>{slug} content</p>, renderSidebar: ({ onItemSelect }) => <button onClick={onItemSelect}>Project A</button> },
}));
vi.mock('@/lib/settings/surface-registry', () => ({ useSettingsPageRegistrations: () => registrations }));
vi.mock('@/lib/settings/metadata', () => ({ getSettingsPageMeta: (slug:string) => registrations.find(page=>page.meta.slug===slug)?.meta, getSettingsNavIcon: () => 'stack', resolveSettingsSlug: (slug:string) => slug }));
vi.mock('@/lib/settings/search', () => ({ buildSettingsSearchResults: () => [] }));
vi.mock('@/components/sections/shared/SettingsDraftDialog', () => ({ SettingsDraftDialog: () => null }));
vi.mock('@/components/motion/SwapText', () => ({SwapText: ({text}:{text:string}) => <span>{text}</span>}));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({children}:React.PropsWithChildren) => children, TooltipTrigger: ({children}:React.PropsWithChildren) => children, TooltipContent: () => null }));
vi.mock('@/lib/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/lib/device', () => ({useDeviceInfo: () => ({isMobile:false})}));
vi.mock('@/hooks/useDesktopWindowControlsLayout', () => ({ useDesktopWindowControlsLayout: () => ({ usesFramelessChrome: false, side: 'right' }) }));
vi.mock('@/lib/settings/service-identity', () => ({ useServiceIdentity: () => null }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({usePrefersReducedMotion:()=>true}));
vi.mock('@/components/icon/Icon', () => ({Icon:()=>null}));
let root: Root; let container: HTMLElement; let width=1280;
beforeEach(() => {
  const {window,document} = parseHTML('<html><body><div id="app"></div></body></html>');
  for(const [key,val] of Object.entries({window,document,HTMLElement:window.HTMLElement,Element:window.Element,IS_REACT_ACT_ENVIRONMENT:true})) vi.stubGlobal(key,val);
  vi.stubGlobal('innerWidth', 1280);
  window.matchMedia=((query:string)=>({matches:width <= Number(query.match(/max-width: (\d+)/)?.[1] || 0),addEventListener:()=>{},removeEventListener:()=>{}})) as unknown as typeof window.matchMedia;
  container=document.getElementById('app')!; root=createRoot(container); width=1280; useUIStore.getState().setSettingsPage('general');
});
afterEach(async()=>{ await act(async()=>root.unmount()); stayInSettings(); vi.unstubAllGlobals(); });
function click(text:string) { const item=[...container.querySelectorAll('button')].find(button=>button.textContent===text || button.getAttribute('aria-label')===text); expect(item,text).toBeDefined(); return act(async()=>item!.click()); }
function escape() { const event=new window.Event('keydown',{bubbles:true,cancelable:true}); Object.assign(event,{key:'Escape'}); return act(async()=>document.dispatchEvent(event)); }
const shell = () => container.querySelector<HTMLElement>('[data-settings-view]')!;
const catalog = () => container.querySelector<HTMLElement>('.sk-cat')!;

it('uses one workspace surface, shows localized groups, and guards Escape and Return before leaving a live draft',async()=>{
  const close=vi.fn(); await act(async()=>root.render(<><SettingsTitlebar leftInset="0px" /><SettingsWindow onClose={close}/></>));
  expect(container.querySelector('main [data-settings-view]')).not.toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const retainedMenu = document.createElement('div');
  retainedMenu.setAttribute('inert', '');
  retainedMenu.innerHTML = '<div role="menu"></div>';
  container.append(retainedMenu);
  expect([...container.querySelectorAll('.sk-gt')].map(el=>el.textContent)).toContain('settings.view.nav.group.models');
  await click('model-roles'); expect(container.textContent).toContain('model-roles content');
  const dispose=registerSettingsDraft('fixture',()=>({dirty:true,saving:false,saveDisabled:false,onCancel:()=>{}}));
  try {
    const canvas = container.querySelector('.sk-canvas');
    await click('model-roles');
    expect(container.querySelector('.sk-canvas')).toBe(canvas);
    await escape(); expect(close).not.toHaveBeenCalled(); expect(getPendingSettingsNavigation()).not.toBeNull();
    stayInSettings(); await click('settings.shell.back'); expect(close).not.toHaveBeenCalled();
    await act(async()=>{await finishSettingsNavigation(false);}); expect(close).toHaveBeenCalledOnce();
  } finally {dispose();}
});
it('keeps phone drill-down reversible and can reopen the same split page after Back',async()=>{
  width=390; useUIStore.getState().setSettingsPage('home');
  const close=vi.fn(); const back=React.createRef<(()=>void)|null>();
  await act(async()=>root.render(<SettingsView onClose={close} backActionRef={back} forceMobile/>));
  await click('projects'); expect(catalog().dataset.mstage).toBe('list');
  await click('Project A'); expect(catalog().dataset.mstage).toBe('detail');
  await act(async()=>back.current?.()); expect(catalog().dataset.mstage).toBe('list');
  await act(async()=>back.current?.()); expect(shell().dataset.stage).toBe('nav');
  await click('projects'); expect(catalog().dataset.mstage).toBe('list');
  await act(async()=>back.current?.()); await act(async()=>back.current?.()); expect(close).toHaveBeenCalledOnce();
});
it('gives a narrow desktop both object panes without keeping the settings navigation visible',async()=>{
  width=820; vi.stubGlobal('innerWidth', width); useUIStore.getState().setSettingsPage('projects');
  await act(async()=>root.render(<SettingsView onClose={vi.fn()}/>));
  expect(container.textContent).toContain('Project A'); expect(container.textContent).toContain('projects content');
  expect(shell().dataset.settingsLayout).toBe('narrow');
  expect(shell().dataset.stage).toBe('page');
  await click('settings.view.actions.backToSettings'); expect(shell().dataset.stage).toBe('nav');
});
