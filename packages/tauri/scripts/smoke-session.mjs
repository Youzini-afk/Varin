/** Shared admission for synthetic acceptance controllers. Only an original,
 * successful controller can release its private lease; receipts carry no lease. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

const sessions=new Map(),leases=new WeakMap(),originalProfiles=new Map();
const failure=message=>Object.assign(new Error(message),{cleanupUncertain:true});
const identity=file=>process.platform==='win32'?file.toLowerCase():file;
// Match the original owner's platform config location. Windows uses the native
// known folder, which neither Rust nor Electron redirects through APPDATA.
export function originalProfilePath(environment){
  let directory;
  if(process.platform==='win32'){
    try{directory=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Environment]::GetFolderPath('ApplicationData')"],{env:environment,encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:16*1024,stdio:['ignore','pipe','ignore']}).trim();}
    catch{throw failure('Original Windows profile location is unavailable');}
  }
  else {
    const home=environment.HOME||os.homedir();
    directory=process.platform==='darwin'?path.join(home,'Library/Application Support')
      :environment.XDG_CONFIG_HOME&&path.isAbsolute(environment.XDG_CONFIG_HOME)?environment.XDG_CONFIG_HOME:path.join(home,'.config');
  }
  if(!directory||!path.isAbsolute(directory))throw failure('Original profile location is unavailable');
  return path.join(directory,'Varin');
}
function profileIdentity(profile){
  if(typeof profile!=='string'||!path.isAbsolute(profile))throw failure('Original profile requires an absolute owner path');
  // Seeding legitimately starts before the directory exists. Resolve its nearest
  // existing ancestor so parent links/8.3 aliases cannot create a second key.
  let existing=path.resolve(profile);const missing=[];
  for(;;){
    try {
      if(!fs.statSync(existing).isDirectory())throw failure('Original profile owner path is not a directory');
      return identity(path.join(fs.realpathSync(existing),...missing));
    } catch(error){
      if(error.code!=='ENOENT')throw error;
      const parent=path.dirname(existing);if(parent===existing)throw failure('Original profile owner path is unavailable');
      missing.unshift(path.basename(existing));existing=parent;
    }
  }
}
export function claimSmokeSession(session,{originalProfile}={}){
  if(!session||typeof session.root!=='string'||!path.isAbsolute(session.root))throw failure('Synthetic smoke session requires an absolute canonical root');
  const declared=path.resolve(session.root),stat=fs.lstatSync(declared),resolved=fs.realpathSync(declared);
  if(!stat.isDirectory()||stat.isSymbolicLink()||identity(declared)!==identity(resolved))throw failure('Synthetic smoke session requires an ordinary canonical root');
  const key=identity(resolved);
  if(sessions.has(key))throw failure('Synthetic smoke session still has an active or unconfirmed owner');
  const profile=originalProfile===undefined?undefined:profileIdentity(originalProfile);
  if(profile!==undefined&&originalProfiles.has(profile)&&originalProfiles.get(profile)!==key)throw failure('Original profile is already bound to another synthetic smoke session');
  // This binding survives a successful release: a different private session is
  // not a continuation of the original fixture, even after its process ends.
  if(profile!==undefined)originalProfiles.set(profile,key);
  const lease=Object.freeze({});sessions.set(key,lease);leases.set(lease,key);return lease;
}
export function releaseSmokeSession(lease){
  const key=lease&&leases.get(lease);
  if(!key||sessions.get(key)!==lease)throw new Error('Original smoke session lease is unavailable');
  sessions.delete(key);leases.delete(lease);
}
