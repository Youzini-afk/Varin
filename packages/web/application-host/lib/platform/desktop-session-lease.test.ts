import { describe,it,expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireDesktopSessionLease,verifyInheritedDesktopSessionLease } from './desktop-session-lease.js';
describe('cross-shell desktop lease',()=>{
 it('has one real owner and releases only its matching token',()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-lease-'));try{const original=acquireDesktopSessionLease(data);expect(()=>acquireDesktopSessionLease(data)).toThrow('Another Varin');original.release();const next=acquireDesktopSessionLease(data);original.release();expect(()=>acquireDesktopSessionLease(data)).toThrow('Another Varin');next.release();}finally{fs.rmSync(data,{recursive:true,force:true});}});
 it('retains ambiguous/incomplete records and never inherits a renderer supplied identity',()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-lease-'));try{const directory=path.join(data,'.desktop-session.lock');fs.mkdirSync(directory);expect(()=>acquireDesktopSessionLease(data)).toThrow();fs.rmdirSync(directory);const lease=acquireDesktopSessionLease(data);expect(()=>verifyInheritedDesktopSessionLease(data,lease.record)).toThrow('does not inherit');lease.release();}finally{fs.rmSync(data,{recursive:true,force:true});}});
 it('cannot retire a new live owner over an earlier nonempty token tombstone',()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'varin-desktop-lease-'));try{const original=acquireDesktopSessionLease(data);const retired=path.join(data,`.desktop-session-retired-${original.record.token}`);fs.renameSync(path.join(data,'.desktop-session.lock'),retired);const next=acquireDesktopSessionLease(data);expect(()=>fs.renameSync(path.join(data,'.desktop-session.lock'),retired)).toThrow();expect(()=>acquireDesktopSessionLease(data)).toThrow('Another Varin');next.release();}finally{fs.rmSync(data,{recursive:true,force:true});}});
});
