import { afterEach, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
const boot=vi.hoisted(()=>({initialize:vi.fn()}));
vi.mock('@varin/tauri/bootstrap',()=>({initializeTauriDesktop:boot.initialize}));
import {prepareDesktopRenderer} from './desktop-bootstrap';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('blocks normal startup and shows the fixed original release recovery path for unmigrated old profiles',async()=>{
 const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
 Object.defineProperty(window,'top',{value:window,configurable:true});Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
 vi.stubGlobal('window',window);vi.stubGlobal('document',window.document);vi.stubGlobal('navigator',{language:'en'});
 boot.initialize.mockRejectedValueOnce('varin:legacy-transition-required');
 await expect(prepareDesktopRenderer()).rejects.toBe('varin:legacy-transition-required');
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('No new local service has started');
 expect(document.querySelector('a')?.getAttribute('href')).toBe('https://github.com/Youzini-afk/Varin/releases');
 expect(document.querySelector('a')?.getAttribute('target')).toBe('_blank');
});
it('does not expose arbitrary native failure text or invent a recovery executable URL',async()=>{
 const {window}=parseHTML('<html><body><div id="root"></div></body></html>');Object.defineProperty(window,'top',{value:window,configurable:true});Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
 vi.stubGlobal('window',window);vi.stubGlobal('document',window.document);vi.stubGlobal('navigator',{language:'en'});
 boot.initialize.mockRejectedValueOnce('https://untrusted.test/executable?secret=fixture');
 await expect(prepareDesktopRenderer()).rejects.toBe('https://untrusted.test/executable?secret=fixture');expect(document.body.textContent).not.toContain('secret');expect(document.querySelector('a')).toBeNull();
});
