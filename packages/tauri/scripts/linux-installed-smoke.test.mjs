import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {debianPackageOperation,debianOperationArguments,runDebianOperation,assertDebianStatus,assertLinuxSandboxReceipt,smokeLinuxInstalled,verifyDebianInstalled} from './linux-installed-smoke.mjs';
const identity={sourceSha:'a'.repeat(40),version:'1.0.0',architecture:'x64',artifactSha256:'b'.repeat(64),runtimeManifestSha256:'c'.repeat(64)};
function inventory(){return{schema:1,product:'varin-debian-inventory',packageName:'varin',packageArchitecture:'amd64',...identity,desktopFile:'usr/share/applications/Varin.desktop',helpers:['usr/share/Varin/chrome-sandbox','usr/lib/Varin/runtime/legacy-electron/chrome-sandbox'],entries:['usr/share/Varin/chrome-sandbox','usr/lib/Varin/runtime/legacy-electron/chrome-sandbox','usr/share/Varin/varin','usr/lib/Varin/runtime/runtime-manifest.json','usr/share/applications/Varin.desktop'].map((p,i)=>({path:p,type:'file',mode:i<2?0o4755:0o644,uid:0,gid:0,size:1,sha256:'d'.repeat(64)}))};}
test('dpkg status distinguishes removed, unpacked, foreign architecture and wrong version',()=>{
  assert.doesNotThrow(()=>assertDebianStatus('install ok installed\t1.0.0\tamd64\n',inventory()));
  for(const status of ['deinstall ok config-files\t1.0.0\tamd64','install ok unpacked\t1.0.0\tamd64','install ok installed\t2.0.0\tamd64','install ok installed\t1.0.0\tarm64'])assert.throws(()=>assertDebianStatus(status,inventory()));
});
test('Native sandbox receipts require every renderer to enforce all Linux protections',()=>{
  const renderer={seccomp:'2',noNewPrivileges:'1',effectiveCapabilities:'0000000000000000',noSandboxSwitch:false,pidNamespaceDepth:2,brokerNamespaceDepth:1};
  const report=r=>({cases:[{name:'renderer-sandbox',status:'passed',evidence:{source:'operating-system',renderers:r}}]});
  assert.equal(assertLinuxSandboxReceipt(report([renderer])).renderersVerified,1);
  for(const patch of [{seccomp:'0'},{noNewPrivileges:'0'},{effectiveCapabilities:'0001'},{noSandboxSwitch:true},{pidNamespaceDepth:1},{brokerNamespaceDepth:2}])assert.throws(()=>assertLinuxSandboxReceipt(report([renderer,{...renderer,...patch}])));
  assert.throws(()=>assertLinuxSandboxReceipt(report([])));
  assert.throws(()=>assertLinuxSandboxReceipt({cases:[{name:'renderer-sandbox',status:'passed'}]}));
});
test('Unapproved installation rejects before creating output or touching dpkg',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-debian-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const output=path.join(root,'evidence');await assert.rejects(smokeLinuxInstalled('/nonexistent/candidate.json',{output}),/ephemeral/);await assert.rejects(fs.stat(output),{code:'ENOENT'});
});
test('Installed file verification observes real byte and ownership mismatches without privileged setup',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-debian-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const p='usr/share/Varin/varin';await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),'changed');
  const stat=await fs.stat(path.join(root,p));
  await assert.rejects(verifyDebianInstalled({entries:[{path:p,type:'file',uid:stat.uid,gid:stat.gid,mode:stat.mode&0o7777,size:7,sha256:'d'.repeat(64)}]},{root,packageFiles:`/${p}\n`}),/bytes differ/);
  await assert.rejects(verifyDebianInstalled({entries:[{path:p,type:'file',uid:stat.uid+1,gid:stat.gid,mode:stat.mode&0o7777}]},{root,packageFiles:`/${p}\n`}),/ownership/);
  await assert.rejects(verifyDebianInstalled({entries:[{path:p,type:'file'}]},{root,packageFiles:'/other'}),/not owned/);
});

const operationIdentity={installer:'/workspace/artifacts/Varin.deb',artifact:{sha256:'b'.repeat(64),size:123},inventory:{version:'0.9.37',packageArchitecture:'amd64'}};
const operationEnvironment={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
test('Root operation plan has fixed interpreter and operation, digest-bound source and strict run identity',()=>{
  const args=debianOperationArguments('install',operationIdentity,operationEnvironment);
  assert.deepEqual(args.slice(0,4),['-n','/usr/bin/python3','-I','-c']);
  assert.equal(args[4],debianPackageOperation);
  assert.deepEqual(args.slice(5),['install','/workspace/artifacts/Varin.deb','b'.repeat(64),'123','123','2','0.9.37','amd64']);
  assert.equal(debianOperationArguments('remove',operationIdentity,operationEnvironment)[5],'remove');
  for(const operation of ['purge','--install','other'])assert.throws(()=>debianOperationArguments(operation,operationIdentity,operationEnvironment));
  for(const patch of [{installer:'relative.deb'},{artifact:{sha256:'x',size:123}},{artifact:{sha256:'b'.repeat(64),size:0}},{inventory:{version:'--force-all',packageArchitecture:'amd64'}},{inventory:{version:'0.9.37',packageArchitecture:'foreign'}}])assert.throws(()=>debianOperationArguments('install',{...operationIdentity,...patch},operationEnvironment));
  assert.throws(()=>debianOperationArguments('install',operationIdentity,{...operationEnvironment,GITHUB_RUN_ATTEMPT:'../2'}));
});
test('Every install and removal independently refuses missing approval before subprocess effects',async()=>{
  await assert.rejects(runDebianOperation('install',operationIdentity),/ephemeral/);
  await assert.rejects(runDebianOperation('remove',operationIdentity),/ephemeral/);
});
test('Root program parses without executing any privileged branch',{skip:process.platform!=='linux'},()=>{
  execFileSync('python3',['-I','-c','import ast,sys; ast.parse(sys.argv[1])',debianPackageOperation],{stdio:'pipe'});
});
test('dpkg-deb metadata format matches exact privileged identity check, without installation',{skip:process.platform!=='linux'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-debian-metadata-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),control=path.join(source,'DEBIAN');await fs.mkdir(control,{recursive:true});
  await fs.writeFile(path.join(control,'control'),'Package: varin\nVersion: 0.9.37\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDescription: Metadata format fixture\n');
  const archive=path.join(root,'metadata.deb');execFileSync('dpkg-deb',['--build',source,archive],{stdio:'pipe'});
  assert.equal(execFileSync('dpkg-deb',['-f',archive,'Package','Version','Architecture'],{encoding:'utf8'}),'Package: varin\nVersion: 0.9.37\nArchitecture: amd64\n');
});
