/** Disposable-runner observations of the real installer and private migration.
 * No release qualification, system component install, sandbox bypass or profile
 * database parsing. Never run on a developer's computer or self-hosted runner. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {sha256,relativePath,verifyRuntimeManifest} from './runtime-manifest.mjs';
import {createSmokeSession,smokeNative} from './smoke-native.mjs';
import {verifyProtocolRegistration} from './protocol-smoke.mjs';
import {isComplete,resolveElectronPackageDir,platformPath} from '../../electron/scripts/ensure-electron.mjs';
import {createStartupClassifier,readLinuxStartupState} from './linux-startup-diagnostics.mjs';

const repository=path.resolve(import.meta.dirname,'../../..');
const exists=async file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const sameWindowsPath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.win32.resolve(a).toLowerCase()===path.win32.resolve(b).toLowerCase();
export function requireDisposableRunner({acknowledged=false,environment=process.env,platform=process.platform}={}){
  if(!acknowledged||environment.GITHUB_ACTIONS!=='true'||environment.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('Installer smoke requires --disposable-runner on an ephemeral GitHub-hosted runner');
  if(!['win32','linux'].includes(platform))throw new Error('Installer smoke supports Windows NSIS and Linux portable AppImage only');
  if(!environment.RUNNER_TEMP)throw new Error('GitHub runner temporary directory is unavailable');
}
export function nsisArguments(directory,{uninstall=false}={}){
  if(!path.win32.isAbsolute(directory)||/["\r\n\0]/u.test(directory))throw new Error('NSIS destination must be an absolute unquoted Windows path');
  // NSIS parses /D= and _?= as the entire final, UNQUOTED command tail.
  // windowsVerbatimArguments below prevents Node from quoting paths with spaces.
  return uninstall?['/S','/currentuser','/KEEP_APP_DATA',`_?=${directory}`]:['/S','/currentuser',`/D=${directory}`];
}
export async function runObserved(file,args,{env=process.env,cwd,timeoutMs=180_000,windowsVerbatimArguments=false,startupDiagnostics=false}={}){
  return new Promise((resolve,reject)=>{
    let timer,timedOut=false;
    const classifier=startupDiagnostics?createStartupClassifier():null;
    const child=spawn(file,args,{env,cwd,stdio:['ignore','ignore',classifier?'pipe':'ignore'],windowsHide:true,detached:process.platform!=='win32',windowsVerbatimArguments});
    if(classifier)child.stderr.on('data',chunk=>classifier.write(chunk));
    child.once('error',error=>{clearTimeout(timer);const observed={spawnFailed:true,code:error.code??'unknown',timedOut,...(classifier?{startupSignatures:classifier.finish()}:{})};reject(Object.assign(new Error(`Process launch failed (${observed.code})`),{observed}));});
    // 'exit' can precede the last stderr chunk. Only closed streams provide a
    // complete signature observation; raw output is never returned or written.
    // This observes the direct process only, not completion of its descendants.
    child.once('close',(code,signal)=>{clearTimeout(timer);const observed={code,signal,timedOut,...(classifier?{startupSignatures:classifier.finish()}:{})};if(code===0&&!timedOut)resolve(observed);else reject(Object.assign(new Error(timedOut?'Process observation timed out; cleanup is unconfirmed':`Process failed (${signal??code})`),{observed}));});
    timer=setTimeout(()=>{
      timedOut=true;
      if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{child.kill();}}
      else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    },timeoutMs);
  });
}
export async function verifyRecord(directory,record){
  if(!record||typeof record.name!=='string'||path.basename(record.name)!==record.name||!record.name||!Number.isSafeInteger(record.size)||record.size<=0||!/^[a-f0-9]{64}$/u.test(record.sha256??''))throw new Error('Candidate artifact receipt is invalid');
  const file=path.join(directory,record.name),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size!==record.size||await sha256(file)!==record.sha256)throw new Error('Candidate artifact bytes differ from the same-source receipt');
  return file;
}
export async function admitCandidate(candidateFile,{sourceSha,platform=process.platform,architecture=process.arch}={}){
  const candidate=JSON.parse(await fs.readFile(candidateFile,'utf8'));
  if(candidate.schema!==1||candidate.target!==`${platform}-${architecture}`||!sourceSha||candidate.sourceSha!==sourceSha||!/^[a-f0-9]{40}$/u.test(sourceSha)||candidate.packaged?.mode!=='electron-to-tauri'||candidate.packaged.platform!==platform||candidate.packaged.architecture!==architecture||candidate.packaged.version!==candidate.version)throw new Error('Installer smoke requires a matching same-SHA native transition candidate');
  // Receipts and installers travel together. Do not follow arbitrary assets paths
  // from a stale/relocated candidate.json to an unrelated build generation.
  candidate.assets=path.join(path.dirname(path.resolve(candidateFile)),'assets');
  const runtimeFile=await verifyRecord(candidate.assets,candidate.runtimeManifest);
  const engineFile=await verifyRecord(candidate.assets,candidate.engineManifest);
  const runtime=JSON.parse(await fs.readFile(runtimeFile,'utf8')),engine=JSON.parse(await fs.readFile(engineFile,'utf8'));
  if(runtime.sources?.sourceSha!==sourceSha||runtime.legacyElectron?.sourceSha!==sourceSha||runtime.platform!==platform||runtime.architecture!==architecture||engine.sourceSha!==sourceSha||engine.architecture!==architecture||candidate.packaged.runtimeManifestSha256!==candidate.runtimeManifest.sha256)throw new Error('Candidate runtime, exporter or engine belongs to another generation');
  const extension=platform==='win32'?'.exe':'.AppImage';
  const installers=candidate.packaged.electron?.filter(record=>record.name?.endsWith(extension));
  if(installers?.length!==1)throw new Error('Candidate has no unambiguous original-format installer');
  const installer=await verifyRecord(candidate.assets,installers[0]);
  if(candidate.packaged.update.name!==installers[0].name||candidate.packaged.update.sha256!==installers[0].sha256)throw new Error('Installer and update candidate bytes differ');
  return{candidate,runtime,engine,installer,artifact:installers[0]};
}
export async function verifyInstalledFiles(directory,engine){
  if(!Array.isArray(engine.files)||!engine.files.length)throw new Error('Native engine inventory is absent');
  const root=await fs.realpath(directory),seen=new Set();
  for(const entry of engine.files){
    relativePath(entry.path);if(seen.has(entry.path))throw new Error('Native engine has duplicate paths');seen.add(entry.path);
    const file=path.join(directory,entry.path),stat=await fs.lstat(file),real=await fs.realpath(file);
    if(real!==root&&!real.startsWith(root+path.sep))throw new Error('Installed native file escaped the installation');
    if(entry.link){if(!stat.isSymbolicLink()||await fs.readlink(file)!==entry.link)throw new Error('Installed native link differs from the candidate');}
    else if(!stat.isFile()||stat.size!==entry.size||await sha256(file)!==entry.sha256)throw new Error('Installed native bytes differ from the candidate');
  }
  return{filesVerified:seen.size};
}
async function readWindowsState(){
  const require=createRequire(path.join(repository,'packages/electron/package.json'));
  const original=require('./package.json'),builder=createRequire(require.resolve('electron-builder'));
  const dependency=createRequire(builder.resolve('app-builder-lib'));
  const {UUID}=dependency('builder-util-runtime');
  const guid=original.build.nsis.guid||UUID.v5(original.build.appId,UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  const script=String.raw`
$ErrorActionPreference = 'Stop'
$uninstall = @(); $protocol = @(); $notifications = @(); $installations = @()
foreach ($hive in @('HKCU','HKLM')) {
  foreach ($prefix in @('Software','Software\WOW6432Node')) {
    $key = $hive + ':\' + $prefix + '\' + $env:VARIN_INSTALLER_APP_GUID
    if(Test-Path -LiteralPath $key) { $installations += @{hive=$hive; location=(Get-Item -LiteralPath $key).GetValue('InstallLocation')} }
  }
  foreach ($suffix in @('Software\Microsoft\Windows\CurrentVersion\Uninstall','Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    $root = $hive + ':\' + $suffix
    if (Test-Path -LiteralPath $root) {
      foreach ($key in Get-ChildItem -LiteralPath $root) {
        $item = Get-ItemProperty -LiteralPath $key.PSPath
        if ($item.DisplayName -eq 'Varin' -or $key.PSChildName -eq $env:VARIN_INSTALLER_APP_GUID) { $uninstall += @{hive=$hive; key=$key.PSChildName; command=$item.UninstallString; version=$item.DisplayVersion} }
      }
    }
  }
  $key = $hive + ':\Software\Classes\varin'
  if (Test-Path -LiteralPath $key) {
    $command = $key + '\shell\open\command'
    $protocol += @{hive=$hive; owner=(Get-Item -LiteralPath $key).GetValue('VarinProtocolOwner'); command=$(if(Test-Path -LiteralPath $command){(Get-Item -LiteralPath $command).GetValue('')}else{''})}
  }
  foreach ($suffix in @('Software\Classes\CLSID\{34EDFA49-F833-482E-A268-C1D3610E6F17}','Software\Classes\AppUserModelId\dev.varin.desktop')) {
    if(Test-Path -LiteralPath ($hive + ':\' + $suffix)) { $notifications += @{hive=$hive; key=$suffix} }
  }
}
$shortcuts = @()
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @('DesktopDirectory','Programs','CommonPrograms','CommonDesktopDirectory')) {
  $directory = [Environment]::GetFolderPath($folder)
  if ($directory) { $file = Join-Path $directory 'Varin.lnk'; if(Test-Path -LiteralPath $file) { $shortcuts += @{file=$file; target=$shell.CreateShortcut($file).TargetPath} } }
}
@{appData=[Environment]::GetFolderPath('ApplicationData'); installations=@($installations); uninstall=@($uninstall); protocol=@($protocol); notifications=@($notifications); shortcuts=@($shortcuts)} | ConvertTo-Json -Compress -Depth 5
`;
  // Fixed registry keys and paths only. No profile content or environment dump.
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,VARIN_INSTALLER_APP_GUID:guid},encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:1024*1024,timeout:30_000}));
}
export function assertCleanWindowsState(state){
  if(['installations','uninstall','protocol','notifications','shortcuts'].some(key=>!Array.isArray(state[key])||state[key].length))throw new Error('Refusing a runner with an existing Varin installation or OS registration');
  if(!path.win32.isAbsolute(state.appData??''))throw new Error('Native Windows AppData is unavailable');
}
export function assertInstalledWindowsState(state,directory,version){
  const executable=path.win32.join(directory,'varin.exe');
  if(state.installations.length!==1||state.installations[0].hive!=='HKCU'||!sameWindowsPath(state.installations[0].location,directory)||state.uninstall.length!==1||state.uninstall[0].hive!=='HKCU'||state.uninstall[0].version!==version)throw new Error('Original NSIS per-user uninstall registration is missing or belongs to another install');
  if(state.protocol.length!==1||state.protocol[0].hive!=='HKCU'||!sameWindowsPath(state.protocol[0].owner,executable)||state.protocol[0].command?.toLowerCase()!==`"${executable}" "%1"`.toLowerCase())throw new Error('Installed Varin URL registration differs from the real executable');
  if(state.notifications.length!==2||state.notifications.some(entry=>entry.hive!=='HKCU'))throw new Error('Installed notification registration is missing or changed scope');
  if(!state.shortcuts.length||state.shortcuts.some(entry=>!sameWindowsPath(entry.target,executable)))throw new Error('Original NSIS shortcuts do not launch the installed product');
}
export function preparedFixtureEngine(){
  if(process.env.ELECTRON_OVERRIDE_DIST_PATH||(process.env.npm_config_platform&&process.env.npm_config_platform!==process.platform)||(process.env.npm_config_arch&&process.env.npm_config_arch!==process.arch))throw new Error('Installer fixture requires the native repository-pinned Electron, not an environment override');
  const directory=resolveElectronPackageDir();
  // Electron 45's require('electron') can download implicitly. Reuse the
  // existing preparer's read-only check, and fail if explicit preparation was
  // omitted. The runner invokes ensure-electron.mjs before this command.
  if(!directory||!isComplete(directory,process.arch))throw new Error('Run node packages/electron/scripts/ensure-electron.mjs explicitly before installer smoke');
  return path.join(directory,'dist',platformPath());
}
export async function seedOrVerify(mode,session,nonce,profile,output,fixtureExecutable,{isolatedPreflight=false}={}){
  const require=createRequire(path.join(repository,'packages/electron/package.json'));
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','VARIN_ELECTRON_DEV','VARIN_ELECTRON_PROFILE'])delete env[key];
  if(isolatedPreflight){
    if(process.platform!=='linux'||profile!==path.join(session.root,'preflight-profile'))throw new Error('Preflight requires its own Linux synthetic profile');
    Object.assign(env,{HOME:session.home,XDG_CONFIG_HOME:path.join(session.home,'.config'),XDG_CACHE_HOME:path.join(session.home,'.cache'),XDG_DATA_HOME:path.join(session.home,'.local/share'),XDG_STATE_HOME:path.join(session.home,'.local/state')});
    for(const key of ['XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME'])await fs.mkdir(env[key],{recursive:true,mode:0o700});
  }
  await fs.rm(path.join(session.root,`legacy-${mode}.json`),{force:true});
  await runObserved(fixtureExecutable,[path.join(import.meta.dirname,'legacy-profile-smoke.cjs'),'--varin-installer-fixture',mode,session.root,nonce,profile,...(isolatedPreflight?['--isolated-preflight']:[])],{env,timeoutMs:90_000,startupDiagnostics:process.platform==='linux'});
  const evidence=JSON.parse(await fs.readFile(path.join(session.root,`legacy-${mode}.json`),'utf8'));
  if(evidence.schema!==1||evidence.product!=='varin-legacy-profile-smoke'||evidence.profileScope!==(isolatedPreflight?'isolated-preflight':'original-os-profile')||evidence.mode!==mode||evidence.nonce!==nonce||evidence.complete!==true||evidence.frontendVerified!==true||evidence.credentialSlotsVerified!==6||evidence.browserCookieVerified!==true||evidence.browserLocalStorageVerified!==true||evidence.valuesDisclosed!==false||evidence.electronVersion!==require('electron/package.json').version)throw new Error('Original Electron did not verify its synthetic profile');
  await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');return evidence;
}
export async function preflightFixture({output,disposableRunner=false}={}){
  requireDisposableRunner({acknowledged:disposableRunner});
  if(process.platform!=='linux')throw new Error('Isolated fixture preflight supports Linux only');
  if(!output)throw new Error('An observation output directory is required');
  output=path.resolve(output);await fs.mkdir(output,{recursive:false});
  const session=await createSmokeSession(),nonce=randomUUID(),profile=path.join(session.root,'preflight-profile');
  const evidence={schema:1,product:'varin-legacy-fixture-preflight',target:`${process.platform}-${process.arch}`,
    fixture:'isolated-synthetic-original-electron-profile',complete:false,steps:[],
    notProven:['installed-product','original-os-profile-handoff','native-cef-sandbox','signed-release'],
    linuxStartupState:await readLinuxStartupState()};
  let phase='verify-prepared-fixture-engine';
  try{
    const fixtureExecutable=preparedFixtureEngine();
    evidence.steps.push({name:phase,status:'passed',source:'repository-pinned-original-electron'});
    for(const mode of ['seed','verify']){
      phase=`${mode}-isolated-original-electron-profile`;
      const observation=await seedOrVerify(mode,session,nonce,profile,path.join(output,`legacy-${mode}.json`),fixtureExecutable,{isolatedPreflight:true});
      evidence.steps.push({name:phase,status:'passed',observation});
    }
    // Successful synthetic readback is not proof that the original native
    // process scope drained. Leave this private session for runner disposal.
    evidence.complete=true;evidence.cleanupUncertain=true;
    evidence.privateSessionRetained=true;evidence.retainedPrivateDirectory=session.root;
    await fs.writeFile(path.join(output,'fixture-preflight.json'),JSON.stringify(evidence,null,2)+'\n');
    return evidence;
  }catch(error){
    evidence.failedStep=phase;evidence.failure=error.message;evidence.cleanupUncertain=true;evidence.retainedPrivateDirectory=session.root;
    if(error.observed)evidence.process=error.observed;
    await fs.writeFile(path.join(output,'fixture-preflight.json'),JSON.stringify(evidence,null,2)+'\n');
    throw new Error(`Original Electron fixture preflight failed at ${phase}; inspect fixture-preflight.json. Private data was retained.`);
  }
}
export async function smokeInstaller(candidateFile,{output,disposableRunner=false}={}){
  requireDisposableRunner({acknowledged:disposableRunner});
  if(!output)throw new Error('An observation output directory is required');
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:repository,encoding:'utf8'}).trim())throw new Error('Installer observations require the immutable committed candidate source');
  const admitted=await admitCandidate(candidateFile,{sourceSha});
  const{candidate,engine,installer,artifact}=admitted;
  output=path.resolve(output);await fs.mkdir(output,{recursive:false});
  const session=await createSmokeSession(),nonce=randomUUID(),windows=process.platform==='win32';
  const installation=path.join(session.root,'Installed Varin');
  const executable=windows?path.join(installation,'varin.exe'):path.join(installation,'Varin.AppImage');
  const evidence={schema:1,product:'varin-installed-product-smoke',target:candidate.target,sourceSha,version:candidate.version,
    runtimeManifestSha256:candidate.runtimeManifest.sha256,engineManifestSha256:candidate.engineManifest.sha256,
    artifacts:{[artifact.name]:artifact.sha256},installationKind:windows?'original-nsis-per-user':'portable-appimage',fixture:'synthetic-original-electron-profile',
    complete:false,steps:[],notProven:['signed-release','automatic-update','cross-version-upgrade','real-user-profile','default-tauri-data-root-uninstall','physical-desktop-permissions','cold-url-activation',...(!windows?['system-installation','desktop-registration-uninstall']:[])]};
  let phase='preflight',profile;
  const record=(name,detail={})=>evidence.steps.push({name,status:'passed',...detail});
  const observe=async(name,operation)=>{phase=name;const value=await operation();record(name,value);return value;};
  try{
    if(!windows)evidence.linuxStartupState=await readLinuxStartupState();
    if(windows){const state=await readWindowsState();assertCleanWindowsState(state);profile=path.join(state.appData,'Varin');}
    else profile=path.join(process.env.XDG_CONFIG_HOME||path.join(process.env.HOME,'.config'),'Varin');
    if(await exists(profile))throw new Error('Refusing an existing legacy profile; synthetic fixtures never adopt or remove original user data');
    record('disposable-empty-os-user');
    phase='verify-prepared-fixture-engine';
    const fixtureExecutable=preparedFixtureEngine();
    record(phase,{source:'repository-pinned-original-electron',installedExporterUnchanged:true});
    await observe('seed-original-electron-profile',async()=>({observation:await seedOrVerify('seed',session,nonce,profile,path.join(output,'legacy-seed.json'),fixtureExecutable)}));
    await observe('reopen-original-electron-profile',async()=>({observation:await seedOrVerify('verify',session,nonce,profile,path.join(output,'legacy-before.json'),fixtureExecutable)}));
    const install=async()=>{
      if(windows)await runObserved(installer,nsisArguments(installation),{windowsVerbatimArguments:true,timeoutMs:300_000});
      else{await fs.mkdir(installation,{recursive:true});await fs.copyFile(installer,executable);await fs.chmod(executable,0o755);}
      if(windows){
        await verifyInstalledFiles(installation,engine);
        const runtime=path.join(installation,'runtime');
        if(await sha256(path.join(runtime,'runtime-manifest.json'))!==candidate.runtimeManifest.sha256)throw new Error('Installed runtime receipt differs from the candidate');
        await verifyRuntimeManifest(runtime,{platform:process.platform,architecture:process.arch});
        assertInstalledWindowsState(await readWindowsState(),installation,candidate.version);
        await verifyProtocolRegistration(executable);
      }else if(await sha256(executable)!==artifact.sha256)throw new Error('Portable installed bytes differ from the actual AppImage');
      return{method:windows?'original-nsis-silent-current-user':'portable-artifact-copy',sameCandidateBytes:true};
    };
    await observe('install-candidate',install);
    const launch=async(restart,file)=>{
      const native=await smokeNative(candidate,{output:path.join(output,file),installedExecutable:executable,session,retainData:true,
        legacyFixtureNonce:nonce,disposableUser:true,useOsProfile:true,restart,protocolWarm:windows,timeoutMs:300_000});
      return{nativeReport:file,caseCount:native.report.cases.length,cleanupUncertain:native.cleanupUncertain};
    };
    await observe('launch-and-migrate-installed-product',()=>launch(false,'installed-first.json'));
    await observe('replace-same-version-candidate',install);
    await observe('reopen-retained-target-state',()=>launch(true,'installed-reopen.json'));
    // Keep a byte identity for an original source marker, never secret content.
    const sourceMarker=path.join(profile,'varin-installer-fixture.json'),before=await sha256(sourceMarker);
    await observe('uninstall-retain-data',async()=>{
      if(windows){
        const state=await readWindowsState();assertInstalledWindowsState(state,installation,candidate.version);
        const names=(await fs.readdir(installation)).filter(name=>/^Uninstall .*\.exe$/iu.test(name));
        if(names.length!==1)throw new Error('Original NSIS uninstaller is absent or ambiguous');
        const original=path.join(installation,names[0]);
        if(!state.uninstall[0].command?.includes(`"${original}"`))throw new Error('Original registered uninstaller differs from the installed file');
        const uninstaller=path.join(session.root,'observed-uninstaller.exe');await fs.copyFile(original,uninstaller);
        if(await sha256(original)!==await sha256(uninstaller))throw new Error('Original uninstaller copy changed');
        await runObserved(uninstaller,nsisArguments(installation,{uninstall:true}),{windowsVerbatimArguments:true,timeoutMs:180_000,cwd:session.root});
        if(await exists(installation))throw new Error('Original uninstaller left its installation directory');
        assertCleanWindowsState(await readWindowsState());
      }else{await fs.unlink(executable);await fs.rmdir(installation);}
      if(await sha256(sourceMarker)!==before||!await exists(path.join(session.data,'cef/application')))throw new Error('Uninstall did not preserve the admitted profile and isolated target data');
      return{method:windows?'original-nsis-uninstaller-keep-data':'portable-file-removal',originalProfileRetained:true,isolatedTargetRetained:true};
    });
    await observe('reopen-original-profile-after-uninstall',async()=>({observation:await seedOrVerify('verify',session,nonce,profile,path.join(output,'legacy-after-uninstall.json'),fixtureExecutable)}));
    // The final original-Electron readback observes only its direct process
    // close. Earlier Tauri native-drain receipts do not cover that later scope.
    // Retain both private and original profiles for disposal of the whole runner.
    evidence.complete=true;evidence.qualified=false;evidence.cleanupUncertain=true;
    evidence.fixtureCleanup='not-verified';evidence.privateSessionRetained=true;
    evidence.retainedPrivateDirectory=session.root;
    evidence.notProven.push('original-electron-fixture-process-scope-drain');
    await fs.writeFile(path.join(output,'installer-smoke.json'),JSON.stringify(evidence,null,2)+'\n');
    return evidence;
  }catch(error){
    evidence.failedStep=phase;evidence.failure=error.message;evidence.cleanupUncertain=true;evidence.retainedPrivateDirectory=session.root;
    if(error.observed)evidence.process=error.observed;
    // A failed/unknown owner is never followed by file cleanup or a second install.
    await fs.writeFile(path.join(output,'installer-smoke.json'),JSON.stringify(evidence,null,2)+'\n');
    throw new Error(`Installed product smoke failed at ${phase}; inspect installer-smoke.json. Private data was retained.`);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),index=args.indexOf('--output');
  if(!args[0]||index<0||!args[index+1])throw new Error('Usage: installer-smoke.mjs candidate.json|--preflight --output NEW-DIRECTORY --disposable-runner');
  const options={output:args[index+1],disposableRunner:args.includes('--disposable-runner')};
  if(args[0]==='--preflight')await preflightFixture(options);else await smokeInstaller(args[0],options);
}
