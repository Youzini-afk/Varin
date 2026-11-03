/** Observe the exact DMG's copy-install/replacement/removal on a disposable Mac.
 * This is not Gatekeeper, a system-wide install, or signed-release qualification. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {relativePath,sha256,verifyRuntimeManifest} from './runtime-manifest.mjs';
import {createSmokeSession,smokeNative,validateNativeSmoke} from './smoke-native.mjs';
import {runInstalledDataFixture} from './installed-data-fixture.mjs';
import {failRetainedObservation,preparedFixtureEngine,runObserved,seedOrVerify,verifyInstalledFiles,verifyRecord} from './installer-smoke.mjs';

const repository=path.resolve(import.meta.dirname,'../../..');
const runtimeRelative='Contents/Resources/runtime';
const bundleIdentifier='dev.varin.desktop';
const lsregister='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const exists=async file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});

export function requireDisposableMac({acknowledged=false,environment=process.env,platform=process.platform}={}){
  if(!acknowledged||environment.GITHUB_ACTIONS!=='true'||environment.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('macOS installation smoke requires --disposable-runner on an ephemeral GitHub-hosted runner');
  if(platform!=='darwin'||environment.RUNNER_OS!=='macOS'||!path.posix.isAbsolute(environment.RUNNER_TEMP??''))throw new Error('macOS installation smoke requires the native macOS runner and its temporary directory');
  // The original OS profile is deliberate. Do not silently redirect its owner.
  if(environment.CFFIXED_USER_HOME||environment.VARIN_DATA_DIR||environment.VARIN_ELECTRON_PROFILE||environment.VARIN_ELECTRON_DEV)throw new Error('macOS installation smoke refuses overridden user/profile locations');
}

export async function admitMacCandidate(candidateFile,{sourceSha,architecture=process.arch}={}){
  if(!(await fs.lstat(candidateFile)).isFile())throw new Error('Candidate receipt must be a regular file');
  const directory=path.dirname(await fs.realpath(candidateFile));
  const candidate=JSON.parse(await fs.readFile(candidateFile,'utf8'));
  const recordedPayload=candidate.payload;
  if(candidate.schema!==1||!['x64','arm64'].includes(architecture)||candidate.target!==`darwin-${architecture}`||!/^[a-f0-9]{40}$/u.test(sourceSha??'')||candidate.sourceSha!==sourceSha||candidate.packaged?.mode!=='electron-to-tauri'||candidate.packaged.platform!=='darwin'||candidate.packaged.architecture!==architecture||candidate.packaged.version!==candidate.version)throw new Error('macOS installation smoke requires a matching same-SHA native transition candidate');
  candidate.assets=path.join(directory,'assets');
  candidate.payload=path.join(directory,'Varin.app');
  candidate.runtime=path.join(candidate.payload,runtimeRelative);
  if(await fs.realpath(candidate.assets)!==candidate.assets)throw new Error('Candidate assets directory is redirected');
  const runtimeFile=await verifyRecord(candidate.assets,candidate.runtimeManifest);
  const engineFile=await verifyRecord(candidate.assets,candidate.engineManifest);
  const runtime=JSON.parse(await fs.readFile(runtimeFile,'utf8')),engine=JSON.parse(await fs.readFile(engineFile,'utf8'));
  if(runtime.sources?.sourceSha!==sourceSha||runtime.legacyElectron?.sourceSha!==sourceSha||runtime.platform!=='darwin'||runtime.architecture!==architecture||runtime.version!==candidate.version||engine.schema!==1||engine.engine!=='CEF'||engine.sandbox!=='required'||engine.sourceSha!==sourceSha||engine.architecture!==architecture||candidate.packaged.runtimeManifestSha256!==candidate.runtimeManifest.sha256)throw new Error('Candidate runtime, exporter or engine belongs to another generation');
  const artifacts=candidate.packaged.electron;
  if(!Array.isArray(artifacts)||artifacts.length!==2||artifacts.filter(record=>record.name?.endsWith('.dmg')).length!==1||artifacts.filter(record=>record.name?.endsWith('.zip')).length!==1||!candidate.packaged.update?.name?.endsWith('.app.tar.gz'))throw new Error('Candidate lacks unambiguous original macOS DMG/ZIP and Tauri update artifacts');
  for(const artifact of [...artifacts,candidate.packaged.update])await verifyRecord(candidate.assets,artifact);
  const artifact=artifacts.find(record=>record.name.endsWith('.dmg'));
  return{candidate,engine,runtime,artifact,recordedPayload,installer:path.join(candidate.assets,artifact.name)};
}

/** Exact engine inventory, including internal framework symlinks and executable
 * bits. Runtime verification separately rejects unlisted files and all links. */
