/** Native Debian packaging/inspection. Building metadata never installs a package
 * or grants host permissions. Only two pinned official helpers may carry SUID. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, relativePath } from './runtime-manifest.mjs';
import { pinnedCefLicense } from './cef-license.mjs';
const locks=JSON.parse(await fs.readFile(new URL('./linux-sandbox.lock.json',import.meta.url),'utf8'));
export const cefDebianFiles=['libcef.so','icudtl.dat','v8_context_snapshot.bin','chrome_100_percent.pak','chrome_200_percent.pak','resources.pak','libEGL.so','libGLESv2.so','libvk_swiftshader.so','vk_swiftshader_icd.json','libvulkan.so.1','chrome-sandbox'];
export const cefRequiredLocales=['en-US.pak','en-US_FEMININE.pak','en-US_MASCULINE.pak','en-US_NEUTER.pak'];
export const debianDesktopFile='usr/share/applications/Varin.desktop';
export const debianDependencies=[
  'libc6 (>= 2.39)', 'libgcc-s1', 'libstdc++6', 'libgtk-4-1 (>= 4.14)',
  'libgtk-3-0t64 | libgtk-3-0', 'libnss3', 'libnspr4', 'libasound2t64 | libasound2',
  'libatk1.0-0t64 | libatk1.0-0', 'libatk-bridge2.0-0t64 | libatk-bridge2.0-0',
  'libatspi2.0-0t64 | libatspi2.0-0', 'libcups2t64 | libcups2', 'libdbus-1-3',
  'libdrm2', 'libgbm1', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1',
  'libxext6', 'libxfixes3', 'libxrandr2', 'libxkbcommon0', 'libxdo3', 'libegl1',
  'libwayland-client0', 'libvulkan1', 'libayatana-appindicator3-1', 'xdg-utils',
  'xdg-desktop-portal', 'xdg-desktop-portal-gtk', 'xwayland',
];
export function sandboxHelpers(architecture,{transition=true}={}) {
  const pin=locks.targets[architecture];if(!pin)throw new Error('Unsupported Debian architecture');
  return {'usr/share/Varin/chrome-sandbox':pin.cef,...(transition?{'usr/lib/Varin/runtime/legacy-electron/chrome-sandbox':pin.electron}:{})};
}
export async function debianConfiguration(sdk) {
  // The pinned bundler copies CEF itself and stamps its binary as Deb. Supply
  // only its omitted license/credits/locales, not a second copy of the engine.
  return {bundle:{linux:{deb:{depends:debianDependencies,section:'devel',
    desktopTemplate:path.join(import.meta.dirname,'linux-varin.desktop'),
    files:{'/usr/share/Varin/LICENSE.txt':await pinnedCefLicense(sdk),
      '/usr/share/Varin/CREDITS.html':path.join(sdk,'CREDITS.html'),
      '/usr/share/Varin/locales':path.join(sdk,'locales')},
    preInstallScript:null,postInstallScript:null,preRemoveScript:null,postRemoveScript:null}}}};
}
function controlFields(text) {
  const fields={};for(const line of text.split(/\r?\n/u)){if(!line||/^\s/u.test(line))continue;const index=line.indexOf(':');if(index<1||fields[line.slice(0,index)])throw new Error('Malformed Debian control record');fields[line.slice(0,index)]=line.slice(index+1).trim();}return fields;
}
export function validateDebianInventory(document,{architecture,version,sourceSha,runtimeManifestSha256,artifactSha256,transition=true}={}) {
  if(document.schema!==1||document.product!=='varin-debian-inventory'||document.packageName!=='varin'
    ||document.architecture!==architecture||document.packageArchitecture!==(architecture==='x64'?'amd64':architecture==='arm64'?'arm64':null)
    ||document.version!==version||document.sourceSha!==sourceSha||document.runtimeManifestSha256!==runtimeManifestSha256
    ||document.artifactSha256!==artifactSha256||document.desktopFile!==debianDesktopFile
    ||!Array.isArray(document.entries)||!document.entries.length)throw new Error('Debian inventory identity mismatch');
  const helpers=sandboxHelpers(architecture,{transition}),entries=new Map();
  for(const entry of document.entries){
    relativePath(entry.path);
    const owned=entry.path.startsWith('usr/share/Varin/')||entry.path.startsWith('usr/lib/Varin/')
      ||['usr/bin/varin',debianDesktopFile].includes(entry.path)
      ||/^usr\/share\/icons\/hicolor\/\d+x\d+(?:@\d+)?\/apps\/varin\.png$/u.test(entry.path);
    const directory=entry.type==='directory'&&(['usr','usr/bin','usr/lib','usr/share','usr/lib/Varin','usr/share/Varin','usr/share/applications','usr/share/icons','usr/share/icons/hicolor'].includes(entry.path)
      ||/^usr\/share\/icons\/hicolor\/\d+x\d+(?:@\d+)?(?:\/apps)?$/u.test(entry.path));
    if((!owned&&!directory)||entries.has(entry.path))throw new Error('Unexpected or duplicate Debian installation path');
    if(!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o7777||entry.uid!==0||entry.gid!==0)throw new Error('Debian entries must be owned by root');
    if((entry.mode&0o3000)||(entry.type!=='symlink'&&(entry.mode&0o022)))throw new Error('Debian entries cannot be writable or have unexpected privileged mode');
    // The setuid bit is considered separately from setgid/sticky/write bits.
    if((entry.mode&0o4000)&&!helpers[entry.path])throw new Error('Unexpected privileged Debian helper');
    if(entry.type==='file'){
      if(!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/u.test(entry.sha256))throw new Error('Debian file identity is absent');
    }else if(entry.type==='symlink'){
      if(entry.path!=='usr/bin/varin'||entry.link!=='../share/Varin/varin')throw new Error('Unexpected Debian symbolic link');
    }else if(entry.type!=='directory')throw new Error('Unexpected Debian entry type');
    entries.set(entry.path,entry);
  }
  for(const [name,expected] of Object.entries(helpers)){
    const helper=entries.get(name);
    if(helper?.type!=='file'||helper.mode!==0o4755||helper.sha256!==expected||helper.elfMachine!==(architecture==='x64'?62:183))throw new Error('Debian sandbox helper differs from its official pinned bytes or permissions');
    for(let ancestor=path.posix.dirname(name);ancestor!=='.';ancestor=path.posix.dirname(ancestor)){
      if(entries.get(ancestor)?.type!=='directory')throw new Error('Debian helper ancestor is absent or redirected');
    }
  }
  if(JSON.stringify([...document.helpers??[]].sort())!==JSON.stringify(Object.keys(helpers).sort()))throw new Error('Debian sandbox helper inventory is incomplete');
  const executable=entries.get('usr/share/Varin/varin');
  if(executable?.type!=='file'||!(executable.mode&0o111)||executable.elfMachine!==(architecture==='x64'?62:183)
    ||JSON.stringify(executable.bundleMarkers)!=='["DEB"]')throw new Error('Debian native binary lacks the exact format stamp');
  if(entries.get('usr/bin/varin')?.type!=='symlink')throw new Error('Debian executable registration is missing');
  for(const name of [...cefDebianFiles,'LICENSE.txt','CREDITS.html',...cefRequiredLocales.map(name=>`locales/${name}`)])if(entries.get(`usr/share/Varin/${name}`)?.type!=='file')throw new Error('Debian CEF runtime or license is missing');
  if(entries.get('usr/lib/Varin/runtime/runtime-manifest.json')?.sha256!==runtimeManifestSha256)throw new Error('Debian runtime differs from its candidate');
  if(entries.get(debianDesktopFile)?.type!=='file'||document.desktop?.Exec!=='/usr/bin/varin %U'
    ||!document.desktop?.MimeType?.split(';').includes('x-scheme-handler/varin'))throw new Error('Debian desktop registration is missing');
  if(!Array.isArray(document.dependencies)||debianDependencies.some(dependency=>!document.dependencies.includes(dependency)))throw new Error('Debian platform dependencies differ from the supported distribution');
  return document;
}
export async function inspectDebian(file,{architecture,version,sourceSha,runtimeManifestSha256,transition=true}={}) {
  if(!(await fs.lstat(file)).isFile())throw new Error('Debian package must be a regular file');
  const raw=JSON.parse(execFileSync('python3',[path.join(import.meta.dirname,'linux-debian-inventory.py'),file],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']}));
  if(JSON.stringify(raw.control.map(entry=>entry.path).sort())!=='["control","md5sums"]'||raw.control.some(entry=>entry.type!=='file'||entry.uid!==0||entry.gid!==0))throw new Error('Debian package has unreviewed installer scripts or control files');
  const control=controlFields(raw.control.find(entry=>entry.path==='control').text);
  if(control.Package!=='varin'||control.Version!==version||control.Architecture!==(architecture==='x64'?'amd64':'arm64'))throw new Error('Debian package control identity mismatch');
  const desktopText=raw.entries.find(entry=>entry.path===debianDesktopFile)?.text??'';
  const desktop={};for(const line of desktopText.split(/\r?\n/u)){const index=line.indexOf('=');if(index>0)desktop[line.slice(0,index)]=line.slice(index+1);}
  const runtimeEntry=raw.entries.find(entry=>entry.path==='usr/lib/Varin/runtime/runtime-manifest.json');
  const runtime=JSON.parse(runtimeEntry?.text??'null');
  if(runtime?.platform!=='linux'||runtime.architecture!==architecture||runtime.version!==version||runtime.sources?.sourceSha!==sourceSha||Boolean(runtime.legacyElectron)!==transition)throw new Error('Debian runtime generation mismatch');
  const expected=new Map((runtime.files??[]).map(entry=>[`usr/lib/Varin/runtime/${entry.path}`,entry]));
  for(const entry of raw.entries.filter(entry=>entry.type==='file'&&entry.path.startsWith('usr/lib/Varin/runtime/')&&entry!==runtimeEntry)){
    const record=expected.get(entry.path);if(!record||record.sha256!==entry.sha256||record.size!==entry.size||Boolean(entry.mode&0o111)!==record.executable)throw new Error('Debian package changed its immutable runtime');expected.delete(entry.path);
  }
  if(expected.size)throw new Error('Debian package omitted runtime files');
  const document={schema:1,product:'varin-debian-inventory',packageName:control.Package,version:control.Version,architecture,packageArchitecture:control.Architecture,
    sourceSha,runtimeManifestSha256,artifactSha256:await sha256(file),desktopFile:debianDesktopFile,desktop,dependencies:control.Depends?.split(', '),
    helpers:Object.keys(sandboxHelpers(architecture,{transition})),entries:raw.entries.map(({text,...entry})=>entry)};
  return validateDebianInventory(document,{architecture,version,sourceSha,runtimeManifestSha256,artifactSha256:document.artifactSha256,transition});
}

/** The final archive must retain every locale and unmodified non-stripped CEF
 * asset from the already verified SDK. Tauri strips only files ending in .so. */
export async function verifyDebianCefFiles(document,sdk) {
  const entries=new Map(document.entries.map(entry=>[entry.path,entry]));
  const locales=(await fs.readdir(path.join(sdk,'locales'))).sort();
  const observed=document.entries.filter(entry=>entry.type==='file'&&entry.path.startsWith('usr/share/Varin/locales/')).map(entry=>entry.path.slice('usr/share/Varin/locales/'.length)).sort();
  if(JSON.stringify(locales)!==JSON.stringify(observed))throw new Error('Debian CEF locale inventory differs from the pinned SDK');
  for(const name of [...cefDebianFiles.filter(name=>!name.endsWith('.so')),'CREDITS.html',...locales.map(name=>`locales/${name}`)]){
    if(entries.get(`usr/share/Varin/${name}`)?.sha256!==await sha256(path.join(sdk,name)))throw new Error('Debian CEF asset differs from the pinned SDK');
  }
  if(entries.get('usr/share/Varin/LICENSE.txt')?.sha256!==await sha256(await pinnedCefLicense(sdk)))throw new Error('Debian CEF license changed');
}
