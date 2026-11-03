import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireDesktopSessionLease,verifyInheritedDesktopSessionLease } from './desktop-session-lease.js';
describe('cross-shell desktop lease',()=>{
 it('retains a dead shell owner until its original managed scope commits termination',()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-dead-desktop-scope-'));
  try{
   const source=`import {acquireDesktopSessionLease} from ${JSON.stringify(new URL('./desktop-session-lease.ts',import.meta.url).href)};const lease=acquireDesktopSessionLease(process.argv[1]);process.stdout.write(JSON.stringify(lease.record));`;
   const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',source,data],{encoding:'utf8'});expect(child.status,child.stderr).toBe(0);
   const owner=JSON.parse(child.stdout),directory=path.join(data,'.desktop-session.lock','scopes');fs.mkdirSync(directory);
   const token=randomUUID(),file=path.join(directory,`${token}.json`),record={schema:1,token,leaseToken:owner.token,shellPid:owner.pid,phase:'pending',guardianPid:null,nodePid:null};
   fs.writeFileSync(file,JSON.stringify(record));expect(()=>acquireDesktopSessionLease(data)).toThrow('not confirmed termination');
   fs.writeFileSync(file,JSON.stringify({...record,phase:'ended'}));const next=acquireDesktopSessionLease(data);expect(next.record.token).not.toBe(owner.token);next.release();
  }finally{fs.rmSync(data,{recursive:true,force:true});}
 });

 it('does not release the shell lease while an original managed scope remains unconfirmed',()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-scope-'));
  try{
   const lease=acquireDesktopSessionLease(data),directory=path.join(data,'.desktop-session.lock','scopes');fs.mkdirSync(directory);
   const token=randomUUID(),file=path.join(directory,`${token}.json`),record={schema:1,token,leaseToken:lease.record.token,shellPid:process.pid,phase:'pending',guardianPid:null,nodePid:null};
   fs.writeFileSync(file,JSON.stringify(record));lease.release();expect(fs.existsSync(directory)).toBe(true);
   fs.writeFileSync(file,JSON.stringify({...record,phase:'active',guardianPid:process.pid,nodePid:process.pid}));lease.release();expect(fs.existsSync(directory)).toBe(true);
   fs.writeFileSync(file,JSON.stringify({...record,phase:'ended'}));lease.release();expect(fs.existsSync(path.dirname(directory))).toBe(false);
  }finally{fs.rmSync(data,{recursive:true,force:true});}
 });

 it('has one real owner and releases only its matching token',()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-lease-'));try{const original=acquireDesktopSessionLease(data);expect(()=>acquireDesktopSessionLease(data)).toThrow('Another Varin');original.release();const next=acquireDesktopSessionLease(data);original.release();expect(()=>acquireDesktopSessionLease(data)).toThrow('Another Varin');next.release();}finally{fs.rmSync(data,{recursive:true,force:true});}});
 it('retains ambiguous/incomplete records and never inherits a renderer supplied identity',()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-lease-'));try{const directory=path.join(data,'.desktop-session.lock');fs.mkdirSync(directory);expect(()=>acquireDesktopSessionLease(data)).toThrow();fs.rmdirSync(directory);const lease=acquireDesktopSessionLease(data);expect(()=>verifyInheritedDesktopSessionLease(data,lease.record)).toThrow('does not inherit');lease.release();}finally{fs.rmSync(data,{recursive:true,force:true});}});
 it('cannot retire a new live owner over an earlier nonempty token tombstone',()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-lease-'));try{const original=acquireDesktopSessionLease(data);const retired=path.join(data,`.desktop-session-retired-${original.record.token}`);fs.renameSync(path.join(data,'.desktop-session.lock'),retired);const next=acquireDesktopSessionLease(data);expect(()=>fs.renameSync(path.join(data,'.desktop-session.lock'),retired)).toThrow();expect(()=>acquireDesktopSessionLease(data)).toThrow('Another Varin');next.release();}finally{fs.rmSync(data,{recursive:true,force:true});}});
});
