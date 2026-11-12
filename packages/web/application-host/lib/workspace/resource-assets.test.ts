import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {afterEach,expect,it,vi} from 'vitest';
import {createResourceFilesOwner} from './resource-files.js';
import {registerResourceFileRoutes} from './resource-file-routes.js';
import {createOfficeFile} from '../office/create.js';
import {createUiAuth} from '../ui-auth/ui-auth.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-resource-assets-'));cleanup.push(()=>fs.rm(root,{recursive:true,force:true}));
  const documents={resolveWorkspace:async({path:requested}:{path:string})=>{expect(requested).toBe(root);return {workspaceId:'target'};},admitWorkspaceRegistration:async()=>({hostId:'host'}),inspectWorkspace:async()=>({root})};
  const render=vi.fn(async(_bytes:Buffer,_format:unknown,signal:AbortSignal)=>{signal.throwIfAborted();return {bytes:Buffer.from('%PDF-original-render'),engine:{name:'original-engine',version:'1'}};});
  const files=createResourceFilesOwner(documents as never,{} as never,undefined,undefined,undefined,render);
  return {root,files,render,location:{resourceOwner:{kind:'local' as const},root,workspaceId:'target'}};
}
it('reads and finds the actual Office package, preserves revision conflicts and original preview failures',async()=>{
  const f=await fixture();
  const bytes=await createOfficeFile({format:'docx',blocks:[{kind:'paragraph',text:'remote document needle'}]},async()=>{throw new Error('No image');});
  await fs.writeFile(path.join(f.root,'document.docx'),bytes);
  const read=await f.files.asset({...f.location,path:'document.docx',asset:{kind:'office-read',input:{view:'content'}}});
  const data=await read.json() as import('@varin/protocol').OfficeReadResult;expect(data.objects?.[0]?.text).toBe('remote document needle');
  const find=await f.files.asset({...f.location,path:'document.docx',asset:{kind:'office-read',input:{view:'find',query:'needle'}}});expect(((await find.json()) as import('@varin/protocol').OfficeReadResult).objects?.length).toBe(1);
  const changed=await f.files.asset({...f.location,path:'document.docx',asset:{kind:'office-preview',expectedRevision:'sha256-stale'}});expect(changed.status).toBe(409);expect(f.render).not.toHaveBeenCalled();
  const preview=await f.files.asset({...f.location,path:'document.docx',asset:{kind:'office-preview'}});expect(await preview.text()).toBe('%PDF-original-render');expect(preview.headers.get('x-varin-render-engine')).toBe('original-engine 1');
  f.render.mockRejectedValueOnce(new Error('Original renderer unavailable'));
  await expect(f.files.asset({...f.location,path:'document.docx',asset:{kind:'office-preview'}})).rejects.toThrow('Original renderer unavailable');
  await expect(f.files.asset({...f.location,workspaceId:'coordinator',path:'document.docx',asset:{kind:'raw'}})).rejects.toThrow('location changed');
  await expect(f.files.asset({...f.location,path:'../foreign.docx',asset:{kind:'raw'}})).rejects.toThrow();
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  f.render.mockImplementationOnce(async(_bytes,_format,signal)=>{began();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));signal.throwIfAborted();throw new Error('unreachable');});
  const controller=new AbortController();
  const rendering=f.files.asset({...f.location,path:'document.docx',asset:{kind:'office-preview'}},controller.signal);
  const rejected=expect(rendering).rejects.toThrow();await started;controller.abort();await rejected;

});
it('serves relative HTML assets through the same authenticated owner prefix, denying foreign and expired credentials',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.root,'site'));await fs.writeFile(path.join(f.root,'site','index.html'),'<link rel="stylesheet" href="style.css"><img src="image.png">');await fs.writeFile(path.join(f.root,'site','style.css'),'body { color: red }');await fs.writeFile(path.join(f.root,'site','image.png'),'image');
  const auth=createUiAuth({password:'secret',clientAuthController:{authenticateBearerToken:async token=>token==='test-bearer'?{ok:true,clientId:'device'}:null}});
  cleanup.push(async()=>auth.dispose());
  const app=express();app.use(express.json());app.post('/auth/url-token',(req,res)=>{void auth.handleUrlAuthToken(req,res);});
  registerResourceFileRoutes(app,{local:f.files,remote:async()=>{throw new Error('No local fallback');},runtime:{} as never,attachments:{} as never,requireAuth:auth.requireAuth as express.RequestHandler});
  const server=await new Promise<import('node:http').Server>(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const token=await (await fetch(base+'/auth/url-token',{method:'POST',headers:{authorization:'Bearer test-bearer'}})).json() as {token:string;expiresAt:number};
  const prefix=`${base}/api/resource-assets/${token.token}/${encodeURIComponent(JSON.stringify(f.location))}/serve/`;
  const html=await fetch(prefix+'site/index.html');expect(html.status).toBe(200);expect(html.headers.get('referrer-policy')).toBe('no-referrer');expect(html.headers.get('cache-control')).toBe('no-store');
  const css=await fetch(new URL('style.css',html.url));expect(await css.text()).toBe('body { color: red }');
  const image=await fetch(new URL('image.png',html.url));expect(await image.text()).toBe('image');
  expect((await fetch(prefix.replace(token.token,'invalid-token')+'site/index.html')).status).toBe(401);
  expect((await fetch(prefix+'%2e%2e%2fforeign')).status).not.toBe(200);
  expect((await fetch(prefix+'site/index.html',{method:'POST'})).status).not.toBe(200);
  const now=vi.spyOn(Date,'now').mockReturnValue(Number(token.expiresAt)+1);
  try{expect((await fetch(prefix+'site/index.html')).status).toBe(401);}finally{now.mockRestore();}
});
