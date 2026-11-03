/** Native release-mode build. Produces testable candidates, never an acceptance
 * receipt and never a release. The release assembler requires separate evidence. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRuntimeManifest,inventory,sha256} from './runtime-manifest.mjs';
import {stageWindowsBootstrap} from './windows-bootstrap.mjs';
import {packageTransition} from './package.mjs';
import {recordArtifact} from './release.mjs';
import {pinnedCefLicense} from './cef-license.mjs';
const repository=path.resolve(import.meta.dirname,'../../..'),packageRoot=path.resolve(import.meta.dirname,'..');
const lock=JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json',import.meta.url),'utf8'));
const require=createRequire(path.join(packageRoot,'package.json'));
function run(command,args,options={}){return execFileSync(command,args,{cwd:packageRoot,env:process.env,stdio:'inherit',windowsHide:true,...options});}
export function candidateConfiguration(runtime){
  runtime=path.resolve(runtime);
  // The CLI first folds --config overlays together, then merges the result
  // into the checked-in configuration. An array reset in an earlier overlay
  // therefore cannot remove old map entries. The base owns no runtime path;
  // this one overlay supplies the exact immutable candidate generation.
  return{build:{frontendDist:path.join(runtime,'frontend')},bundle:{active:true,resources:{[runtime+path.sep]:'runtime/'},macOS:{minimumSystemVersion:'13.0',infoPlist:path.join(packageRoot,'installer/Info.plist'),entitlements:path.join(repository,'packages/electron/resources/entitlements.mac.plist')}}};
}
export async function discoverCef(root,platform,architecture){
  const pin=lock.targets[`${platform}-${architecture}`];if(!pin)throw new Error('Unsupported CEF target');
  const name=`cef_binary_${lock.version}_${pin.upstream}_minimal.tar.bz2`;
  const suffix=`cef_${platform==='win32'?'windows':platform==='darwin'?'macos':'linux'}_${architecture==='x64'?'x86_64':'aarch64'}`;
  for(const candidate of [root,path.join(root,lock.version.split('+')[0],suffix),path.join(root,suffix),path.join(root,name.replace('.tar.bz2',''))]){
    const receipt=await fs.readFile(path.join(candidate,'archive.json'),'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});
    if(receipt&&receipt.name===name&&receipt.sha1===pin.sha1&&receipt.type==='minimal')return candidate;
  }
  throw new Error('CEF SDK receipt does not match the pinned platform distribution');
}
export async function engineInventory(directory,{exclude}={}){
  directory=await fs.realpath(directory);const files=[];
  const visit=async relative=>{
    if(exclude&&(relative===exclude||relative.startsWith(exclude+'/')))return;
    const file=path.join(directory,relative),stat=await fs.lstat(file);
    if(stat.isSymbolicLink()){
      const resolved=await fs.realpath(file);if(resolved!==directory&&!resolved.startsWith(directory+path.sep))throw new Error('CEF bundle has an external symbolic link');
      files.push({path:relative,link:await fs.readlink(file)});
    }else if(stat.isDirectory()){for(const name of(await fs.readdir(file)).sort())await visit(relative?`${relative}/${name}`:name);}
    else if(stat.isFile())files.push({path:relative,size:stat.size,sha256:await sha256(file),executable:Boolean(stat.mode&0o111)});
    else throw new Error('CEF bundle contains a special file');
  };await visit('');return files;
}
export async function buildCandidate({runtime,output,cef=process.env.CEF_PATH,signed=false,packageInstallers=true,allowDirty=false,mode='electron-to-tauri'}){
  if(!cef)throw new Error('Set CEF_PATH to one explicit build cache shared with staging');
  runtime=path.resolve(runtime);output=path.resolve(output);
  const sourceSha=run('git',['rev-parse','HEAD'],{cwd:repository,stdio:'pipe',encoding:'utf8'}).trim();
  if(!allowDirty&&run('git',['status','--porcelain','--untracked-files=normal'],{cwd:repository,stdio:'pipe',encoding:'utf8'}).trim())throw new Error('Candidate builds require immutable committed source');
  const manifest=await verifyRuntimeManifest(runtime,{platform:process.platform,architecture:process.arch});
  if(!['electron-to-tauri','tauri'].includes(mode))throw new Error('Native candidate requires an explicit supported shell mode');
  if(manifest.sources?.sourceSha!==sourceSha || (mode==='electron-to-tauri') !== Boolean(manifest.legacyElectron))throw new Error('Candidate mode must match its source and presence of the controlled legacy exporter');
  if(signed&&!process.env.VARIN_TAURI_UPDATER_PUBLIC_KEY)throw new Error('Supply the release updater public key before compiling a signed candidate');
  await fs.mkdir(output,{recursive:false});
  const cli=path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')),'tauri.js');
  const configs=['--config',JSON.stringify(candidateConfiguration(runtime))];
  run(process.execPath,[cli,'build','--no-bundle','--ci','--features','desktop',...configs,...(process.platform==='win32'?['--','--lib']:[])]);
  const metadata=JSON.parse(run(process.env.CARGO||'cargo',['metadata','--no-deps','--format-version','1'],{cwd:path.join(packageRoot,'src-tauri'),stdio:'pipe',encoding:'utf8'}));
  const cargo=path.join(metadata.target_directory,...(process.env.CARGO_BUILD_TARGET?[process.env.CARGO_BUILD_TARGET]:[]),'release');
  const sdk=await discoverCef(path.resolve(cef),process.platform,process.arch);
  let payload,engineDirectory;
  if(process.platform==='win32'){
    engineDirectory=path.join(output,'engine');await stageWindowsBootstrap({cefDirectory:sdk,targetDirectory:cargo,destination:engineDirectory,architecture:process.arch});
    payload=path.join(output,'payload');await fs.cp(engineDirectory,payload,{recursive:true});await fs.cp(runtime,path.join(payload,'runtime'),{recursive:true});
  }else if(process.platform==='linux'){
    payload=path.join(output,'payload');await fs.mkdir(payload);
    const required=['libcef.so','chrome-sandbox','icudtl.dat','resources.pak','chrome_100_percent.pak','chrome_200_percent.pak','v8_context_snapshot.bin','libvk_swiftshader.so','libvulkan.so.1','vk_swiftshader_icd.json','CREDITS.html'];
    for(const name of required)await fs.copyFile(path.join(sdk,name),path.join(payload,name));
    await fs.copyFile(await pinnedCefLicense(sdk),path.join(payload,'LICENSE.txt'));
    for(const name of ['libEGL.so','libGLESv2.so'])if(await fs.stat(path.join(sdk,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))await fs.copyFile(path.join(sdk,name),path.join(payload,name));
    await fs.cp(path.join(sdk,'locales'),path.join(payload,'locales'),{recursive:true});
    await fs.copyFile(path.join(cargo,'varin'),path.join(payload,'varin'));await fs.chmod(path.join(payload,'varin'),0o755);
    await fs.cp(runtime,path.join(payload,'usr/lib/Varin/runtime'),{recursive:true});
  }else if(process.platform==='darwin'){
    run(process.execPath,[cli,'bundle','--ci','--no-sign','--bundles','app','--features','desktop',...configs]);
    payload=path.join(output,'Varin.app');await fs.cp(path.join(cargo,'bundle/macos/Varin.app'),payload,{recursive:true,verbatimSymlinks:true});
    await fs.copyFile(await pinnedCefLicense(sdk),path.join(payload,'Contents/Resources/CEF-LICENSE.txt'));
    await fs.copyFile(path.join(sdk,'CREDITS.html'),path.join(payload,'Contents/Resources/CEF-CREDITS.html'));
  }else throw new Error('Unsupported native target');
  const runtimeDirectory=process.platform==='darwin'?path.join(payload,'Contents/Resources/runtime'):process.platform==='linux'?path.join(payload,'usr/lib/Varin/runtime'):path.join(payload,'runtime');
  const runtimeManifest=JSON.parse(await fs.readFile(path.join(runtimeDirectory,'runtime-manifest.json'),'utf8'));
  runtimeManifest.browser={engine:'CEF',version:lock.version,architecture:process.arch,sourceArchiveSha1:lock.targets[`${process.platform}-${process.arch}`].sha1};
  await fs.writeFile(path.join(runtimeDirectory,'runtime-manifest.json'),JSON.stringify(runtimeManifest,null,2)+'\n');
  const assets=path.join(output,'assets');await fs.mkdir(assets);
  let packaged=null;if(packageInstallers)packaged=await packageTransition({directory:payload,output:assets,signed,engineDirectory,mode});
  const target=`${process.platform}-${process.arch}`,runtimeName=`${target}.runtime.json`,engineName=`${target}.engine.json`;
  await fs.copyFile(path.join(runtimeDirectory,'runtime-manifest.json'),path.join(assets,runtimeName));
  const engine={schema:1,engine:'CEF',cefVersion:lock.version,architecture:process.arch,sandbox:'required',sourceSha,
    sdk:JSON.parse(await fs.readFile(path.join(sdk,'archive.json'),'utf8')),
    files:await engineInventory(payload,{exclude:process.platform==='darwin'?'Contents/Resources/runtime':process.platform==='linux'?'usr/lib/Varin/runtime':'runtime'})};
  await fs.writeFile(path.join(assets,engineName),JSON.stringify(engine,null,2)+'\n');
  const result={schema:1,target,sourceSha,version:manifest.version,payload,runtime:runtimeDirectory,assets,
    runtimeManifest:await recordArtifact(path.join(assets,runtimeName)),engineManifest:await recordArtifact(path.join(assets,engineName)),packaged};
  await fs.writeFile(path.join(output,'candidate.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(!get('--runtime')||!get('--output'))throw new Error('Usage: build-candidate.mjs --runtime DIR --output NEW-DIR [--mode electron-to-tauri|tauri] [--signed] [--no-installers] [--allow-dirty]');
  await buildCandidate({runtime:get('--runtime'),output:get('--output'),signed:args.includes('--signed'),packageInstallers:!args.includes('--no-installers'),allowDirty:args.includes('--allow-dirty'),mode:get('--mode')??'electron-to-tauri'});
}
