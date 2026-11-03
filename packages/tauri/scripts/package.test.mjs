import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {transitionInstallerConfiguration,sandboxedAppImageLauncher,prepareWindowsInstallerResources} from './package.mjs';
import {newerVersion} from './release.mjs';
test('transition NSIS retains installed identity, custom UI, components and explicit retention',()=>{
 const config=transitionInstallerConfiguration({platform:'win32',architecture:'arm64',output:'/tmp/varin-fixture',signed:true});
 assert.equal(config.appId,'dev.varin.desktop');assert.equal(config.productName,'Varin');assert.equal(config.executableName,'varin');
 assert.match(config.nsis.include,/tauri[/\\]installer[/\\]installer.nsh$/u);assert.equal(config.nsis.oneClick,false);assert.equal(config.nsis.perMachine,false);
 assert.equal(config.nsis.differentialPackage,false);assert.equal(config.forceCodeSigning,true);assert.equal(config.afterPack,undefined);
 assert.deepEqual(config.mac.target,['dmg','zip']);assert.equal(config.dmg.backgroundColor,'#FFFCF0');
});
test('both shell versions must advance, never reinstall or downgrade themselves',()=>{
 assert.equal(newerVersion('1.2.4','1.2.3'),true);assert.equal(newerVersion('1.2.3','1.2.3'),false);assert.equal(newerVersion('1.2.3','2.0.0'),false);
 assert.throws(()=>newerVersion('1.2.3-rc.1','1.2.3'),/canonical/);
});
test('native Windows payload provides the real NSIS finalizer resource destination without redirects',async t=>{
 const {createRequire}=await import('node:module');const r=createRequire(new URL('../../electron/package.json',import.meta.url));
 const library=createRequire(createRequire(r.resolve('electron-builder')).resolve('app-builder-lib'));
 const {copyFile}=library('builder-util');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-nsis-resources-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const payload=path.join(root,'payload'),staged=path.join(root,'staged-elevate.exe');await fs.mkdir(payload);await fs.writeFile(staged,'synthetic signed-helper bytes');
 const destination=path.join(payload,'resources','elevate.exe');
 await assert.rejects(copyFile(staged,destination,false),error=>error.code==='ENOENT');
 assert.equal(await prepareWindowsInstallerResources(payload),path.join(await fs.realpath(payload),'resources'));
 await copyFile(staged,destination,false);assert.deepEqual(await fs.readFile(destination),await fs.readFile(staged));
 await prepareWindowsInstallerResources(payload);assert.deepEqual(await fs.readFile(destination),await fs.readFile(staged));
 await fs.rm(path.join(payload,'resources'),{recursive:true});await fs.writeFile(path.join(payload,'resources'),'not a directory');
 await assert.rejects(prepareWindowsInstallerResources(payload),/redirected/);await fs.unlink(path.join(payload,'resources'));
 if(process.platform!=='win32'){
  const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(payload,'resources'));
  await assert.rejects(prepareWindowsInstallerResources(payload),/redirected/);assert.deepEqual(await fs.readdir(outside),[]);
 }
});
test('AppImage keeps integration but never disables Chromium sandbox even when namespaces are unavailable',{skip:process.platform==='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-apprun-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=sandboxedAppImageLauncher();await fs.writeFile(path.join(root,'AppRun'),source,{mode:0o755});
 await fs.writeFile(path.join(root,'varin'),'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o755});
 const env={...process.env,APPDIR:root,APPIMAGE:path.join(root,'original.AppImage'),APPIMAGE_SILENT_INSTALL:'1'};
 assert.equal(execFileSync('bash',[path.join(root,'AppRun'),'--smoke'],{env,encoding:'utf8'}).trim(),'--smoke');
 for (const flag of ['--no-sandbox', '--no-sandbox=true']) assert.throws(()=>execFileSync('bash',[path.join(root,'AppRun'),flag],{env,stdio:'pipe'}));
});

test('real PE resource branding preserves machine/security fields and reseals only the bootstrap', async t => {
 const {createRequire}=await import('node:module');const r=createRequire(new URL('../../electron/package.json',import.meta.url));
 const library=createRequire(createRequire(r.resolve('electron-builder')).resolve('app-builder-lib'));
 const {NtExecutable,NtExecutableResource,Resource}=library('resedit');
 const {brandWindowsBootstrap}=await import('./package.mjs');
 const {windowsArchives,verifyWindowsBootstrap,cefVersion}=await import('./windows-bootstrap.mjs');
 const {inventory}=await import('./runtime-manifest.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-branding-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const executable=NtExecutable.createEmpty(false,false),resource=NtExecutableResource.from(executable),version=Resource.VersionInfo.createEmpty();
 version.setStringValues({lang:1033,codepage:1200},{ProductName:'CEF bootstrap'});version.outputToResourceEntries(resource.entries);resource.outputResource(executable);
 await fs.writeFile(path.join(root,'varin.exe'),Buffer.from(executable.generate()));await fs.mkdir(path.join(root,'locales'));
 for(const name of ['varin.dll','libcef.dll','icudtl.dat','resources.pak','locales/en-US.pak','LICENSE.txt','CREDITS.html'])await fs.writeFile(path.join(root,name),`fixture ${name}`);
 const receipt={schema:1,engine:'CEF',cefVersion,architecture:'x64',sandbox:'required',executable:'varin.exe',applicationLibrary:'varin.dll',entry:'RunWinMain',sdk:{archive:windowsArchives.x64.name,archiveSha1:windowsArchives.x64.sha1},files:await inventory(root)};
 await fs.writeFile(path.join(root,'cef-runtime-manifest.json'),JSON.stringify(receipt));
 const result=await brandWindowsBootstrap(root,'1.2.3');await verifyWindowsBootstrap(root);
 const branded=NtExecutableResource.from(NtExecutable.from(await fs.readFile(path.join(root,'varin.exe'))));
 const info=Resource.VersionInfo.fromEntries(branded.entries)[0];
 assert.equal(info.getStringValues({lang:1033,codepage:1200}).ProductName,'Varin');
 assert.equal(info.getStringValues({lang:1033,codepage:1200}).FileVersion,'1.2.3');
 assert.ok(branded.entries.some(entry=>entry.type===14));
 assert.equal(result.branding.sourceBootstrapSha256,receipt.files.find(file=>file.path==='varin.exe').sha256);
 for(const file of result.files.filter(file=>file.path!=='varin.exe'))assert.equal(file.sha256,receipt.files.find(old=>old.path===file.path).sha256);
 result.signing={application:'verified'};await fs.writeFile(path.join(root,'cef-runtime-manifest.json'),JSON.stringify(result));
 await assert.rejects(brandWindowsBootstrap(root,'1.2.4'),/before signing/);
});

test('the actual AppImage desktop generator emits a Varin scheme handler without disabling sandbox',async()=>{
 const {createRequire}=await import('node:module');const r=createRequire(new URL('../../electron/package.json',import.meta.url));
 const library=createRequire(createRequire(r.resolve('electron-builder')).resolve('app-builder-lib'));
 const {LinuxTargetHelper}=library('./targets/LinuxTargetHelper.js');const AppImageTarget=library('./targets/appimage/AppImageTarget.js').default;
 const {verifyLinuxProtocol,verifyMacProtocol}=await import('./package.mjs');
 const config=transitionInstallerConfiguration({platform:'linux',architecture:'x64',output:'/tmp/unused',signed:false});
 const packager={config,platformSpecificBuildOptions:config.linux,appInfo:{productName:'Varin',buildVersion:'1.2.3'},executableName:'varin',info:{metadata:{desktopName:'varin.desktop',description:'test'}},fileAssociations:[]};
 const target=new AppImageTarget(null,packager,new LinuxTargetHelper(packager),'/tmp/unused');
 const desktop=await target.desktopEntry.value;
 assert.equal(verifyLinuxProtocol(desktop).Exec,'AppRun %U');
 assert.throws(()=>verifyLinuxProtocol(desktop.replace('AppRun %U','AppRun --no-sandbox %U')),/safe Varin/);
 assert.throws(()=>verifyLinuxProtocol(desktop.replace('x-scheme-handler/varin','x-scheme-handler/other')),/Varin/);
 verifyMacProtocol({CFBundleURLTypes:[{CFBundleURLName:'dev.varin.desktop',CFBundleURLSchemes:['varin']}]});
 assert.throws(()=>verifyMacProtocol({CFBundleURLTypes:[]}),/URL handler/);
});
