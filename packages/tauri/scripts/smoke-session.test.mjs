import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {claimSmokeSession,releaseSmokeSession,originalProfilePath} from './smoke-session.mjs';

test('one canonical session lease cannot be forged, copied, released twice or overlapped',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-session-lease-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const lease=claimSmokeSession({root});assert.throws(()=>claimSmokeSession({root}),/active or unconfirmed/);
 assert.throws(()=>releaseSmokeSession({}),/unavailable/);assert.throws(()=>releaseSmokeSession(JSON.parse(JSON.stringify(lease))),/unavailable/);
 assert.throws(()=>claimSmokeSession({root}),/active or unconfirmed/);releaseSmokeSession(lease);
 assert.throws(()=>releaseSmokeSession(lease),/unavailable/);const next=claimSmokeSession({root});releaseSmokeSession(next);
});
test('original profile belongs to one session before creation and after clean release',async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-source-owner-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'first'),other=path.join(parent,'second'),profile=path.join(parent,'source','Varin');
 await fs.mkdir(root);await fs.mkdir(other);
 const lease=claimSmokeSession({root},{originalProfile:profile});
 assert.throws(()=>claimSmokeSession({root:other},{originalProfile:profile}),/bound to another/);
 await fs.mkdir(profile,{recursive:true});releaseSmokeSession(lease);
 assert.throws(()=>claimSmokeSession({root:other},{originalProfile:profile}),/bound to another/);
 const next=claimSmokeSession({root},{originalProfile:profile});releaseSmokeSession(next);
 const independent=claimSmokeSession({root:other},{originalProfile:path.join(parent,'independent')});releaseSmokeSession(independent);
});
test('an original profile ancestor alias cannot split resource ownership',{skip:process.platform==='win32'},async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-source-alias-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'first'),other=path.join(parent,'second'),source=path.join(parent,'source'),alias=path.join(parent,'alias');
 for(const directory of [root,other,source])await fs.mkdir(directory);await fs.symlink(source,alias);
 const lease=claimSmokeSession({root},{originalProfile:path.join(source,'Varin')});
 assert.throws(()=>claimSmokeSession({root:other},{originalProfile:path.join(alias,'Varin')}),/bound to another/);
 await fs.mkdir(path.join(source,'Varin'));releaseSmokeSession(lease);
 assert.throws(()=>claimSmokeSession({root:other},{originalProfile:path.join(alias,'Varin')}),/bound to another/);
});
test('source profile resolution follows the actual platform config owner',()=>{
 if(process.platform==='win32')assert.equal(originalProfilePath({...process.env,APPDATA:'not-the-native-known-folder'}),originalProfilePath(process.env));
 else if(process.platform==='darwin')assert.equal(originalProfilePath({HOME:'/private/example',XDG_CONFIG_HOME:'/ignored'}),'/private/example/Library/Application Support/Varin');
 else {
  assert.equal(originalProfilePath({HOME:'/private/example',XDG_CONFIG_HOME:'/private/config'}),'/private/config/Varin');
  assert.equal(originalProfilePath({HOME:'/private/example',XDG_CONFIG_HOME:'relative-is-ignored'}),'/private/example/.config/Varin');
 }
});
test('redirected roots are rejected before acquiring a different lease identity',{skip:process.platform==='win32'},async t=>{
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-session-alias-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'original'),alias=path.join(parent,'alias');await fs.mkdir(root);await fs.symlink(root,alias);
 const lease=claimSmokeSession({root});assert.throws(()=>claimSmokeSession({root:alias}),/canonical root/);
 releaseSmokeSession(lease);assert.throws(()=>claimSmokeSession({root:alias}),/canonical root/);
 const next=claimSmokeSession({root});releaseSmokeSession(next);
});
