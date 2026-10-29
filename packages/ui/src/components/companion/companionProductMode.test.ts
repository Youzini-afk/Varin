import { expect, it } from 'vitest';
import { defaultVarinWorkbenchProfileDocument, VARIN_WORKBENCH_BOT_PROFILE_ID, type VarinExtensionHostStateSnapshot } from '@varin/extension-contract';
import { VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION, VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION } from '@varin/extension-builtins';
import { builtinWorkbenchEntry } from '@/lib/extensions/builtin-workbench.test-support';
import { companionProductMode } from './companionProductMode';
function snapshot(): VarinExtensionHostStateSnapshot {
 const hostId='test-product-host';
 return { revision:1, catalog:{ authoritative:true,diagnostics:[],extensions:[builtinWorkbenchEntry(VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION),builtinWorkbenchEntry(VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION)],hostId,loadedAt:'2026-10-29T00:00:00Z',revision:1,schemaVersion:1,storageState:'ready' },
 workbench:{authoritative:true,diagnostics:[],document:defaultVarinWorkbenchProfileDocument(),hostId,storageState:'ready'},
 routing:{authoritative:true,diagnostics:[],document:{revision:0,rules:[],schemaVersion:1,updatedAt:'2026-10-29T00:00:00Z'},hostId,storageState:'ready'},services:{hostId,providers:[],revision:0} };
}
it('resolves actual authoritative Agent and user-selected Bot profile, not thread runtime or branch names',()=>{
 const state=snapshot();expect(companionProductMode(state)).toBe('agent-companion');
 state.workbench.document.profileSelections.users.default=VARIN_WORKBENCH_BOT_PROFILE_ID;
 expect(companionProductMode(state)).toBe('bot-coordinator');
 state.workbench.document.profileSelections.users.default='default';expect(companionProductMode(state)).toBe('agent-companion');
});
it('does not invent a mode from incomplete or disabled workbench state',()=>{
 expect(companionProductMode(null)).toBe('unknown');
 const state=snapshot();state.workbench.authoritative=false;expect(companionProductMode(state)).toBe('unknown');
 state.workbench.authoritative=true;state.catalog.extensions[0]!.desired.enabled=false;expect(companionProductMode(state)).toBe('unknown');
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, vi } from 'vitest';
import type { ExtensionsAPI } from '@varin/application-client';
import { useCompanionProductMode } from './useCompanionProductMode';
let root: Root | undefined;
afterEach(()=>{ if(root)act(()=>root!.unmount());root=undefined;vi.unstubAllGlobals(); });
function environment(){const {window}=parseHTML('<html><body><div id="root"></div></body></html>');vi.stubGlobal('window',window);vi.stubGlobal('document',window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);root=createRoot(document.getElementById('root')!);}
function Probe({api,generation}:{api:ExtensionsAPI;generation:number}){return React.createElement('span',null,useCompanionProductMode(api,generation));}
it('updates the companion from the existing Host workbench long-poll without a local mode toggle',async()=>{
 environment();let next!:(s:VarinExtensionHostStateSnapshot)=>void;
 const api={hostState:vi.fn(async()=>snapshot()),waitForHostState:vi.fn(()=>new Promise<VarinExtensionHostStateSnapshot>(resolve=>{next=resolve;}))} as unknown as ExtensionsAPI;
 await act(async()=>{root!.render(React.createElement(Probe,{api,generation:1}));});
 expect(document.body.textContent).toBe('agent-companion');
 const bot=snapshot();bot.revision=2;bot.workbench.document.profileSelections.users.default=VARIN_WORKBENCH_BOT_PROFILE_ID;
 await act(async()=>next(bot));expect(document.body.textContent).toBe('bot-coordinator');
 expect(api.waitForHostState).toHaveBeenLastCalledWith({hostId:bot.catalog.hostId,revision:2},expect.any(AbortSignal));
});
it('rejects a late response from the previous authenticated Host generation',async()=>{
 environment();let old!:(s:VarinExtensionHostStateSnapshot)=>void;
 const api={hostState:vi.fn().mockImplementationOnce(()=>new Promise<VarinExtensionHostStateSnapshot>(resolve=>{old=resolve;})).mockResolvedValue(snapshot()),waitForHostState:vi.fn(()=>new Promise(()=>{}))} as unknown as ExtensionsAPI;
 await act(async()=>{root!.render(React.createElement(Probe,{api,generation:1}));});expect(document.body.textContent).toBe('unknown');
 await act(async()=>{root!.render(React.createElement(Probe,{api,generation:2}));});expect(document.body.textContent).toBe('agent-companion');
 const bot=snapshot();bot.workbench.document.profileSelections.users.default=VARIN_WORKBENCH_BOT_PROFILE_ID;
 await act(async()=>old(bot));expect(document.body.textContent).toBe('agent-companion');
});
