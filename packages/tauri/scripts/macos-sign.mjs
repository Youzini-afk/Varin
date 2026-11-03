/** Sign the actual CEF app and its controlled legacy reader before sealing the
 * immutable runtime, then sign/notarize the enclosing app without mutating children. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { inventory,sha256,verifyRuntimeManifest } from './runtime-manifest.mjs';
const repository=path.resolve(import.meta.dirname,'../../..');
const require=createRequire(path.join(repository,'packages/electron/package.json'));
const libraryRequire=createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
function run(command,args){try{return execFileSync(command,args,{stdio:'pipe',encoding:'utf8'});}catch{throw new Error(`macOS release operation failed: ${path.basename(command)}`);}}
export async function signMacPayload(app,{identity=process.env.APPLE_SIGNING_IDENTITY,keychain=process.env.APPLE_KEYCHAIN,notaryProfile=process.env.VARIN_APPLE_NOTARY_PROFILE,development=false}={}){
  if(process.platform!=='darwin')throw new Error('Sign macOS payloads on macOS');
  if(development)identity='-';
  if(!development&&(!identity||identity==='-'||!notaryProfile))throw new Error('Supply existing APPLE_SIGNING_IDENTITY and VARIN_APPLE_NOTARY_PROFILE; development/ad-hoc signatures cannot qualify a release');
  app=path.resolve(app);const runtime=path.join(app,'Contents/Resources/runtime');
  await verifyRuntimeManifest(runtime,{platform:'darwin',architecture:process.arch});
  const entitlements=path.join(repository,'packages/electron/resources/entitlements.mac.plist');
  // The existing signer already knows native bundle traversal. Explicitly retain
  // the separate FSKit application's sandbox/extension entitlements.
  await libraryRequire('./codeSign/macCodeSign.js').sign({app,identity,keychain,identityValidation:!development,platform:'darwin',type:'distribution',
    preAutoEntitlements:false,preEmbedProvisioningProfile:false,strictVerify:true,optionsForFile:file=>({
      hardenedRuntime:true,entitlements:file.includes('/VarinWorkspace.appex')?path.join(repository,'packages/workspace-driver/macos/Extension.entitlements')
        :file.includes('/VarinWorkspace.app')?path.join(repository,'packages/workspace-driver/macos/Control.entitlements'):entitlements,
    })});
  const manifest=JSON.parse(await fs.readFile(path.join(runtime,'runtime-manifest.json'),'utf8'));
  const kernelFile=path.join(runtime,manifest.kernel.manifest),kernel=JSON.parse(await fs.readFile(kernelFile,'utf8'));
  kernel.sha256=await sha256(path.join(runtime,manifest.kernel.executable));
  await fs.writeFile(kernelFile,JSON.stringify(kernel,null,2)+'\n');
  // Rehash signed physical files, retaining and revalidating the original
  // framework alias identities rather than blessing any signer layout change.
  manifest.files=await inventory(runtime,manifest);
  await fs.writeFile(path.join(runtime,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await verifyRuntimeManifest(runtime,{platform:'darwin',architecture:process.arch});
  run('codesign',['--force','--sign',identity,...(keychain?['--keychain',keychain]:[]),'--options','runtime',...(development?[]:['--timestamp']),'--entitlements',entitlements,app]);
  run('codesign',['--verify','--strict','--deep',app]);
  if(development)return{runtimeManifestSha256:await sha256(path.join(runtime,'runtime-manifest.json')),signing:'ad-hoc-development',notarization:'not-run'};
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'varin-notarize-'));
  try{
    const archive=path.join(temporary,'Varin.zip');run('ditto',['-c','-k','--keepParent',app,archive]);
    const receipt=JSON.parse(run('xcrun',['notarytool','submit',archive,'--keychain-profile',notaryProfile,'--wait','--output-format','json']));
    if(receipt.status!=='Accepted')throw new Error('macOS notarization did not accept the candidate');
    run('xcrun',['stapler','staple',app]);run('xcrun',['stapler','validate',app]);run('spctl',['--assess','--type','execute',app]);
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
  return{runtimeManifestSha256:await sha256(path.join(runtime,'runtime-manifest.json')),signing:'verified',notarization:'accepted'};
}
