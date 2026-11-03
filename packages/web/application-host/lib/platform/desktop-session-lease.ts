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
  if(value.schema!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.token!=='string'||!/^[-0-9a-f]{36}$/u.test(value.token)||!['electron','tauri','migration'].includes(value.shell))throw new Error('Desktop lease owner record is invalid');
  return value;
};
const alive=(pid:number)=>{
  try{process.kill(pid,0);return true;}
  catch(error){if(code(error)==='ESRCH')return false;if(code(error)==='EPERM')return true;throw new Error('Desktop owner process state is unknown');}
};
export function verifyInheritedDesktopSessionLease(dataDirectory:string,record:DesktopSessionRecord):void {
  const current=read(ownerDirectory(fs.realpathSync(dataDirectory)));
  if(record.schema!==1||record.pid!==process.ppid||record.pid!==current.pid||record.token!==current.token||current.shell!=='tauri'||!alive(current.pid))throw new Error('Migration does not inherit the original desktop data lease');
}
export function acquireDesktopSessionLease(dataDirectory:string,shell:'electron'|'migration'='electron'){
  fs.mkdirSync(dataDirectory,{recursive:true,mode:0o700});const data=fs.realpathSync(dataDirectory),directory=ownerDirectory(data);
  for(let attempt=0;attempt<4;attempt++){
    let exists=false;
    try{fs.lstatSync(directory);exists=true;}catch(error){if(code(error)!=='ENOENT')throw error;}
    if(exists){
      const record=read(directory);
      if(alive(record.pid))throw new Error('Another Varin desktop is using this data directory. Close it before switching desktop engines.');
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
        const retired=path.join(data,`.desktop-session-released-${record.token}`);fs.renameSync(directory,retired);released=true;fs.rmSync(retired,{recursive:true,force:true});
      }catch{/* Never delete a lease whose ownership cannot be proved. */}
    }};
  }
  throw new Error('Desktop lease changed during startup; retry after the other desktop closes');
}
