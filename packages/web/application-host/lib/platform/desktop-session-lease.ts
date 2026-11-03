/** Same atomic cross-shell lease as the native desktop. No timeout steals an
 * owner. Token-specific nonempty tombstones prevent racing stale reclaimers
 * from renaming a subsequently published live lease. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface DesktopSessionRecord { schema: 1; pid: number; token: string; shell: 'electron'|'tauri'|'migration' }
const ownerDirectory = (dataDirectory:string) => path.join(dataDirectory,'.desktop-session.lock');
const code = (error:unknown) => (error as NodeJS.ErrnoException)?.code;
const read = (directory:string):DesktopSessionRecord => {
  const metadata=fs.lstatSync(directory),file=path.join(directory,'owner.json');
  if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new Error('Desktop lease is not a private owner directory');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('Desktop lease owner record is invalid');
  const value=JSON.parse(fs.readFileSync(file,'utf8')) as DesktopSessionRecord;
  if(value.schema!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.token)||!['electron','tauri','migration'].includes(value.shell))throw new Error('Desktop lease owner record is invalid');
  return value;
};
const scopesEnded=(directory:string,owner:DesktopSessionRecord):void=>{
  const scopes=path.join(directory,'scopes');
  let metadata:fs.Stats;
  try{metadata=fs.lstatSync(scopes);}catch(error){if(code(error)==='ENOENT')return;throw new Error('Managed scope records cannot be inspected');}
  if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new Error('Managed scope directory is invalid');
  for(const name of fs.readdirSync(scopes)){
    const file=path.join(scopes,name),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('Managed scope receipt is invalid');
    const record=JSON.parse(fs.readFileSync(file,'utf8')) as Record<string,unknown>;
    const keys=['schema','token','leaseToken','shellPid','phase','guardianPid','nodePid'];
    const pid=(value:unknown)=>value===undefined||value===null||Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=0xffffffff;
    if(Object.keys(record).some(key=>!keys.includes(key))||record.schema!==1||typeof record.token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(record.token)
      ||record.leaseToken!==owner.token||record.shellPid!==owner.pid||!['pending','active','ended'].includes(String(record.phase))
      ||!pid(record.guardianPid)||!pid(record.nodePid)||record.phase==='active'&&(record.guardianPid==null||record.nodePid==null))throw new Error('Managed scope receipt is invalid');
    if(name!==`${record.token}.json`||record.phase!=='ended')throw new Error("The previous desktop's managed services have not confirmed termination; original data ownership is retained");
  }
};
const alive=(pid:number)=>{
  try{process.kill(pid,0);return true;}
  catch(error){if(code(error)==='ESRCH')return false;if(code(error)==='EPERM')return true;throw new Error('Desktop owner process state is unknown');}
};
export function verifyInheritedDesktopSessionLease(dataDirectory:string,record:DesktopSessionRecord):void {
  const directory=ownerDirectory(fs.realpathSync(dataDirectory)),current=read(directory);
  const rejected=()=>new Error('Migration does not inherit the original desktop data lease');
  if(record.schema!==1||record.pid!==current.pid||record.token!==current.token||record.shell!==current.shell||current.shell!=='tauri'||!alive(current.pid))throw rejected();
  if(record.pid===process.ppid)return;
  // The guardian publishes this exact active chain before exposing the private
  // handshake pipe. An arbitrary live ancestor or renderer-supplied PID is not
  // inherited ownership. No stale receipt or process-table search grants it.
  const token=process.env.VARIN_DESKTOP_SCOPE_TOKEN;
  if(!token||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(token))throw rejected();
  const scopes=path.join(directory,'scopes'),metadata=fs.lstatSync(scopes);
  if(!metadata.isDirectory()||metadata.isSymbolicLink())throw rejected();
  const file=path.join(scopes,`${token}.json`),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw rejected();
  const scope=JSON.parse(fs.readFileSync(file,'utf8')) as Record<string,unknown>;
  const keys=['schema','token','leaseToken','shellPid','phase','guardianPid','nodePid'];
  if(Object.keys(scope).some(key=>!keys.includes(key))||scope.schema!==1||scope.token!==token||scope.leaseToken!==current.token
    ||scope.shellPid!==current.pid||scope.phase!=='active'||scope.guardianPid!==process.ppid||scope.nodePid!==process.pid)throw rejected();
}
export function acquireDesktopSessionLease(dataDirectory:string,shell:'electron'|'migration'='electron'){
  fs.mkdirSync(dataDirectory,{recursive:true,mode:0o700});const data=fs.realpathSync(dataDirectory),directory=ownerDirectory(data);
  for(let attempt=0;attempt<4;attempt++){
    let exists=false;
    try{fs.lstatSync(directory);exists=true;}catch(error){if(code(error)!=='ENOENT')throw error;}
    if(exists){
      const record=read(directory);
      if(alive(record.pid))throw new Error('Another Varin desktop is using this data directory. Close it before switching desktop engines.');
      scopesEnded(directory,record);
      try{fs.renameSync(directory,path.join(data,`.desktop-session-retired-${record.token}`));}
      catch(error){if(!['ENOENT','EEXIST','ENOTEMPTY','EPERM'].includes(code(error)??''))throw error;}
      continue;
    }
    const record:DesktopSessionRecord={schema:1,pid:process.pid,token:randomUUID(),shell};const candidate=path.join(data,`.desktop-session-pending-${record.token}`);
    fs.mkdirSync(candidate,{mode:0o700});let descriptor:number|undefined;
    try{descriptor=fs.openSync(path.join(candidate,'owner.json'),'wx',0o600);fs.writeFileSync(descriptor,JSON.stringify(record));fs.fsyncSync(descriptor);}
    catch(error){fs.rmSync(candidate,{recursive:true,force:true});throw error;}
    finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
    try{fs.renameSync(candidate,directory);}
    catch{fs.rmSync(candidate,{recursive:true,force:true});continue;}
    let released=false;
    return {record,release(){
      if(released)return;
      try{const current=read(directory);if(current.pid!==record.pid||current.token!==record.token)return;
        scopesEnded(directory,current);
        const retired=path.join(data,`.desktop-session-released-${record.token}`);fs.renameSync(directory,retired);released=true;fs.rmSync(retired,{recursive:true,force:true});
      }catch{/* Never delete a lease whose ownership cannot be proved. */}
    }};
  }
  throw new Error('Desktop lease changed during startup; retry after the other desktop closes');
}
