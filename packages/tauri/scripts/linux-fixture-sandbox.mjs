/** Explicitly authorized disposable-runner fixture only. Never modifies a shipped runtime. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {requireDisposableRunner,preparedFixtureEngine} from './installer-smoke.mjs';
import {sha256} from './runtime-manifest.mjs';
export const fixtureSandboxHashes=Object.freeze({x64:'f16e2562837856845cfc8ebf4aa7f78b57fdadc6b69130509b1db87ce5d2f869',arm64:'e0f790d4301b8c427d147792d9209939663a41d2bce5ffaef475eba60cf83151'});
export function requireAuthorizedLinuxInstall({disposableRunner=false,authorizedLinuxSandboxInstall=false,environment=process.env,platform=process.platform,uid=process.getuid?.()}={}){
  requireDisposableRunner({acknowledged:disposableRunner,environment,platform});
  if(platform!=='linux'||environment.RUNNER_OS!=='Linux'||uid===0||!Number.isInteger(uid)||uid<1)throw new Error('Linux installation smoke must run as the normal disposable Linux runner user');
  if(authorizedLinuxSandboxInstall!==true)throw new Error('Root-owned sandbox installation requires explicit --authorized-linux-sandbox-install approval');
  if(!/^\d+$/u.test(environment.GITHUB_RUN_ID??'')||!/^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT??''))throw new Error('Missing disposable GitHub run identity');
}
export function fixtureSandboxDestination(environment=process.env,architecture=process.arch){
  if(!fixtureSandboxHashes[architecture]||!/^\d+$/u.test(environment.GITHUB_RUN_ID??'')||!/^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT??''))throw new Error('Invalid fixture sandbox target');
  return `/usr/local/libexec/varin-ci/${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}/electron-45.2.1-${architecture}/chrome-sandbox`;
}
// A fixed program, not a shell command assembled from caller input. Hash source
// bytes inside the privileged process before creating an exclusive destination.
// Every destination ancestor is root-owned, non-writable and not a symlink.
export const fixtureSandboxInstaller=String.raw`
import os, sys, stat, hashlib, re
source, run, attempt, arch = sys.argv[1:]
hashes = {'x64':'f16e2562837856845cfc8ebf4aa7f78b57fdadc6b69130509b1db87ce5d2f869','arm64':'e0f790d4301b8c427d147792d9209939663a41d2bce5ffaef475eba60cf83151'}
assert os.geteuid() == 0 and re.fullmatch(r'[0-9]+',run) and re.fullmatch(r'[0-9]+',attempt) and arch in hashes
fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as f:
    assert stat.S_ISREG(os.fstat(f.fileno()).st_mode)
    data = f.read(16*1024*1024+1)
assert len(data) <= 16*1024*1024 and hashlib.sha256(data).hexdigest() == hashes[arch]
parent = '/usr/local/libexec/varin-ci/' + run + '-' + attempt + '/electron-45.2.1-' + arch
current = '/'
for component in parent.strip('/').split('/'):
    current = os.path.join(current,component)
    try: os.mkdir(current,0o755)
    except FileExistsError: pass
    s = os.lstat(current)
    assert stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and s.st_mode & 0o022 == 0
file = parent + '/chrome-sandbox'
try:
    fd = os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError:
    s = os.lstat(file)
    assert stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and stat.S_IMODE(s.st_mode) == 0o4755
    with open(file,'rb') as f: assert hashlib.sha256(f.read()).hexdigest() == hashes[arch]
else:
    with os.fdopen(fd,'wb') as f:
        f.write(data); f.flush(); os.fsync(f.fileno())
        os.fchown(f.fileno(),0,0)
        os.fchmod(f.fileno(),0o4755)
`;
export async function installFixtureSandbox(options={}){
  requireAuthorizedLinuxInstall(options);
  const executable=preparedFixtureEngine(),adjacent=path.join(path.dirname(executable),'chrome-sandbox');
  if((await fs.readFile(path.join(path.dirname(executable),'version'),'utf8')).trim().replace(/^v/u,'')!=='45.2.1')throw new Error('Fixture sandbox requires audited Electron 45.2.1');
  const target=fixtureSandboxDestination(),stat=await fs.lstat(adjacent);
  if(stat.isSymbolicLink()){
    if(await fs.readlink(adjacent)!==target)throw new Error('Fixture helper points to an unexpected destination');
  }else{
    if(!stat.isFile()||await sha256(adjacent)!==fixtureSandboxHashes[process.arch])throw new Error('Fixture helper differs from the audited official Electron 45.2.1 bytes');
    requireAuthorizedLinuxInstall(options);
    execFileSync('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-c',fixtureSandboxInstaller,adjacent,process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT,process.arch],{stdio:['ignore','ignore','ignore'],timeout:30_000});
    // Never alter a source whose identity changed during the privileged copy.
    const after=await fs.lstat(adjacent);
    if(!after.isFile()||after.ino!==stat.ino||after.dev!==stat.dev||await sha256(adjacent)!==fixtureSandboxHashes[process.arch])throw new Error('Fixture source changed during helper preparation');
    await fs.unlink(adjacent);await fs.symlink(target,adjacent);
  }
  for(let parent=path.dirname(target);;parent=path.dirname(parent)){
    const ancestor=await fs.lstat(parent);
    if(!ancestor.isDirectory()||ancestor.uid!==0||ancestor.gid!==0||(ancestor.mode&0o022))throw new Error('Fixture sandbox has an unsafe ancestor');
    if(parent==='/')break;
  }
  const installed=await fs.lstat(target);
  if(!installed.isFile()||installed.uid!==0||installed.gid!==0||(installed.mode&0o7777)!==0o4755||await sha256(target)!==fixtureSandboxHashes[process.arch])throw new Error('Fixture sandbox installation did not verify');
  return{schema:1,product:'varin-ci-fixture-sandbox',electronVersion:'45.2.1',architecture:process.arch,sha256:fixtureSandboxHashes[process.arch],destination:target,shippedRuntimeChanged:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  console.log(JSON.stringify(await installFixtureSandbox({disposableRunner:args.includes('--disposable-runner'),authorizedLinuxSandboxInstall:args.includes('--authorized-linux-sandbox-install')})));
}
