/** Actual Debian install/replacement/removal, never an AppImage success proxy.
 * Privileged actions require an explicit additional approval and disposable CI. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {inspectDebian,validateDebianInventory} from './linux-debian.mjs';
import {failRetainedObservation,admitCandidate,verifyRecord,preparedFixtureEngine,seedOrVerify,runObserved} from './installer-smoke.mjs';
import {requireAuthorizedLinuxInstall} from './linux-fixture-sandbox.mjs';
import {createSmokeSession,smokeNative} from './smoke-native.mjs';
import {runInstalledDataFixture} from './installed-data-fixture.mjs';
import {sha256,verifyRuntimeManifest} from './runtime-manifest.mjs';
import {verifyProtocolRegistration} from './protocol-smoke.mjs';
const repository=path.resolve(import.meta.dirname,'../../..');
const executable='/usr/share/Varin/varin',runtimeDirectory='/usr/lib/Varin/runtime';
const helperPaths=['usr/share/Varin/chrome-sandbox','usr/lib/Varin/runtime/legacy-electron/chrome-sandbox'];
const exists=async file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const query=args=>execFileSync('dpkg-query',args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30_000});
// The privileged process consumes only a root-owned read-only copy whose bytes
// match the inspected candidate. A workspace pathname is never passed to dpkg.
export const debianPackageOperation=String.raw`
import os, sys, stat, hashlib, re, subprocess
operation, source, expected, size_text, run, attempt, version, arch = sys.argv[1:]
def require(condition):
    if not condition: raise RuntimeError('Debian privileged operation rejected')
require(os.geteuid() == 0)
require(operation in ('install','remove') and re.fullmatch(r'[a-f0-9]{64}',expected) is not None)
require(re.fullmatch(r'[0-9]+',run) is not None and re.fullmatch(r'[0-9]+',attempt) is not None)
require(re.fullmatch(r'[1-9][0-9]*',size_text) is not None)
require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?',version) is not None)
require(arch in ('amd64','arm64') and os.path.isabs(source))
expected_size = int(size_text)
env = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C','LC_ALL':'C','DEBIAN_FRONTEND':'noninteractive'}
parent = '/usr/local/libexec/varin-ci/' + run + '-' + attempt + '/packages'
current = '/'
s = os.lstat(current)
require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and s.st_mode & 0o022 == 0)
for component in parent.strip('/').split('/'):
    current = os.path.join(current,component)
    try: os.mkdir(current,0o755)
    except FileExistsError: pass
    s = os.lstat(current)
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and s.st_mode & 0o022 == 0)
file = parent + '/' + expected + '.deb'
def verify_copy():
    fd = os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        s = os.fstat(f.fileno())
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and stat.S_IMODE(s.st_mode) == 0o444 and s.st_nlink == 1 and s.st_size == expected_size)
        digest = hashlib.sha256()
        while chunk := f.read(1024*1024): digest.update(chunk)
        require(digest.hexdigest() == expected)
if operation == 'install':
    try:
        fd = os.open(file,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    except FileExistsError:
        verify_copy()
    else:
        # A failed partial copy remains root-only and is never overwritten or
        # reused. Runner disposal is its cleanup owner, not a blind retry.
        with os.fdopen(fd,'wb') as destination:
            source_fd = os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(source_fd,'rb') as original:
                s = os.fstat(original.fileno())
                require(stat.S_ISREG(s.st_mode) and s.st_size == expected_size)
                digest, total = hashlib.sha256(), 0
                while chunk := original.read(1024*1024):
                    total += len(chunk)
                    require(total <= expected_size)
                    digest.update(chunk); destination.write(chunk)
                require(total == expected_size and digest.hexdigest() == expected)
            destination.flush(); os.fsync(destination.fileno())
            os.fchown(destination.fileno(),0,0)
            os.fchmod(destination.fileno(),0o444)
            os.fsync(destination.fileno())
        directory_fd = os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
        verify_copy()
    metadata = subprocess.check_output(['/usr/bin/dpkg-deb','-f',file,'Package','Version','Architecture'],env=env,text=True)
    require(metadata == 'Package: varin\nVersion: ' + version + '\nArchitecture: ' + arch + '\n')
    subprocess.run(['/usr/bin/dpkg','--install',file],env=env,check=True)
else:
    # Removal may target only the same package/version/architecture whose
    # verified immutable installer remains in this invocation's root scope.
    verify_copy()
    status = subprocess.check_output(['/usr/bin/dpkg-query','-W','-f','$'+'{Status}\t'+'$'+'{Version}\t'+'$'+'{Architecture}','varin'],env=env,text=True)
    require(status == 'install ok installed\t' + version + '\t' + arch)
    subprocess.run(['/usr/bin/dpkg','--remove','varin'],env=env,check=True)
`;
export function debianOperationArguments(operation,{installer,artifact,inventory},environment=process.env){
  if(!['install','remove'].includes(operation)||!path.isAbsolute(installer)||!/^[a-f0-9]{64}$/u.test(artifact?.sha256??'')||!Number.isSafeInteger(artifact.size)||artifact.size<1||!/^\d+$/u.test(environment.GITHUB_RUN_ID??'')||!/^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT??'')||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(inventory?.version??'')||!['amd64','arm64'].includes(inventory?.packageArchitecture))throw new Error('Invalid Debian privileged operation identity');
  return['-n','/usr/bin/python3','-I','-c',debianPackageOperation,operation,installer,artifact.sha256,String(artifact.size),environment.GITHUB_RUN_ID,environment.GITHUB_RUN_ATTEMPT,inventory.version,inventory.packageArchitecture];
}
export async function runDebianOperation(operation,admitted,options={}){
  requireAuthorizedLinuxInstall(options);
  const args=debianOperationArguments(operation,admitted);
  requireAuthorizedLinuxInstall(options);
  return runObserved('/usr/bin/sudo',args,{timeoutMs:operation==='install'?300_000:180_000});
}
export async function admitDebianCandidate(candidateFile,{sourceSha,architecture=process.arch}={}){
  const admitted=await admitCandidate(candidateFile,{sourceSha,platform:'linux',architecture});
  const {candidate}=admitted,installed=candidate.packaged.installed;
  if(installed?.format!=='deb'||installed.updatePolicy!=='package-manager'||!installed.artifact?.name?.endsWith('.deb'))throw new Error('Candidate has no Debian package-manager installation');
  const installer=await verifyRecord(candidate.assets,installed.artifact),inventoryFile=await verifyRecord(candidate.assets,installed.inventory);
  const inventory=validateDebianInventory(JSON.parse(await fs.readFile(inventoryFile,'utf8')),{sourceSha,architecture,version:candidate.version,artifactSha256:installed.artifact.sha256,runtimeManifestSha256:candidate.runtimeManifest.sha256});
  const actual=await inspectDebian(installer,{sourceSha,architecture,version:candidate.version,runtimeManifestSha256:candidate.runtimeManifest.sha256});
  if(!isDeepStrictEqual(actual,inventory))throw new Error('Debian package inspection differs from its recorded inventory');
  return{...admitted,installer,artifact:installed.artifact,inventory};
}
export function assertDebianStatus(status,inventory){
  if(status.trim()!==`install ok installed\t${inventory.version}\t${inventory.packageArchitecture}`)throw new Error('dpkg status does not match the installed candidate');
}
export async function verifyDebianInstalled(inventory,{root='/',packageFiles}={}){
  const full=p=>path.join(root,p),listed=packageFiles===undefined?null:new Set(packageFiles.split('\n').map(p=>p.replace(/^\//u,'')));
  const expected=new Map(inventory.entries.map(e=>[e.path,e]));
  for(const entry of inventory.entries){
    const file=full(entry.path),stat=await fs.lstat(file);
    if(listed&&!listed.has(entry.path))throw new Error('Installed candidate file is not owned by dpkg');
    if(stat.uid!==entry.uid||stat.gid!==entry.gid||(stat.mode&0o7777)!==entry.mode)throw new Error('Installed Debian ownership or mode differs from inventory');
    if(entry.type==='file'){
      if(!stat.isFile()||stat.size!==entry.size||await sha256(file)!==entry.sha256)throw new Error('Installed Debian bytes differ from inventory');
    }else if(entry.type==='directory'){if(!stat.isDirectory())throw new Error('Installed Debian directory is redirected');}
    else if(!stat.isSymbolicLink()||await fs.readlink(file)!==entry.link)throw new Error('Installed Debian link differs from inventory');
    if(entry.type!=='symlink'&&await fs.realpath(file)!==file)throw new Error('Installed Debian path has a redirected ancestor');
  }
  // All ancestors of privileged helpers must remain trustworthy, including
  // system directories which the package itself does not own.
  for(const helper of helperPaths){
    let directory=path.dirname(full(helper));
    while(true){const s=await fs.lstat(directory);if(!s.isDirectory()||s.uid!==0||s.gid!==0||(s.mode&0o022))throw new Error('Sandbox helper has an unsafe ancestor');if(directory===root)break;const next=path.dirname(directory);if(next===directory)break;directory=next;}
  }
  const visit=async relative=>{for(const name of await fs.readdir(full(relative))){const p=`${relative}/${name}`;if(!expected.has(p))throw new Error('Installed Debian tree has an unlisted file');if((await fs.lstat(full(p))).isDirectory())await visit(p);}};
  for(const directory of ['usr/share/Varin','usr/lib/Varin'])await visit(directory);
  return{filesVerified:inventory.entries.length,rootOwnedHelpersVerified:helperPaths.length};
}
export function assertLinuxSandboxReceipt(report){
  const result=report?.cases?.find(c=>c.name==='renderer-sandbox');
  const observed=result?.evidence;
  if(result?.status!=='passed'||observed?.source!=='operating-system'||!Array.isArray(observed.renderers)||!observed.renderers.length)throw new Error('Installed renderer sandbox has no native OS observations');
  for(const renderer of observed.renderers){
    if(renderer.seccomp!=='2'||renderer.noNewPrivileges!=='1'||!/^0+$/u.test(renderer.effectiveCapabilities??'')||renderer.noSandboxSwitch!==false||!Number.isInteger(renderer.pidNamespaceDepth)||!Number.isInteger(renderer.brokerNamespaceDepth)||renderer.pidNamespaceDepth<=renderer.brokerNamespaceDepth)throw new Error('Installed renderer lacks enforced Linux sandbox protections');
  }
  return{renderersVerified:observed.renderers.length,seccomp:true,noNewPrivileges:true,zeroEffectiveCapabilities:true,privatePidNamespace:true};
}
export async function smokeLinuxInstalled(candidateFile,options={}){
  requireAuthorizedLinuxInstall(options);
  if(!options.output)throw new Error('An observation output directory is required');
  for(const key of ['VARIN_DATA_DIR','VARIN_ELECTRON_PROFILE','VARIN_ELECTRON_DEV','CHROME_DEVEL_SANDBOX'])if(process.env[key])throw new Error('Installed Linux smoke refuses overridden profile or sandbox locations');
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:repository,encoding:'utf8'}).trim())throw new Error('Installed smoke requires immutable committed source');
  const {candidate,installer,artifact,inventory}=await admitDebianCandidate(candidateFile,{sourceSha});
  const output=path.resolve(options.output);await fs.mkdir(output,{recursive:false});
  const session=await createSmokeSession(),nonce=randomUUID(),profile=path.join(process.env.XDG_CONFIG_HOME||path.join(process.env.HOME,'.config'),'Varin');
  const evidence={schema:1,product:'varin-installed-product-smoke',target:candidate.target,sourceSha,version:candidate.version,runtimeManifestSha256:candidate.runtimeManifest.sha256,engineManifestSha256:candidate.engineManifest.sha256,artifacts:{[artifact.name]:artifact.sha256},installationKind:'system-debian',fixture:'synthetic-original-electron-and-application-data',complete:false,qualified:false,steps:[],notProven:['portable-appimage','signed-release','automatic-update','cross-version-upgrade','real-user-profile','default-tauri-data-root-uninstall','physical-desktop-permissions','cold-url-activation','original-electron-fixture-process-scope-drain']};
  let phase='preflight';
  const observe=async(name,operation)=>{phase=name;const result=await operation();evidence.steps.push({name,status:'passed',...result});return result;};
  try{
    if(await exists(profile))throw new Error('Refusing an existing original profile');
    for(const file of ['/usr/share/Varin','/usr/lib/Varin',...inventory.entries.filter(e=>e.type!=='directory').map(e=>`/${e.path}`)])if(await exists(file))throw new Error('Refusing an existing Varin installation');
    const packages=query(['-W','-f','${binary:Package}\t${Status}\n']).split('\n');
    if(packages.some(line=>/^varin(?::[^\t]+)?\t/u.test(line)))throw new Error('Refusing pre-existing Varin dpkg state');
    const fixtureExecutable=preparedFixtureEngine();
    await observe('seed-original-application-data',()=>runInstalledDataFixture('seed',candidate,session,nonce));
    await observe('seed-original-electron-profile',async()=>({observation:await seedOrVerify('seed',session,nonce,profile,path.join(output,'legacy-seed.json'),fixtureExecutable)}));
    await observe('reopen-original-electron-profile',async()=>({observation:await seedOrVerify('verify',session,nonce,profile,path.join(output,'legacy-before.json'),fixtureExecutable)}));
    const install=async()=>{
      await verifyRecord(candidate.assets,artifact);
      const actual=await inspectDebian(installer,{sourceSha,architecture:process.arch,version:candidate.version,runtimeManifestSha256:candidate.runtimeManifest.sha256});
      if(!isDeepStrictEqual(actual,inventory))throw new Error('Debian package changed before installation');
      await runDebianOperation('install',{installer,artifact,inventory},options);
      assertDebianStatus(query(['-W','-f','${Status}\t${Version}\t${Architecture}','varin']),inventory);
      const verified=await verifyDebianInstalled(inventory,{packageFiles:query(['-L','varin'])});
      if(await sha256(path.join(runtimeDirectory,'runtime-manifest.json'))!==candidate.runtimeManifest.sha256)throw new Error('Installed runtime manifest differs');
      await verifyRuntimeManifest(runtimeDirectory,{platform:'linux',architecture:process.arch});
      await verifyProtocolRegistration('/usr/bin/varin');
      return{method:'dpkg-install',...verified};
    };
    await observe('install-candidate',install);
    const launch=async(restart,file)=>{
      const native=await smokeNative(candidate,{output:path.join(output,file),installedExecutable:executable,installedInventory:inventory,session,retainData:true,legacyFixtureNonce:nonce,disposableUser:true,useOsProfile:true,restart,applicationData:true,protocolWarm:true,timeoutMs:300_000});
      const applicationData=await runInstalledDataFixture('verify',candidate,session,nonce,{runtime:runtimeDirectory});
      return{nativeReport:file,caseCount:native.report.cases.length,sandbox:assertLinuxSandboxReceipt(native.report),cleanupUncertain:native.cleanupUncertain,applicationData};
    };
    await observe('launch-and-migrate-installed-product',()=>launch(false,'installed-first.json'));
    await observe('replace-same-version-candidate',install);
    await observe('reopen-retained-target-state',()=>launch(true,'installed-reopen.json'));
    const marker=path.join(profile,'varin-installer-fixture.json'),before=await sha256(marker);
    await observe('uninstall-retain-data',async()=>{
      await runDebianOperation('remove',{installer,artifact,inventory},options);
      for(const file of ['/usr/share/Varin','/usr/lib/Varin',...inventory.entries.filter(e=>e.type!=='directory').map(e=>`/${e.path}`)])if(await exists(file))throw new Error('Debian uninstall left package files or desktop registration');
      if(query(['-W','-f','${binary:Package}\t${Status}\n']).split('\n').some(line=>/^varin(?::[^\t]+)?\t.* installed$/u.test(line)))throw new Error('dpkg still reports Varin installed');
      if(await sha256(marker)!==before||!await exists(path.join(session.data,'cef/application')))throw new Error('Uninstall did not preserve original and target profile data');
      return{method:'dpkg-remove',originalProfileRetained:true,isolatedTargetRetained:true};
    });
    await observe('reopen-application-data-after-uninstall',()=>runInstalledDataFixture('verify',candidate,session,nonce));
    await observe('reopen-original-profile-after-uninstall',async()=>({observation:await seedOrVerify('verify',session,nonce,profile,path.join(output,'legacy-after-uninstall.json'),fixtureExecutable)}));
    // Completed observations do not prove the original Electron fixture's descendant scope drained.
    // Preserve both synthetic profiles; individual Tauri native-drain observations remain unchanged.
    evidence.complete=true;evidence.cleanupUncertain=true;evidence.qualified=false;
    evidence.fixtureCleanup='not-verified';evidence.privateSessionRetained=true;evidence.retainedPrivateDirectory=session.root;
    await fs.writeFile(path.join(output,'installer-smoke.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
  }catch(error){
    evidence.failedStep=phase;evidence.failure=error.message;evidence.cleanupUncertain=true;evidence.retainedPrivateDirectory=session.root;if(error.observed)evidence.process=error.observed;
    await failRetainedObservation(path.join(output,'installer-smoke.json'),evidence,`Debian installed smoke failed at ${phase}.`);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),index=args.indexOf('--output');
  if(!args[0]||index<0||!args[index+1])throw new Error('Usage: linux-installed-smoke.mjs candidate.json --output NEW-DIRECTORY --disposable-runner --authorized-linux-sandbox-install');
  await smokeLinuxInstalled(args[0],{output:args[index+1],disposableRunner:args.includes('--disposable-runner'),authorizedLinuxSandboxInstall:args.includes('--authorized-linux-sandbox-install')});
}