export async function verifyMacEngine(directory,engine){
  if(!(await fs.lstat(directory)).isDirectory()||await fs.realpath(directory)!==directory)throw new Error('macOS app directory is redirected');
  await verifyInstalledFiles(directory,engine);
  const expected=new Map(engine.files.map(entry=>[entry.path,entry])),seen=new Set();
  for(const entry of engine.files){
    relativePath(entry.path);
    if(entry.path===runtimeRelative||entry.path.startsWith(runtimeRelative+'/'))throw new Error('Engine inventory must not overlap its separately verified runtime');
    if(!entry.link&&typeof entry.executable!=='boolean')throw new Error('Engine inventory lacks executable mode evidence');
  }
  const visit=async relative=>{
    if(relative===runtimeRelative){
      if(!(await fs.lstat(path.join(directory,relative))).isDirectory())throw new Error('Packaged runtime directory is redirected');
      return;
    }
    const file=path.join(directory,relative),stat=await fs.lstat(file);
    if(stat.isDirectory()){for(const name of await fs.readdir(file))await visit(relative?`${relative}/${name}`:name);return;}
    const entry=expected.get(relative);
    if(!entry)throw new Error('macOS app contains an unlisted engine file');
    if(!stat.isFile()&&!stat.isSymbolicLink())throw new Error('macOS app contains a special file');
    if(stat.isFile()&&Boolean(stat.mode&0o111)!==entry.executable)throw new Error('macOS engine executable mode differs from its receipt');
    seen.add(relative);
  };
  await visit('');
  if(seen.size!==expected.size)throw new Error('macOS engine inventory includes missing or directory entries');
  return{filesVerified:seen.size};
}

function readCommand(file,args,{input}={}){
  try{return execFileSync(file,args,{input,encoding:'utf8',stdio:['pipe','pipe','ignore'],timeout:60_000,maxBuffer:16*1024*1024});}
  catch{throw new Error(`Read-only macOS observation failed: ${path.basename(file)}`);}
}
const plist=(value,kind)=>JSON.parse(readCommand('/usr/bin/swift',[path.join(import.meta.dirname,'macos-plist-observation.swift'),kind],{input:value}));
const readImages=()=>plist(readCommand('/usr/bin/hdiutil',['info','-plist']),'images');
const readMacState=()=>JSON.parse(readCommand('/usr/bin/swift',[path.join(import.meta.dirname,'macos-installation-state.swift')]));

export function assertMacState(state,{home,ownedApplications=[],requireEmpty=false}={}){
  if(state?.schema!==1||!path.posix.isAbsolute(state.home??'')||state.home==='/'||state.home!==home||state.applicationSupport!==path.posix.join(home,'Library/Application Support')||!Array.isArray(state.registeredApplications)||state.registeredApplications.some(value=>typeof value!=='string'||!path.posix.isAbsolute(value))||!Array.isArray(state.runningApplications)||(state.schemeHandler!==null&&typeof state.schemeHandler!=='string'))throw new Error('Native macOS user or LaunchServices observation is unavailable or redirected');
  if(state.runningApplications.length)throw new Error('Refusing an active Varin application scope');
  if(state.registeredApplications.some(value=>requireEmpty||!ownedApplications.includes(value))||state.schemeHandler!==null&&(requireEmpty||state.schemeHandler!==bundleIdentifier||!state.registeredApplications.length))throw new Error('Refusing an existing or foreign Varin installation or OS registration');
}

