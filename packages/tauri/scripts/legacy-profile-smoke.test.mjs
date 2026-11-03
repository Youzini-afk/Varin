/** Setup/ownership tests only. No mocked Electron run qualifies native startup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=await fs.readFile(new URL('./legacy-profile-smoke.cjs',import.meta.url),'utf8');
async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-native-smoke-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'home'));return root;}
function fixture(root,{mode='seed',profile=path.join(root,'preflight-profile'),nonce=randomUUID(),scope='--isolated-preflight',home=path.join(root,'home'),osProfile=path.join(root,'original-profile')}={}){
  const calls=[];
  const electron={
    app:{
      setName:name=>calls.push(['name',name]),
      getPath:name=>{calls.push(['getPath',name]);return osProfile;},
      setPath:(name,value)=>calls.push(['path',name,value]),
      requestSingleInstanceLock:()=>{calls.push(['lock']);return true;},
      whenReady:()=>{calls.push(['ready']);return Promise.reject(new Error('Stop before native-only operations'));},
      exit:code=>calls.push(['exit',code]),
    },
    protocol:{registerSchemesAsPrivileged:schemes=>calls.push(['schemes',schemes[0].scheme])},
  };
  const require=name=>({'electron':electron,'node:fs/promises':fs,'node:fs':fsSync,'node:path':path,'node:os':os})[name];
  const process={argv:['electron','fixture','--varin-installer-fixture',mode,root,nonce,profile,...(scope?[scope]:[])],platform:'linux',versions:{electron:'fixture-test'},env:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',HOME:home,XDG_CONFIG_HOME:path.join(root,'home/.config')}};
  const completed=vm.runInNewContext(source,{require,process,Response});
  return{calls,completed,nonce};
}
test('isolated fixture fixes its own paths and privileged scheme synchronously before readiness',async t=>{
  const root=await temporary(t),profile=path.join(root,'preflight-profile');
  const result=fixture(root);
  assert.deepEqual(result.calls,[['name','Varin'],['path','userData',profile],['path','sessionData',profile],['schemes','varin-ui'],['lock'],['ready']]);
  const marker=JSON.parse(await fs.readFile(path.join(profile,'varin-installer-fixture.json'),'utf8'));
  assert.equal(marker.profileScope,'isolated-preflight');assert.equal(marker.nonce,result.nonce);
  await result.completed;
  const reopened=fixture(root,{mode:'verify',nonce:result.nonce});await reopened.completed;
  assert.ok(reopened.calls.some(([name])=>name==='ready'));
  await assert.rejects(fs.lstat(path.join(root,'original-profile')),{code:'ENOENT'});
});
test('isolated fixture refuses redirected profiles, another home and source-scope confusion',async t=>{
  const root=await temporary(t),outside=path.join(root,'original-profile');
  for(const options of [{profile:outside},{home:os.homedir()},{scope:'--unknown-scope'}]){
    const result=fixture(root,options);await result.completed;
    assert.equal(result.calls.some(([name])=>name==='ready'),false);
    await assert.rejects(fs.lstat(outside),{code:'ENOENT'});
  }
  const seeded=fixture(root);await seeded.completed;
  const marker=path.join(root,'preflight-profile/varin-installer-fixture.json');
  const value=JSON.parse(await fs.readFile(marker,'utf8'));value.profileScope='original-os-profile';await fs.writeFile(marker,JSON.stringify(value));
  const mismatch=fixture(root,{mode:'verify',nonce:seeded.nonce});await mismatch.completed;
  assert.equal(mismatch.calls.some(([name])=>name==='ready'),false);
});
test('original fixture still selects native OS appData and refuses an existing profile',async t=>{
  const root=await temporary(t),osProfile=path.join(root,'original-profile');await fs.mkdir(osProfile);
  const profile=path.join(osProfile,'Varin');
  const seeded=fixture(root,{scope:null,profile,osProfile});
  assert.deepEqual(seeded.calls.slice(0,2),[['name','Varin'],['getPath','appData']]);
  await seeded.completed;
  assert.equal(JSON.parse(await fs.readFile(path.join(profile,'varin-installer-fixture.json'),'utf8')).profileScope,'original-os-profile');
  const repeated=fixture(root,{scope:null,profile,osProfile});await repeated.completed;
  assert.equal(repeated.calls.some(([name])=>name==='ready'),false);
});
