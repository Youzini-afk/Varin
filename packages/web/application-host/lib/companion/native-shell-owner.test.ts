import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeShellCompanionOwner } from './native-shell-owner.js';
import type { DesktopNativePort } from '../platform/desktop-host-session.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'varin-companion-'));roots.push(root);const frontend=path.join(root,'frontend');await mkdir(frontend);
 const bytes=Buffer.from('{"packages":[]}'),files=[{path:'bundle.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}],version=createHash('sha256').update(JSON.stringify(files)).digest('hex');
 await writeFile(path.join(frontend,'companion-catalog.json'),JSON.stringify({schemaVersion:1,packs:[{id:'test',name:'Test',version,bytes:bytes.length,baseUrl:'https://assets.example.test/',files}]}));
 type Window={revision:number;id:number;label:string;role:string;bounds:{x:number;y:number;width:number;height:number};contentBounds:{x:number;y:number;width:number;height:number};visible:boolean;minimized:boolean;alwaysOnTop:boolean;destroyed:boolean};
 const windows=new Map<number,Window>(),calls:{method:string;args:Record<string,unknown>}[]=[],listeners=new Set<(event:string,payload:unknown)=>void>(),readiness=new Map<number,()=>void>();
 let cursor={x:100,y:100},closeGate:Promise<void>|undefined;
 const port:DesktopNativePort={subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},async request(method,input){const args=input as Record<string,unknown>;calls.push({method,args});const id=Number(args.id),window=windows.get(id);
  if(method==='companion.snapshot')return{windows:[...windows.values()],displays:[{id:1,workArea:{x:0,y:0,width:1200,height:900}},{id:2,workArea:{x:1200,y:0,width:1600,height:1000}}],primaryId:1,cursor,platform:'win32'};
  if(method==='companion.create'){const bounds=args.bounds as Window['bounds'],value={id,revision:1,label:`companion-${id}`,role:String(args.role),bounds,contentBounds:bounds,visible:false,minimized:false,alwaysOnTop:false,destroyed:false};windows.set(id,value);return value;}
  if(method==='companion.close'){await closeGate;if(window){windows.delete(id);for(const l of listeners)l('companion.native',{kind:'closed',id});}return null;}
  if(!window)throw new Error('Native companion is closed');
  if(method==='companion.update'){window.revision++;if(args.bounds){window.bounds=args.bounds as Window['bounds'];window.contentBounds=window.bounds;}if(typeof args.visible==='boolean')window.visible=args.visible;if(typeof args.alwaysOnTop==='boolean')window.alwaysOnTop=args.alwaysOnTop;return {...window};}
  if(method==='companion.ready')return new Promise<void>(resolve=>readiness.set(id,resolve));
  if(method==='companion.publish'||method==='companion.stoolVisible')return null;
  throw new Error(`Unknown native operation ${method}`);
 }};
 const owner=createNativeShellCompanionOwner({port,dataDirectory:root,frontendDirectory:frontend,fetch:vi.fn(async()=>new Response(bytes))});
 const invoke=(command:string,args:unknown={},windowLabel='main')=>owner.invoke({command,args,windowLabel});
 await invoke('desktop_companion_library',{action:'download',id:'test'});
 await vi.waitFor(async()=>{const library=await invoke('desktop_companion_library',{action:'list'}) as {packs:{installedVersion:string|null}[]};expect(library.packs[0]?.installedVersion).toBe(version);});
 await invoke('desktop_companion_library',{action:'select',id:'test'});
 const wake=async()=>{const showing=invoke('desktop_set_companion',{enabled:true});await vi.waitFor(()=>expect([...windows.values()].some(w=>w.role==='companion')).toBe(true));const main=[...windows.values()].find(w=>w.role==='companion')!;await invoke('desktop_companion_presented',{status:'ready'},main.label);await showing;return main;};
 return{root,version,bytes,owner,invoke,wake,windows,calls,readiness,cursor:(v:typeof cursor)=>{cursor=v;},holdClose:()=>{let release!:()=>void;closeGate=new Promise<void>(resolve=>{release=resolve;});return release;}};
}
it('waits for actual artwork paint and isolates sender authority and installed assets',async()=>{
 const f=await fixture();let done=false;const waking=f.invoke('desktop_set_companion',{enabled:true}).then(()=>{done=true;});await vi.waitFor(()=>expect(f.windows.size).toBe(1));await turn();expect(done).toBe(false);expect([...f.windows.values()][0]!.visible).toBe(false);
 await expect(f.invoke('desktop_companion_presented',{status:'ready'},'external')).rejects.toThrow('sender window');
 await f.invoke('desktop_companion_presented',{status:'ready'},'companion-1');await waking;expect(await f.invoke('desktop_get_companion')).toEqual({enabled:true,visible:true});
 const receipt=await f.owner.asset({path:`test/${f.version}/bundle.json`});expect(await readFile(receipt.file)).toEqual(f.bytes);await expect(f.owner.asset({path:`test/${f.version}/../settings.json`})).rejects.toThrow();await f.owner.dispose();
});
it('uses native cursor, retains world stool origin, and persists actual display-relative placement',async()=>{
 const f=await fixture(),main=await f.wake(),viewport={x:0,y:300,width:360,height:100,viewportWidth:360,viewportHeight:480};
 await f.invoke('desktop_companion_drag',{phase:'start',anchor:{x:.5,y:.5},screenX:999999,screenY:999999},main.label);f.cursor({x:1700,y:600});await f.invoke('desktop_companion_drag',{phase:'move',screenX:-9999,screenY:-9999},main.label);expect(main.bounds).toEqual({x:1520,y:360,width:360,height:480});
 await f.invoke('desktop_companion_stool',{phase:'lift',viewport},main.label);const stool=[...f.windows.values()].find(w=>w.role==='stool')!;expect(stool.bounds.x).toBe(0);expect(stool.bounds.y).toBe(300);
 await f.invoke('desktop_companion_drag',{phase:'end'},main.label);const settings=JSON.parse(await readFile(path.join(f.root,'settings.json'),'utf8'));expect(settings.desktopCompanionPlacement).toEqual({displayId:2,offsetX:320,offsetY:360});expect(await f.invoke('desktop_companion_passthrough',{enabled:true},main.label)).toEqual({supported:true,enabled:true});f.readiness.get(stool.id)?.();await f.owner.dispose();
});
it('keeps scene inert until mounted and waits for confirmed close on disable',async()=>{
 const f=await fixture(),main=await f.wake();const descriptor={revision:1,scope:'host/thread',kind:'reading',phase:'active',outcome:null,count:null,cue:'engaged',suppressed:false,reducedMotion:false,menuOpen:false};
 await f.invoke('desktop_companion_scene',{descriptor,viewport:{x:0,y:0,width:360,height:360,viewportWidth:360,viewportHeight:480}},main.label);await turn();const scene=[...f.windows.values()].find(w=>w.role==='scene')!;expect(scene.visible).toBe(false);expect(f.calls.some(c=>c.method==='companion.publish')).toBe(false);await expect(f.invoke('desktop_companion_presented',{status:'ready'},scene.label)).rejects.toThrow('sender window');
 f.readiness.get(scene.id)!();await vi.waitFor(()=>expect(scene.visible).toBe(true));expect(f.calls.find(c=>c.method==='companion.publish')!.args.payload).toMatchObject({descriptor:{scope:'host/thread',revision:1}});
 const release=f.holdClose();let stopped=false;const stopping=f.invoke('desktop_set_companion',{enabled:false}).then(()=>{stopped=true;});await turn();expect(stopped).toBe(false);release();await stopping;expect(f.windows.size).toBe(0);await f.owner.dispose();
});

it('shutdown closes decorative creation without waiting for its unresolved ready evaluation',async()=>{
 const f=await fixture(),main=await f.wake();
 await f.invoke('desktop_companion_stool',{phase:'landing',viewport:{x:0,y:300,width:360,height:100,viewportWidth:360,viewportHeight:480}},main.label);
 await vi.waitFor(()=>expect(f.readiness.size).toBe(1));
 await f.owner.dispose();expect(f.windows.size).toBe(0);
 await expect(f.invoke('desktop_set_companion',{enabled:true})).rejects.toThrow('stopping');
});
