import {expect,it} from 'vitest';
import {nativeMigrationReceipt} from './native-migration-receipt.js';
it('stores only verified native outcome metadata and distinguishes excluded browser storage from migrated cookies',()=>{
 const receipt=nativeMigrationReceipt({schema:1,protocol:1,sourceSha:'a'.repeat(40),sourceVersion:'1',attemptComplete:true,sourceRetained:true,
 credentials:[{slot:'openaiApiKey',status:'imported',value:'synthetic-secret'}],cookies:[{identity:{name:'session',domain:'example.test',path:'/',value:'synthetic-cookie'},status:'retained'}],origins:[{origin:'https://example.test',status:'imported',localStorageImported:1,localStorageRetained:2,indexedDbDatabases:['original-db'],localStorage:[['token','synthetic-token']]}]});
 expect(JSON.stringify(receipt)).not.toContain('synthetic-');expect(receipt.credentialsComplete).toBe(true);expect(receipt.cookiesComplete).toBe(true);expect(receipt.indexedDb).toBe('requires-site-recovery');expect(receipt.origins).toMatchObject([{indexedDbDatabases:['original-db']}]);
});
it('rejects unknown or duplicate credential slots instead of accepting a fake completion',()=>{
 const base={schema:1,protocol:1,sourceSha:'a'.repeat(40),sourceVersion:'1',attemptComplete:true,sourceRetained:true,cookies:[],origins:[]};
 expect(()=>nativeMigrationReceipt({...base,credentials:[{slot:'arbitrary-secret',status:'imported'}]})).toThrow();expect(()=>nativeMigrationReceipt({...base,credentials:[{slot:'sttApiKey',status:'imported'},{slot:'sttApiKey',status:'retained'}]})).toThrow();
});

it('journals only absent cookie scope metadata and clears it atomically with the original settings completion',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {createDesktopSettingsOwner}=await import('../../desktop-settings.js');
 const directory=await mkdtemp(path.join(os.tmpdir(),'varin-native-migration-'));
 try{
  const file=path.join(directory,'settings.json');const owner=createDesktopSettingsOwner(file);const sourceSha='b'.repeat(40);
  await owner('nativeMigrationCookiePrepare',{schema:1,sourceSha,scopes:[{domain:'example.test',name:'session',path:'/',value:'must-never-be-saved'}]});
  expect(await owner('nativeMigrationRead')).toMatchObject({pendingCookies:{scopes:[{domain:'example.test',name:'session',path:'/'}]}});
  expect(await readFile(file,'utf8')).not.toContain('must-never-be-saved');
  await expect(owner('nativeMigrationComplete',{schema:1,protocol:1,sourceSha:'c'.repeat(40),sourceVersion:'1',attemptComplete:true,sourceRetained:true,credentials:[],cookies:[],origins:[]})).rejects.toThrow('identity');
  expect(await owner('nativeMigrationRead')).toMatchObject({pendingCookies:{sourceSha}});
  await owner('nativeMigrationComplete',{schema:1,protocol:1,sourceSha,sourceVersion:'1',attemptComplete:true,sourceRetained:true,credentials:[{slot:'openaiApiKey',status:'retained'}],cookies:[],origins:[]});
  expect(await owner('nativeMigrationRead')).toMatchObject({credentialsComplete:true,pendingCookies:null});
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('does not call an unreadable source browser complete or hide recoverable artwork failures',()=>{
 const value=nativeMigrationReceipt({schema:1,protocol:1,sourceSha:'d'.repeat(40),sourceVersion:'1',attemptComplete:true,sourceRetained:true,browserStatus:'source-unavailable',credentials:[{slot:'sttApiKey',status:'failed'}],cookies:[],origins:[],companionFailures:[{id:'varin',reason:'asset-integrity',value:'must-not-persist'}]});
 expect(value.cookiesComplete).toBe(false);expect(value.credentialsComplete).toBe(false);expect(value.companionFailures).toEqual([{id:'varin',reason:'asset-integrity'}]);expect(JSON.stringify(value)).not.toContain('must-not-persist');
});
