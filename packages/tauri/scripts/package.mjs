/** Existing installer identities/UX around a native, prepackaged Tauri payload.
 * Building an acceptance candidate is distinct from qualifying/publishing it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventory,verifyRuntimeManifest,sha256,readBinaryIdentity } from './runtime-manifest.mjs';
import { verifyWindowsBootstrap,signWindowsBootstrap,inspectPortableExecutable } from './windows-bootstrap.mjs';
import { recordArtifact,tauriSignFile } from './release.mjs';
const repository=path.resolve(import.meta.dirname,'../../..');
const electronRoot=path.join(repository,'packages/electron');
const require=createRequire(path.join(electronRoot,'package.json'));
const builderRequire=createRequire(require.resolve('electron-builder'));
const libraryRequire=createRequire(builderRequire.resolve('app-builder-lib')); 
const original=require('./package.json');
function run(executable,args,options={}){try{return execFileSync(executable,args,{cwd:repository,env:process.env,stdio:'inherit',windowsHide:true,...options});}catch{throw new Error(`Desktop packaging command failed: ${path.basename(executable)}`);}}
export function transitionInstallerConfiguration({platform,architecture,output,signed}){
  if(!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(architecture))throw new Error('Unsupported native installer target');
  const config=structuredClone(original.build);
  // --prepackaged skips Electron download, fuses, app assembly and afterPack.
  // Retain original appId/NSIS custom includes/icons/WinFsp/retention/DMG design.
  delete config.afterPack;delete config.beforePack;delete config.onNodeModuleFile;
  delete config.files;delete config.extraResources;delete config.extraFiles;delete config.asar;delete config.asarUnpack;
  config.directories={buildResources:path.join(electronRoot,'resources/icons'),output:path.resolve(output)};
  config.electronVersion=require('electron/package.json').version;
  config.executableName='varin';config.publish=null;config.forceCodeSigning=Boolean(signed&&platform==='win32');
  config.nsis.include=path.resolve(import.meta.dirname,'../installer/installer.nsh');
  for(const name of ['installerIcon','uninstallerIcon','installerHeaderIcon'])config.nsis[name]=path.join(electronRoot,config.nsis[name]);
  // Updater signatures replace differential metadata as the Tauri contract.
  // Original Electron understands a full NSIS artifact without a blockmap.
  config.nsis.differentialPackage=false;
  config.win={...config.win,target:['nsis'],icon:path.join(electronRoot,config.win.icon),extraResources:[],verifyUpdateCodeSignature:true};
  config.mac={...config.mac,target:['dmg','zip'],icon:path.join(electronRoot,config.mac.icon)};
  config.linux = { ...config.linux, mimeTypes: [...new Set([...(config.linux.mimeTypes ?? []), 'x-scheme-handler/varin'])] };
  // The legacy FUSE2 builder otherwise injects --no-sandbox into Desktop Exec.
  config.appImage = { ...config.appImage, executableArgs: [] };
  config.dmg.sign=Boolean(signed);
  if(signed&&platform==='darwin')config.mac.identity=process.env.APPLE_SIGNING_IDENTITY;
  return config;
}
export async function prepareWindowsInstallerResources(directory){
  if(!(await fs.lstat(directory)).isDirectory())throw new Error('Windows installer payload must be a real directory');
  const resources=path.join(await fs.realpath(directory),'resources');
  try{await fs.mkdir(resources);}catch(error){if(error.code!=='EEXIST')throw error;}
  if(!(await fs.lstat(resources)).isDirectory())throw new Error('Windows installer resources cannot be redirected');
  // NSIS stages/signs the official elevate.exe into its own archive, then its
  // finalizer copies those same bytes here without creating parent directories.
  // CEF has no Electron resources directory, so prepare only that owned folder.
  return resources;
}
export async function brandWindowsBootstrap(directory, version) {
  const receipt = await verifyWindowsBootstrap(directory);
  if (receipt.signing) throw new Error('Brand the bootstrap before signing; never rewrite a signed generation');
  const file = path.join(directory, 'varin.exe'), before = await inspectPortableExecutable(file);
  await libraryRequire('./util/resEdit.js').editWindowsResources({ file, fileVersion: version, productVersion: version,
    versionStrings: { FileDescription: 'Varin', ProductName: 'Varin', InternalName: 'varin', OriginalFilename: 'varin.exe',
      LegalCopyright: original.build.copyright ?? `Copyright © ${new Date().getUTCFullYear()} ${original.author?.name ?? original.author ?? 'Varin'}` },
    requestedExecutionLevel: 'asInvoker', iconPath: path.join(electronRoot, 'resources/icons/icon.ico') });
  const after = await inspectPortableExecutable(file);
  if (after.machine !== before.machine || after.dll || after.dllCharacteristics !== before.dllCharacteristics) throw new Error('Branding changed bootstrap executable identity');
  const files = (await inventory(directory)).filter(entry => entry.path !== 'cef-runtime-manifest.json');
  const prior = new Map(receipt.files.map(entry => [entry.path, entry]));
  if (files.length !== prior.size || files.some(entry => !prior.has(entry.path) || entry.path !== 'varin.exe' && entry.sha256 !== prior.get(entry.path).sha256)) throw new Error('Branding changed unrelated engine bytes');
  const updated = { ...receipt, branding: { product: 'Varin', version, sourceBootstrapSha256: prior.get('varin.exe').sha256 }, files };
  const temporary = path.join(directory, 'cef-runtime-manifest.json.branding');
  try { await fs.writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, path.join(directory, 'cef-runtime-manifest.json')); }
  finally { await fs.rm(temporary, { force: true }); }
  return verifyWindowsBootstrap(directory);
}
export function sandboxedAppImageLauncher() {
  const { generateAppRunScript } = libraryRequire('./targets/appimage/appImageUtil.js');
  const source=generateAppRunScript({DesktopFileName:'varin.desktop',ExecutableName:'varin',ProductName:'Varin',ProductFilename:'Varin',ResourceName:'appimagekit-varin'});
  const begin=source.indexOf('HAVE_NO_SANDBOX=0'),end=source.indexOf('\natexit()\n',begin);
  if(begin<0||end<0||!source.slice(begin,end).includes('NO_SANDBOX=(--no-sandbox)'))throw new Error('AppImage launcher changed; review sandbox preservation before packaging');
  return source.slice(0,begin)+'export APPDIR\nfor arg in "${args[@]}"; do\n  case "$arg" in --no-sandbox|--no-sandbox=*) echo "Varin requires its browser sandbox." >&2; exit 1;; esac\ndone\nNO_SANDBOX=()\n'+source.slice(end);
}
export function verifyMacProtocol(plist) {
  const entries = plist.CFBundleURLTypes?.filter(entry => entry.CFBundleURLSchemes?.includes('varin'));
  if (entries?.length !== 1 || entries[0].CFBundleURLName !== 'dev.varin.desktop') throw new Error('Packaged macOS app is missing the Varin URL handler');
}
export function verifyLinuxProtocol(desktop) {
  const lines = desktop.split(/\r?\n/u), entries = {};
  let section = '';
  for (const line of lines) {
    if (line.startsWith('[')) { section = line; continue; }
    const equal = line.indexOf('=');
    if (section === '[Desktop Entry]' && equal > 0) entries[line.slice(0, equal)] = line.slice(equal + 1);
  }
  if (!entries.MimeType?.split(';').includes('x-scheme-handler/varin') || !/(?:^|\s)%[uU](?:$|\s)/u.test(entries.Exec ?? '')
    || /--no-sandbox/u.test(entries.Exec) || !/^AppRun(?:\s|$)/u.test(entries.Exec)) throw new Error('Packaged AppImage is missing safe Varin URL activation');
  return entries;
}
async function verifyAppImageProtocol(file) {
  const temporary = await fs.mkdtemp(path.join(path.dirname(file), '.appimage-contract-'));
  try {
    run(file, ['--appimage-extract', 'varin.desktop'], { cwd: temporary, stdio: 'pipe' });
    verifyLinuxProtocol(await fs.readFile(path.join(temporary, 'squashfs-root/varin.desktop'), 'utf8'));
    run(file, ['--appimage-extract', 'AppRun'], { cwd: temporary, stdio: 'pipe' });
    if (await fs.readFile(path.join(temporary, 'squashfs-root/AppRun'), 'utf8') !== sandboxedAppImageLauncher()) throw new Error('AppImage did not retain the sandbox-preserving launcher');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
export async function verifyNativePayload(directory,{platform,architecture,version,mode='electron-to-tauri'}){
  const executable=path.join(directory,platform==='darwin'?'Contents/MacOS/varin':platform==='win32'?'varin.exe':'varin');
  const binary=await readBinaryIdentity(executable);
  if(binary.platform!==platform||binary.arch!==architecture)throw new Error('Native shell architecture does not match its installer');
  const runtime=platform==='darwin'?path.join(directory,'Contents/Resources/runtime'):platform==='linux'?path.join(directory,'usr/lib/Varin/runtime'):path.join(directory,'runtime');
  const manifest=await verifyRuntimeManifest(runtime,{platform,architecture});
  if(!['electron-to-tauri','tauri'].includes(mode) || manifest.version!==version || (mode==='electron-to-tauri')!==Boolean(manifest.legacyElectron))throw new Error('Native package mode does not match its legacy reader capability');
  if(platform==='darwin'){
    const plist=JSON.parse(run('plutil',['-convert','json','-o','-',path.join(directory,'Contents/Info.plist')],{stdio:'pipe',encoding:'utf8'}));
    if(plist.CFBundleIdentifier!=='dev.varin.desktop'||plist.CFBundleExecutable!=='varin'||plist.CFBundleShortVersionString!==version)throw new Error('macOS application identity changed');
    verifyMacProtocol(plist);
  }
  return{runtime,manifest};
}
export async function packageTransition({directory,output,platform=process.platform,architecture=process.arch,signed=false,engineDirectory,mode='electron-to-tauri'}){
  if(platform!==process.platform||architecture!==process.arch)throw new Error('Package and sign on the matching native target runner');
  directory=path.resolve(directory);output=path.resolve(output);
  if(output===directory||output.startsWith(directory+path.sep)||directory.startsWith(output+path.sep))throw new Error('Installer output must be outside the immutable input');
  const version=original.version;
  if(signed&&!process.env.VARIN_TAURI_UPDATER_PUBLIC_KEY)throw new Error('Release candidate requires the installed updater public key');
  const{runtime}=await verifyNativePayload(directory,{platform,architecture,version,mode});
  if(platform==='win32'){
    if(!engineDirectory)throw new Error('Windows installer requires the verified sandbox bootstrap generation');
    await prepareWindowsInstallerResources(directory);
    const engine=await verifyWindowsBootstrap(engineDirectory);
    if(engine.architecture!==architecture)throw new Error('Windows engine architecture mismatch');
    await brandWindowsBootstrap(engineDirectory, version);
    if(signed){
      const script=path.join(import.meta.dirname,'windows-sign.ps1');
      await signWindowsBootstrap(engineDirectory,{
        sign:file=>run('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-File',file],{stdio:'pipe'}),
        verifySignature:file=>{run('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-File',file,'-VerifyOnly'],{stdio:'pipe'});return true;},
      });
    }
    // Copy the finalized same-stem EXE/DLL and exact SDK, then check again.
    const finalized=await verifyWindowsBootstrap(engineDirectory);
    for(const record of finalized.files){const target=path.join(directory,record.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(engineDirectory,record.path),target);}
    await fs.copyFile(path.join(engineDirectory,'cef-runtime-manifest.json'),path.join(directory,'cef-runtime-manifest.json'));
    await require('./scripts/prepare-installer-tool.cjs').prepare(electronRoot);
    for (const [source, target] of [['resources/installer-tools/LICENSE.txt', 'legal/installer-7zip/LICENSE.txt'], ['resources/installer-tools/COPYING', 'legal/installer-7zip/COPYING'], ['resources/workspace-component/License.txt', 'legal/winfsp/License.txt']]) {
      await fs.mkdir(path.dirname(path.join(directory, target)), { recursive: true });
      await fs.copyFile(path.join(electronRoot, source), path.join(directory, target));
    }
  }
  if(platform==='darwin')await (await import('./macos-sign.mjs')).signMacPayload(directory,{development:!signed});
  if(signed&&platform==='darwin'){
    // The complete app (including normalized legacy framework layout) must have
    // been signed and notarized by the native signing owner before packaging.
    run('codesign',['--verify','--strict','--deep',directory]);run('spctl',['--assess','--type','execute','--verbose=2',directory]);
    run('xcrun',['stapler','validate',directory]);
  }
  if(platform==='linux')await fs.writeFile(path.join(directory,'AppRun'),sandboxedAppImageLauncher(),{mode:0o755});
  const configuration=transitionInstallerConfiguration({platform,architecture,output,signed});
  const temporary=await fs.mkdtemp(path.join(path.dirname(directory),'.tauri-installer-'));
  const configFile=path.join(temporary,'electron-builder.cjs');
  await fs.writeFile(configFile,`module.exports = ${JSON.stringify(configuration,null,2)};\n`);
  const env={...process.env,WIN_CSC_LINK:process.env.WIN_CSC_LINK||process.env.WINDOWS_CSC_LINK,WIN_CSC_KEY_PASSWORD:process.env.WIN_CSC_KEY_PASSWORD||process.env.WINDOWS_CSC_KEY_PASSWORD,
    ...(!signed?{CSC_IDENTITY_AUTO_DISCOVERY:'false'}:{})};
  try{run(process.execPath,[require.resolve('electron-builder/out/cli/cli.js'),'--prepackaged',directory,'--config',configFile,`--${platform==='win32'?'win':platform==='darwin'?'mac':'linux'}`,`--${architecture}`,'--publish','never'],{cwd:electronRoot,env});}
  finally{await fs.rm(temporary,{recursive:true,force:true});}
  // Installer tools are not allowed to rewrite resources/main binary silently.
  await verifyRuntimeManifest(runtime,{platform,architecture});
  const files=(await fs.readdir(output)).filter(name=>name.startsWith(`Varin-${version}-`));
  const electron=files.filter(name=>platform==='win32'?name.endsWith('.exe'):platform==='darwin'?name.endsWith('.dmg')||name.endsWith('.zip'):name.endsWith('.AppImage'));
  if(electron.length!==(platform==='darwin'?2:1))throw new Error('Installer output is missing or ambiguous');
  if(platform==='linux')for(const name of electron)await verifyAppImageProtocol(path.join(output,name));
  if(signed&&platform==='win32')for(const name of electron)run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(import.meta.dirname,'windows-sign.ps1'),'-File',path.join(output,name),'-VerifyOnly'],{stdio:'pipe'});
  if(signed&&platform==='darwin')for(const name of electron.filter(name=>name.endsWith('.dmg')))run('codesign',['--verify','--strict',path.join(output,name)]);
  let update=electron.find(name=>!name.endsWith('.dmg'));
  if(platform==='darwin'){
    update=`Varin-${version}-mac-${architecture}.app.tar.gz`;
    run('tar',['-czf',path.join(output,update),'-C',path.dirname(directory),path.basename(directory)]);
  }
  const signature=signed?await tauriSignFile(path.join(output,update),version):undefined;
  const receipt={schema:1,product:'varin-tauri-packaged-candidate',version,platform,architecture,signed,mode,
    runtimeManifestSha256:await sha256(path.join(runtime,'runtime-manifest.json')),
    update:await recordArtifact(path.join(output,update),{signature}),electron:await Promise.all(electron.map(name=>recordArtifact(path.join(output,name))))};
  await fs.writeFile(path.join(output,`tauri-${platform}-${architecture}.json`),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const get=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(!get('--prepackaged')||!get('--output'))throw new Error('Usage: package.mjs --prepackaged DIR --output DIR [--engine DIR] [--mode electron-to-tauri|tauri] [--signed]');
  await packageTransition({directory:get('--prepackaged'),output:get('--output'),engineDirectory:get('--engine'),signed:args.includes('--signed'),mode:get('--mode')??'electron-to-tauri'});
}