export function ownsBuildRegistration(payload,recordedPayload,{repositoryRoot=repository}={}){
  // An existing build tool may have exposed the app to LaunchServices. This
  // exception covers one original output, never an arbitrary same-ID app or a
  // relocated candidate. Its complete bytes are verified before it is allowed.
  return typeof payload==='string'&&payload===recordedPayload&&path.resolve(payload)===payload&&path.basename(payload)==='Varin.app'&&payload.startsWith(path.join(repositoryRoot,'artifacts')+path.sep);
}

export function macProfilePaths(home){
  return ['Library/Application Support/Varin','Library/Application Support/dev.varin.desktop','Library/Caches/dev.varin.desktop','Library/Preferences/dev.varin.desktop.plist','Library/Saved Application State/dev.varin.desktop.savedState'].map(value=>path.posix.join(home,value));
}

export function assertOwnedMount(images,disk,{installer,mountpoint}){
  if(!Array.isArray(images?.images))throw new Error('Disk-image observation is unavailable');
  const matching=images.images.filter(image=>image['image-path']===installer);
  const mounts=matching.flatMap(image=>(image['system-entities']??[]).filter(entity=>entity['mount-point']));
  if(matching.length!==1||mounts.length!==1||mounts[0]['mount-point']!==mountpoint||typeof mounts[0]['dev-entry']!=='string'||!/^\/dev\/disk\d+(?:s\d+)*$/u.test(mounts[0]['dev-entry'])||disk?.MountPoint!==mountpoint||disk.ReadOnlyVolume!==true||disk.ReadOnlyMedia!==true||disk.DeviceNode!==mounts[0]['dev-entry'])throw new Error('DMG is not an unambiguous read-only mount of this exact candidate at the private mountpoint');
  return{readOnly:true,device:disk.DeviceNode};
}

export function assertNativeDrain(observation){
  if(observation?.cleanupUncertain!==false||observation.timedOut!==false||observation.status?.code!==0||observation.status?.signal)throw new Error('Native application scope completion is unconfirmed');
  validateNativeSmoke(observation.report,{nonce:observation.report?.nonce,platform:'darwin',requiredCases:['native-drain','legacy-native-migration']});
  const drain=observation.report.cases.find(entry=>entry.name==='native-drain').evidence;
  if(drain?.browserOwnerDrained!==true||drain.applicationAndHostScopesEnded!==true)throw new Error('Native drain lacks original browser/application/Host scope terminal evidence');
}

/** A failure stops here: no finally-based unmount, replacement or cleanup can
 * run after an unknown install, live scope, timed-out child or failed detach. */
export async function runMacInstallationLifecycle(operations){
  await operations.seed();
  await operations.verifySourceBefore();
  await operations.mount();
  await operations.install();
  assertNativeDrain(await operations.launch(false));
  await operations.replace();
  assertNativeDrain(await operations.launch(true));
  await operations.unregisterOwned();
  await operations.uninstall();
  await operations.verifySourceAfter();
  await operations.detach();
  // The standalone Electron reader has only direct-child exit evidence. The
  // preceding Tauri drain cannot authorize cleanup of that later fixture scope.
  await operations.retainSession();
}

