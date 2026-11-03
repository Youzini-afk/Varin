import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync,execFileSync} from 'node:child_process';
import test from 'node:test';
import {candidateConfiguration} from './build-candidate.mjs';
import {debianConfiguration,debianDependencies,inspectDebian,sandboxHelpers,verifyDebianCefFiles} from './linux-debian.mjs';
import {sha256} from './runtime-manifest.mjs';

const script=path.join(import.meta.dirname,'linux-debian-inventory.py');
test('pinned Debian bundler stamps native bytes and writes root/setuid archive metadata without changing host privileges',async t=>{
  if(process.platform!=='linux'){t.skip('Native Debian archive regression');return;}
  for(const command of ['cargo','rustc','dpkg-deb','python3','strip'])if(spawnSync(command,['--version']).status!==0){t.skip(`Requires ${command}, not installation privileges`);return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-debian-metadata-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const native=path.join(root,'src-tauri'),target=path.join(root,'target'),runtime=path.join(root,'runtime'),sdk=path.join(root,'cef-placeholder');
  for(const directory of [path.join(native,'src'),path.join(target,'release'),path.join(runtime,'frontend'),path.join(runtime,'legacy-electron'),path.join(sdk,'locales'),path.join(native,'stub/src')])await fs.mkdir(directory,{recursive:true});
  const config=JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  config.bundle.icon=config.bundle.icon.map(icon=>path.resolve(import.meta.dirname,'../src-tauri',icon));config.build.beforeBundleCommand=null;
  await fs.writeFile(path.join(native,'tauri.conf.json'),JSON.stringify(config));
  await fs.writeFile(path.join(native,'Cargo.toml'),`[package]\nname="varin"\nversion="${config.version}"\nedition="2021"\ndescription="Unexecuted archive metadata probe"\nlicense="AGPL-3.0-only"\nauthors=["Varin"]\n[features]\ndesktop=[]\n[dependencies]\ntauri-runtime-cef={path="stub"}\n`);
  await fs.writeFile(path.join(native,'stub/Cargo.toml'),'[package]\nname="tauri-runtime-cef"\nversion="0.0.0"\nedition="2021"\n');
  await fs.writeFile(path.join(native,'stub/src/lib.rs'),'');
  await fs.writeFile(path.join(native,'src/main.rs'),'fn main() {}');
  const binary=path.join(target,'release/varin');await fs.copyFile('/bin/true',binary);
  await fs.appendFile(binary,'__TAURI_BUNDLE_TYPE_VAR_UNK');
  await fs.writeFile(path.join(runtime,'frontend/index.html'),'<!doctype html>Unexecuted packaging probe');
  // These inert bytes are intentionally NOT an official helper. They exercise
  // the actual tar mode writer, then must be rejected by product inspection.
  const helper=path.join(sdk,'chrome-sandbox'),legacy=path.join(runtime,'legacy-electron/chrome-sandbox');
  await fs.writeFile(helper,'inert-unexecuted-cef-helper',{mode:0o755});
  await fs.writeFile(legacy,'inert-unexecuted-electron-helper',{mode:0o755});
  await fs.writeFile(path.join(sdk,'CREDITS.html'),'Fixture credits');
  for(const name of ['en-US.pak','en-US_FEMININE.pak','en-US_MASCULINE.pak','en-US_NEUTER.pak','zh-CN.pak'])await fs.writeFile(path.join(sdk,'locales',name),'Fixture locale '+name);
  for(const name of ['libcef.so','libEGL.so','libGLESv2.so','libvk_swiftshader.so','libvulkan.so.1'])await fs.copyFile('/bin/true',path.join(sdk,name));
  for(const name of ['icudtl.dat','v8_context_snapshot.bin','chrome_100_percent.pak','chrome_200_percent.pak','resources.pak','vk_swiftshader_icd.json'])await fs.writeFile(path.join(sdk,name),'Unexecuted CEF resource '+name);
  const deb=await debianConfiguration(sdk);deb.bundle.linux.deb.files['/usr/share/Varin/chrome-sandbox']=helper;
  const require=createRequire(new URL('../package.json',import.meta.url)),cli=path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')),'tauri.js');
  const env={...process.env,CARGO_NET_OFFLINE:'true',CARGO_HOME:path.join(root,'cargo-home'),CARGO_TARGET_DIR:target,CEF_PATH:sdk};delete env.CARGO_BUILD_TARGET;delete env.TAURI_CONFIG;
  const invoke=()=>spawnSync(process.execPath,[cli,'bundle','--ci','--no-sign','--bundles','deb','--features','desktop','--config',JSON.stringify(candidateConfiguration(runtime)),'--config',JSON.stringify(deb)],{cwd:root,env,encoding:'utf8',timeout:30000});
  const result=invoke();assert.ifError(result.error);assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  const archives=(await fs.readdir(path.join(target,'release/bundle/deb'))).filter(name=>name.endsWith('.deb'));assert.equal(archives.length,1);
  const file=path.join(target,'release/bundle/deb',archives[0]);
  const inventory=JSON.parse(execFileSync('python3',[script,file],{encoding:'utf8'}));
  for(const [name,source] of [['usr/share/Varin/chrome-sandbox',helper],['usr/lib/Varin/runtime/legacy-electron/chrome-sandbox',legacy]]){
    const entry=inventory.entries.find(entry=>entry.path===name);assert.equal(entry.mode,0o4755);assert.equal(entry.uid,0);assert.equal(entry.gid,0);assert.equal(entry.sha256,await sha256(source));assert.equal((await fs.lstat(source)).mode&0o7777,0o755);
  }
  assert.deepEqual(inventory.entries.find(entry=>entry.path==='usr/bin/varin').link,'../share/Varin/varin');
  assert.ok(inventory.entries.some(entry=>entry.path==='usr/share/Varin/locales/zh-CN.pak'));
  assert.ok(inventory.entries.some(entry=>entry.path==='usr/share/Varin/LICENSE.txt'));
  await verifyDebianCefFiles(inventory,sdk);
  await assert.rejects(verifyDebianCefFiles({...inventory,entries:inventory.entries.filter(entry=>entry.path!=='usr/share/Varin/locales/zh-CN.pak')},sdk),/locale inventory/);
  const damaged=structuredClone(inventory);damaged.entries.find(entry=>entry.path==='usr/share/Varin/icudtl.dat').sha256='0'.repeat(64);
  await assert.rejects(verifyDebianCefFiles(damaged,sdk),/asset differs/);
  const directory=inventory.entries.find(entry=>entry.path==='usr/share/Varin');assert.equal(directory.uid,0);assert.equal(directory.mode,0o755);
  const control=inventory.control.find(entry=>entry.path==='control').text;
  assert.ok(debianDependencies.every(dependency=>control.includes(dependency)));
  assert.deepEqual(inventory.control.map(entry=>entry.path).sort(),['control','md5sums']);
  const desktop=inventory.entries.find(entry=>entry.path==='usr/share/applications/Varin.desktop');assert.match(desktop.text,/^Exec=\/usr\/bin\/varin %U$/mu);assert.match(desktop.text,/^MimeType=x-scheme-handler\/varin;$/mu);
  const stamped=execFileSync('dpkg-deb',['--fsys-tarfile',file]);
  // The small archive has no real CEF data. Only inspect its bytes; never run it.
  assert.ok(stamped.includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_DEB')));assert.ok(!stamped.includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')));
  await assert.rejects(inspectDebian(file,{architecture:process.arch,version:config.version,sourceSha:'a'.repeat(40),runtimeManifestSha256:'b'.repeat(64)}));
  const hook=path.join(root,'forbidden-postinst');await fs.writeFile(hook,'#!/bin/sh\nexit 0\n');deb.bundle.linux.deb.postInstallScript=hook;
  const modified=invoke();assert.equal(modified.status,0,modified.stderr);
  await assert.rejects(inspectDebian(file,{architecture:process.arch,version:config.version}),/unreviewed installer scripts/);
});

test('only exact official CEF and transition Electron helper paths are eligible',()=>{
  for(const architecture of ['x64','arm64']){
    assert.deepEqual(Object.keys(sandboxHelpers(architecture)),['usr/share/Varin/chrome-sandbox','usr/lib/Varin/runtime/legacy-electron/chrome-sandbox']);
    assert.deepEqual(Object.keys(sandboxHelpers(architecture,{transition:false})),['usr/share/Varin/chrome-sandbox']);
  }
  assert.throws(()=>sandboxHelpers('ia32'),/Unsupported/);
});
