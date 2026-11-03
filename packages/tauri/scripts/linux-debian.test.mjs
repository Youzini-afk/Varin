import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync,execFileSync} from 'node:child_process';
import test from 'node:test';
import {candidateConfiguration} from './build-candidate.mjs';
import {debianConfiguration,debianDependencies,debianLauncher,debianLauncherSha256,inspectDebian,sandboxHelpers,verifyDebianCefFiles} from './linux-debian.mjs';
import {sha256} from './runtime-manifest.mjs';

const script=path.join(import.meta.dirname,'linux-debian-inventory.py');
test('pinned Debian bundler stamps native bytes and writes root/setuid archive metadata without changing host privileges',async t=>{
  if(process.platform!=='linux'){t.skip('Native Debian archive regression');return;}
  for(const command of ['cargo','rustc','cc','dpkg-deb','python3'])if(spawnSync(command,['--version']).status!==0){t.skip(`Requires ${command}, not installation privileges`);return;}
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
  // Use actual native shared libraries with debug information. Explicit
  // Debian resources must retain all bytes, never silently strip them.
  const librarySource=path.join(root,'library.c'),library=path.join(root,'library.so');
  await fs.writeFile(librarySource,'int varin_archive_probe(void) { return 42; }\n');
  execFileSync('cc',['-shared','-fPIC','-g',librarySource,'-o',library],{stdio:'pipe'});
  // The pinned CEF 156 SDK no longer ships separate EGL/GLES libraries.
  const libraryNames=['libcef.so','libvk_swiftshader.so','libvulkan.so.1'];
  for(const name of libraryNames)await fs.copyFile(library,path.join(sdk,name));
  const sourceLibraries=await Promise.all(libraryNames.map(async name=>({name,sha256:await sha256(path.join(sdk,name)),mode:(await fs.lstat(path.join(sdk,name))).mode})));
  for(const name of ['icudtl.dat','v8_context_snapshot.bin','chrome_100_percent.pak','chrome_200_percent.pak','resources.pak','vk_swiftshader_icd.json'])await fs.writeFile(path.join(sdk,name),'Unexecuted CEF resource '+name);
  const deb=await debianConfiguration(sdk,{executable:binary});
  const require=createRequire(new URL('../package.json',import.meta.url)),cli=path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')),'tauri.js');
  const env={...process.env,CARGO_NET_OFFLINE:'true',CARGO_HOME:path.join(root,'cargo-home'),CARGO_TARGET_DIR:target,CEF_PATH:sdk};delete env.CARGO_BUILD_TARGET;delete env.TAURI_CONFIG;
  const invoke=(configuration=deb)=>spawnSync(process.execPath,[cli,'bundle','--ci','--no-sign','--bundles','deb','--features','desktop','--config',JSON.stringify(candidateConfiguration(runtime)),'--config',JSON.stringify(configuration)],{cwd:root,env,encoding:'utf8',timeout:30000});
  // Reproduce the real pinned CLI failure against the current SDK file list,
  // before proving the supported explicit-resource path on the same bytes.
  const upstream=invoke({bundle:{linux:{deb:{depends:debianDependencies}}}});
  assert.ifError(upstream.error);assert.notEqual(upstream.status,0);assert.match(upstream.stderr,/No such file or directory/u);
  const result=invoke();assert.ifError(result.error);assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  const archives=(await fs.readdir(path.join(target,'release/bundle/deb'))).filter(name=>name.endsWith('.deb'));assert.equal(archives.length,1);
  const file=path.join(target,'release/bundle/deb',archives[0]);
  const inventory={...JSON.parse(execFileSync('python3',[script,file],{encoding:'utf8'})),architecture:process.arch};
  for(const [name,source] of [['usr/share/Varin/chrome-sandbox',helper],['usr/lib/Varin/runtime/legacy-electron/chrome-sandbox',legacy]]){
    const entry=inventory.entries.find(entry=>entry.path===name);assert.equal(entry.mode,0o4755);assert.equal(entry.uid,0);assert.equal(entry.gid,0);assert.equal(entry.sha256,await sha256(source));assert.equal((await fs.lstat(source)).mode&0o7777,0o755);
  }
  const launcher=inventory.entries.find(entry=>entry.path==='usr/bin/varin');
  assert.equal(launcher.type,'file');assert.equal(launcher.mode,0o755);assert.equal(launcher.uid,0);assert.equal(launcher.gid,0);
  assert.equal(launcher.sha256,debianLauncherSha256);assert.equal(launcher.size,Buffer.byteLength(debianLauncher));
  assert.equal(inventory.entries.find(entry=>entry.path==='usr/share/Varin/varin').sha256,await sha256(binary));
  assert.ok(!inventory.entries.some(entry=>/lib(?:EGL|GLESv2)\.so$/u.test(entry.path)));
  assert.ok(inventory.entries.some(entry=>entry.path==='usr/share/Varin/locales/zh-CN.pak'));
  assert.ok(inventory.entries.some(entry=>entry.path==='usr/share/Varin/LICENSE.txt'));
  await verifyDebianCefFiles(inventory,sdk);
  for(const source of sourceLibraries){
    assert.equal(await sha256(path.join(sdk,source.name)),source.sha256);
    assert.equal((await fs.lstat(path.join(sdk,source.name))).mode,source.mode);
    const installed=inventory.entries.find(entry=>entry.path===`usr/share/Varin/${source.name}`);
    assert.equal(installed.sha256,source.sha256,'Every shared library must remain byte-identical to the SDK');
    assert.equal(installed.size,(await fs.stat(path.join(sdk,source.name))).size);
  }
  // Alter bytes inside copies of the real bundler archive, never extract its
  // SUID metadata onto the host. Keep valid ELF headers for replacement and
  // truncation so neither a name/header check nor the recorded hash suffices.
  const corruptArchive=String.raw`
import io, subprocess, sys, tarfile
source, destination, operation = sys.argv[1:]
control = subprocess.check_output(['dpkg-deb','--ctrl-tarfile',source])
data = subprocess.check_output(['dpkg-deb','--fsys-tarfile',source])
output = io.BytesIO()
with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as original, tarfile.open(fileobj=output,mode='w:',format=tarfile.GNU_FORMAT) as changed:
    for member in original:
        contents = original.extractfile(member).read() if member.isfile() else None
        if member.name.removeprefix('./') == 'usr/share/Varin/libcef.so':
            if operation == 'replace': contents = contents[:-1] + bytes([contents[-1] ^ 1])
            elif operation == 'truncate': contents = contents[:64]
            elif operation == 'empty': contents = b''
            elif operation == 'foreign':
                contents = bytearray(contents)
                foreign = 183 if int.from_bytes(contents[18:20],'little') == 62 else 62
                contents[18:20] = foreign.to_bytes(2,'little')
                contents = bytes(contents)
            member.size = len(contents)
        changed.addfile(member,io.BytesIO(contents) if contents is not None else None)
with open(destination,'wb') as archive:
    archive.write(b'!<arch>\n')
    for name, contents in [('debian-binary',b'2.0\n'),('control.tar',control),('data.tar',output.getvalue())]:
        header = f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(contents):<10}' + '\x60\n'
        archive.write(header.encode()); archive.write(contents)
        if len(contents) % 2: archive.write(b'\n')
`;
  for(const operation of ['replace','truncate','empty','foreign']){
    const altered=path.join(root,`${operation}.deb`);
    execFileSync('python3',['-I','-c',corruptArchive,file,altered,operation],{stdio:'pipe'});
    const observed={...JSON.parse(execFileSync('python3',[script,altered],{encoding:'utf8'})),architecture:process.arch};
    await assert.rejects(verifyDebianCefFiles(observed,sdk),/CEF library (differs|is empty)/);
  }
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
