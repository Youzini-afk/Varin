import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
type Interceptor = (details: {url:string;resourceType:string}, callback:(decision:{cancel:boolean})=>void)=>void;
type WindowFixture={options:{webPreferences:Record<string,unknown>};dead:boolean;attached:boolean;urls:string[]};
const native=vi.hoisted(()=>({ windows:[] as WindowFixture[], partitions:[] as string[], handlers:new Map<string,()=>Response>(), interceptor:undefined as Interceptor|undefined, failCookie:false, failScheme:'', commands:[] as Array<[string,unknown]> }));
vi.mock('electron',()=>({
 session:{fromPartition:(name:string)=>{native.partitions.push(name);return{
  protocol:{handle:async(scheme:string,handler:()=>Response)=>{if(native.failScheme===scheme)throw Error('fixture');native.handlers.set(scheme,handler);},unhandle:(scheme:string)=>native.handlers.delete(scheme)},
  webRequest:{onBeforeRequest:(callback:Interceptor)=>{native.interceptor=callback;}},setPermissionRequestHandler:vi.fn(),
 };}},
 BrowserWindow:class extends EventEmitter {
  dead=false;attached=false;urls:string[]=[];
  webContents={setWindowOpenHandler:vi.fn(),on:vi.fn(),debugger:{attach:()=>{this.attached=true;},isAttached:()=>this.attached,detach:()=>{this.attached=false;},sendCommand:async(method:string,params:unknown)=>{
   native.commands.push([method,params]);if(method==='Storage.getCookies'){if(native.failCookie)throw Error('fixture');return{cookies:[{name:'session',value:'synthetic',domain:'.example.test',path:'/',httpOnly:true,partitionKey:{topLevelSite:'https://embed.test',hasCrossSiteAncestor:true}}]};}
   if(method==='DOMStorage.getDOMStorageItems')return{entries:[['token','synthetic-storage']]};if(method==='IndexedDB.requestDatabaseNames')return{databaseNames:['original-db']};return{};
  }}};
  constructor(readonly options:{webPreferences:Record<string,unknown>}){super();native.windows.push(this);}async loadURL(url:string){this.urls.push(url);}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.emit('closed');}
 }
}));
import {legacyBrowserOrigins,openLegacyBrowserExport} from './legacy-browser-export.js';
beforeEach(()=>{native.windows=[];native.partitions=[];native.handlers.clear();native.failCookie=false;native.failScheme='';native.commands=[];});
it('reads the original native BrowserUse context, keeps partition authority and blocks real site code/network',async()=>{
 const reader=await openLegacyBrowserExport();expect(native.partitions).toEqual(['persist:varin-browser']);expect(native.windows[0]!.options.webPreferences).toMatchObject({sandbox:true,nodeIntegration:false,contextIsolation:true});
 const response=native.handlers.get('https')!();expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'none'");expect(await response.text()).not.toContain('<script');
 const decision=vi.fn();native.interceptor!({url:'https://example.test/network',resourceType:'xhr'},decision);expect(decision).toHaveBeenLastCalledWith({cancel:true});
 native.interceptor!({url:'https://example.test/.varin-migration.html',resourceType:'mainFrame'},decision);expect(decision).toHaveBeenLastCalledWith({cancel:false});
 expect(reader.cookies[0]).toMatchObject({httpOnly:true,partitionKey:{hasCrossSiteAncestor:true}});
 const values=[];for await(const value of reader.origins(['https://example.test']))values.push(value);
 expect(values).toMatchObject([{localStorage:[['token','synthetic-storage']],indexedDbDatabases:['original-db'],serviceWorkers:'not-exported'}]);
 expect(native.commands).toContainEqual(['Network.setBypassServiceWorker',{bypass:true}]);expect(native.windows[0]!.urls).toEqual(['about:blank','https://example.test/.varin-migration.html']);
 await reader.close();expect(native.windows[0]!.dead).toBe(true);expect(native.windows[0]!.attached).toBe(false);expect(native.handlers.size).toBe(0);
});
it('cleans its original surface/interceptors if native inventory or partial scheme setup fails',async()=>{
 native.failCookie=true;await expect(openLegacyBrowserExport()).rejects.toThrow();expect(native.windows[0]!.dead).toBe(true);expect(native.handlers.size).toBe(0);
 native.failCookie=false;native.failScheme='https';await expect(openLegacyBrowserExport()).rejects.toThrow();expect(native.handlers.size).toBe(0);expect(native.windows).toHaveLength(1);
});
it('discovers only known cookie/partition and saved browser origins, never application or credential-bearing URLs',()=>{
 expect(legacyBrowserOrigins([{domain:'[::1]',sourcePort:8443,sourceScheme:'Secure',partitionKey:{topLevelSite:'https://embed.test'}}],[['varin.ui.v1',JSON.stringify({browser:{url:'https://saved.test/a'}})],['unrelated',JSON.stringify({url:'https://not-known.test'})],['varin.editor-workbench:x',JSON.stringify({url:'https://secret@private.test/'})]])).toEqual(['http://[::1]','https://[::1]','https://[::1]:8443','https://embed.test','https://saved.test']);
});