export async function smokeMacInstaller(candidateFile,{output,disposableRunner=false}={}){
  requireDisposableMac({acknowledged:disposableRunner});
  if(!output)throw new Error('An observation output directory is required');
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:repository,encoding:'utf8'}).trim())throw new Error('Installer observations require the immutable committed candidate source');
  const{candidate,engine,artifact,installer,recordedPayload}=await admitMacCandidate(candidateFile,{sourceSha});
  output=path.resolve(output);await fs.mkdir(output,{recursive:false});
  const temporary=await createSmokeSession(),root=await fs.realpath(temporary.root);
  const session={root,data:path.join(root,'data'),home:path.join(root,'home')};
  const mountpoint=path.join(root,'dmg'),mountedApp=path.join(mountpoint,'Varin.app');
  const installRoot=path.join(root,'Installed Varin'),installedApp=path.join(installRoot,'Varin.app'),executable=path.join(installedApp,'Contents/MacOS/varin');
  const nonce=randomUUID(),profile=path.join(process.env.HOME??'','Library/Application Support/Varin');
  const evidence={schema:1,product:'varin-installed-product-smoke',target:candidate.target,sourceSha,version:candidate.version,
    runtimeManifestSha256:candidate.runtimeManifest.sha256,engineManifestSha256:candidate.engineManifest.sha256,
    artifacts:{[artifact.name]:artifact.sha256},installationKind:'macos-dmg-private-copy',fixture:'synthetic-original-electron-and-application-data',
    complete:false,qualified:false,steps:[],notProven:['signed-release','gatekeeper-quarantine-assessment','automatic-update','cross-version-upgrade','real-user-profile','default-tauri-data-root-uninstall','system-applications-installation','zip-or-tar-installation','default-url-handler','cold-url-activation','physical-desktop-permissions','original-electron-fixture-process-scope-drain']};
  let phase='preflight',mountAttempted=false,mounted=false,detachConfirmed=false;
  const observe=async(name,operation)=>{phase=name;const detail=await operation();evidence.steps.push({name,status:'passed',...detail});return detail;};
  const buildRegistrationOwned=ownsBuildRegistration(candidate.payload,recordedPayload);
  const stateOptions={home:process.env.HOME,ownedApplications:[installedApp,mountedApp,...(buildRegistrationOwned?[candidate.payload]:[])]};
  const verifyApp=async directory=>{
    const verified=await verifyMacEngine(directory,engine),runtime=path.join(directory,runtimeRelative);
    if(await sha256(path.join(runtime,'runtime-manifest.json'))!==candidate.runtimeManifest.sha256)throw new Error('Installed runtime receipt differs from the candidate');
    await verifyRuntimeManifest(runtime,{platform:'darwin',architecture:process.arch});
    const info=plist(await fs.readFile(path.join(directory,'Contents/Info.plist')),'app');
    if(info.CFBundleIdentifier!==bundleIdentifier||info.CFBundleExecutable!=='varin'||info.CFBundleShortVersionString!==candidate.version)throw new Error('Installed macOS app identity differs from the candidate');
    return verified;
  };
  const verifyOwnedDirectory=async directory=>{
    if(!directory.startsWith(root+path.sep)||!(await fs.lstat(root)).isDirectory()||await fs.realpath(root)!==root||!(await fs.lstat(directory)).isDirectory()||await fs.realpath(directory)!==directory)throw new Error('Private installation path is no longer owned by this invocation');
  };
  try{
    await observe('disposable-empty-os-user',async()=>{
      const state=readMacState();
      await verifyApp(candidate.payload);
      assertMacState(state,{home:process.env.HOME,ownedApplications:buildRegistrationOwned?[candidate.payload]:[]});
      for(const file of [...macProfilePaths(process.env.HOME),'/Applications/Varin.app',path.join(process.env.HOME,'Applications/Varin.app')])if(await exists(file))throw new Error('Refusing an existing Varin installation or profile; synthetic fixtures never adopt or remove original user data');
      // Only the exact, fully verified original build output can precede this
      // invocation. No generated-source registration is treated as a user app.
      if(state.registeredApplications.length){
        await runObserved(lsregister,['-u',candidate.payload],{timeoutMs:60_000});
        assertMacState(readMacState(),{...stateOptions,requireEmpty:true});
      }
      return{userScope:'ephemeral-github-hosted',preexistingUserInstallations:false,preexistingProfile:false,verifiedBuildRegistrationRemoved:state.registeredApplications.length>0};
    });
    await observe('seed-original-application-data',()=>runInstalledDataFixture('seed',candidate,session,nonce));
    phase='verify-prepared-fixture-engine';
    const fixtureExecutable=preparedFixtureEngine();
    let sourceMarkerDigest;
    const fixture=async(mode,file)=>({observation:await seedOrVerify(mode,session,nonce,profile,path.join(output,file),fixtureExecutable)});
    const copy=async(destination)=>{
      if(await exists(destination))throw new Error('Refusing to merge an application into an existing installation');
      await verifyApp(mountedApp);
      await runObserved('/usr/bin/ditto',[mountedApp,destination],{timeoutMs:300_000});
      await verifyApp(destination);
    };
    await runMacInstallationLifecycle({
      seed:()=>observe('seed-original-electron-profile',()=>fixture('seed','legacy-seed.json')),
      verifySourceBefore:()=>observe('reopen-original-electron-profile',async()=>{
        const result=await fixture('verify','legacy-before.json');
        sourceMarkerDigest=await sha256(path.join(profile,'varin-installer-fixture.json'));
        return result;
      }),
      mount:()=>observe('mount-exact-read-only-dmg',async()=>{
        // Recheck immediately before mutation. An unknown attach is never retried.
        await verifyRecord(candidate.assets,artifact);await fs.mkdir(mountpoint);
        const images=readImages();
        if(!Array.isArray(images.images)||images.images.some(image=>image['image-path']===installer))throw new Error('Candidate DMG is already mounted or mount observation is unavailable');
        mountAttempted=true;
        await runObserved('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mountpoint,installer],{timeoutMs:180_000});
        const result=assertOwnedMount(readImages(),plist(readCommand('/usr/sbin/diskutil',['info','-plist',mountpoint]),'disk'),{installer,mountpoint});
        mounted=true;
        await verifyApp(mountedApp);return result;
      }),
      install:()=>observe('install-candidate',async()=>{
        assertMacState(readMacState(),stateOptions);await fs.mkdir(installRoot);await copy(installedApp);
        return{method:'ditto-exact-dmg-app-to-private-directory',sameCandidateBytes:true};
      }),
      launch:async restart=>{
        const file=restart?'installed-reopen.json':'installed-first.json';let native;
        await observe(restart?'reopen-retained-target-state':'launch-and-migrate-installed-product',async()=>{
          await verifyApp(installedApp);
          native=await smokeNative(candidate,{output:path.join(output,file),installedExecutable:executable,session,retainData:true,legacyFixtureNonce:nonce,disposableUser:true,useOsProfile:true,restart,applicationData:true,timeoutMs:300_000});
          assertNativeDrain(native);assertMacState(readMacState(),stateOptions);
          const applicationData=await runInstalledDataFixture('verify',candidate,session,nonce,{runtime:path.join(installedApp,runtimeRelative)});
          return{nativeReport:file,caseCount:native.report.cases.length,originalNativeScopesEnded:true,applicationData};
        });return native;
      },
      replace:()=>observe('replace-same-version-candidate',async()=>{
        assertMacState(readMacState(),stateOptions);await verifyApp(installedApp);
        const staging=path.join(root,'Replacement');await fs.mkdir(staging);const replacement=path.join(staging,'Varin.app');
        await copy(replacement);await verifyOwnedDirectory(installedApp);
        await fs.rm(installedApp,{recursive:true});await fs.rename(replacement,installedApp);await verifyApp(installedApp);
        return{method:'verified-same-version-app-replacement',sameCandidateBytes:true,priorNativeScopesEnded:true};
      }),
      unregisterOwned:()=>observe('remove-only-owned-launchservices-registrations',async()=>{
        const state=readMacState();assertMacState(state,stateOptions);
        for(const application of [...new Set(state.registeredApplications)]){
          if(application!==candidate.payload||!buildRegistrationOwned)await verifyOwnedDirectory(application);
          await verifyApp(application);
          await runObserved(lsregister,['-u',application],{timeoutMs:60_000});
        }
        // A stale/default handler that cannot be proved absent is a failure. Do
        // not reset LaunchServices or change any system/user-wide default.
        assertMacState(readMacState(),{...stateOptions,requireEmpty:true});
        return{unregisteredOwnedPaths:state.registeredApplications.length,explicitRegistration:false,defaultHandlerChanged:false};
      }),
      uninstall:()=>observe('uninstall-retain-data',async()=>{
        assertMacState(readMacState(),{...stateOptions,requireEmpty:true});await verifyOwnedDirectory(installedApp);await verifyApp(installedApp);
        await fs.rm(installedApp,{recursive:true});await fs.rmdir(installRoot);
        if(await exists(installedApp)||await sha256(path.join(profile,'varin-installer-fixture.json'))!==sourceMarkerDigest||!await exists(path.join(session.data,'cef/application')))throw new Error('Uninstall did not remove its own app and retain source/target data');
        return{method:'private-app-bundle-removal',originalProfileRetained:true,isolatedTargetRetained:true};
      }),
      verifySourceAfter:async()=>{
        await observe('reopen-application-data-after-uninstall',()=>runInstalledDataFixture('verify',candidate,session,nonce));
        return observe('reopen-original-profile-after-uninstall',()=>fixture('verify','legacy-after-uninstall.json'));
      },
      detach:()=>observe('detach-owned-dmg',async()=>{
        assertOwnedMount(readImages(),plist(readCommand('/usr/sbin/diskutil',['info','-plist',mountpoint]),'disk'),{installer,mountpoint});
        await runObserved('/usr/bin/hdiutil',['detach',mountpoint],{timeoutMs:90_000});
        const images=readImages();
        if(!Array.isArray(images.images)||images.images.some(image=>image['image-path']===installer||(image['system-entities']??[]).some(entity=>entity['mount-point']===mountpoint)))throw new Error('Owned DMG detach is unconfirmed');
        mounted=false;detachConfirmed=true;assertMacState(readMacState(),{...stateOptions,requireEmpty:true});
        return{forced:false,mountAbsent:true};
      }),
      retainSession:()=>observe('retain-unconfirmed-fixture-session',async()=>{
        // app.quit(), the direct process close and a passed profile readback do
        // not prove all original Electron descendants have terminated.
        return{fixtureCleanup:'not-verified',privateSessionRetained:true,originalOsProfileRetained:true};
      }),
    });
    evidence.complete=true;evidence.cleanupUncertain=true;evidence.fixtureCleanup='not-verified';
    evidence.privateSessionRetained=true;evidence.retainedPrivateDirectory=root;
    await fs.writeFile(path.join(output,'installer-smoke.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
  }catch(error){
    evidence.complete=false;evidence.failedStep=phase;evidence.failure=error.message;evidence.cleanupUncertain=true;evidence.retainedPrivateDirectory=root;
    evidence.dmgDetachConfirmed=detachConfirmed;evidence.dmgMountState=detachConfirmed?'detached':mounted?'mounted':mountAttempted?'unknown':'not-attempted';evidence.retainedMountpoint=mountpoint;
    if(error.observed)evidence.process=error.observed;
    await failRetainedObservation(path.join(output,'installer-smoke.json'),evidence,`macOS installed product smoke failed at ${phase}. No automatic failure cleanup was attempted.`);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),index=args.indexOf('--output');
  if(!args[0]||index<0||!args[index+1])throw new Error('Usage: macos-installer-smoke.mjs candidate.json --output NEW-DIRECTORY --disposable-runner');
  await smokeMacInstaller(args[0],{output:args[index+1],disposableRunner:args.includes('--disposable-runner')});
}
