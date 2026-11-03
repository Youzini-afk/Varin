/** Assemble an immutable, independently signed desktop transition candidate.
 * This tool never publishes, creates keys, or turns absence of evidence into success. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPerformanceEvidence } from './performance-evidence.mjs';
import { canonicalJson, metadataBytes, verifyMinisign, verifySignedMetadata } from '../../../scripts/desktop-update-signatures.mjs';
export const releaseTargets = ['darwin-x64','darwin-arm64','linux-x64','linux-arm64','win32-x64','win32-arm64'];
export const acceptanceDomains = ['startup-local-remote','browser-sandbox','browser-interaction','companion-animation','platform-integration','legacy-data-migration','installer-update-uninstall','update-cancellation','operating-system-signature','resource-performance'];
const hex = (value,length) => typeof value==='string' && new RegExp(`^[a-f0-9]{${length}}$`,'u').test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cefLock=JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json',import.meta.url),'utf8'));
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export function newerVersion(next,previous){
  if(!versionPattern.test(next)||!versionPattern.test(previous))throw new Error('Stable desktop versions must be canonical semver');
  const a=next.split('.').map(BigInt),b=previous.split('.').map(BigInt);
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
function filename(name){if(typeof name!=='string'||!name||/[\\/\x00-\x1f]/u.test(name)||name==='.'||name==='..')throw new Error('Unsafe release artifact name');return name;}
async function bytesFor(root,record){
  filename(record.name);const file=path.join(root,record.name);
  if(!(await fs.lstat(file)).isFile())throw new Error(`Release artifact is not a regular file: ${record.name}`);
  const bytes=await fs.readFile(file);
  if(record.size!==bytes.length||record.sha256!==hash(bytes))throw new Error(`Release artifact digest mismatch: ${record.name}`);
  return bytes;
}
export async function verifyAcceptance(root,receipt,{target,sourceSha,version,runtimeManifestSha256,engineManifestSha256,artifacts}){
  if(receipt.schema!==1||receipt.target!==target||receipt.sourceSha!==sourceSha||receipt.version!==version
    ||receipt.runtimeManifestSha256!==runtimeManifestSha256||receipt.engineManifestSha256!==engineManifestSha256
    ||canonicalJson(receipt.artifacts)!==canonicalJson(artifacts))throw new Error(`Acceptance belongs to another candidate: ${target}`);
  if(!Array.isArray(receipt.results))throw new Error(`Missing platform evidence: ${target}`);
  for(const domain of acceptanceDomains){
    const matches=receipt.results.filter(result=>result.domain===domain);
    if(matches.length!==1||matches[0].status!=='passed'||typeof matches[0].procedure!=='string'||!matches[0].procedure.trim())throw new Error(`Missing passed ${domain} evidence: ${target}`);
    // Linux has no mandatory OS code signature. It still records the actual
    // signed updater verification procedure, rather than inventing an OS signer.
    const evidence = await bytesFor(root, matches[0].evidence);
    if (!evidence.length) throw new Error(`Empty platform evidence: ${target}/${domain}`);
    if (domain === 'resource-performance') verifyPerformanceEvidence(JSON.parse(evidence), { target, sourceSha, version, runtimeManifestSha256, engineManifestSha256, artifacts });
  }
  return receipt;
}
export async function verifyQualification(document,{publicKey,runtimeManifestSha256,platform,architecture}){
  verifySignedMetadata(document,publicKey);
  const target=`${platform}-${architecture}`;
  const entry=document.targets?.[target];
  if(document.schema!==1||document.product!=='varin-tauri-qualification'||!hex(document.sourceSha,40)||!versionPattern.test(document.version)
    ||!entry||entry.runtimeManifestSha256!==runtimeManifestSha256||!hex(entry.engineManifestSha256,64)
    ||!hex(entry.acceptanceSha256,64)||entry.acceptedDomains?.length!==acceptanceDomains.length
    ||acceptanceDomains.some(domain=>!entry.acceptedDomains.includes(domain)))throw new Error('Production qualification does not match this exact runtime');
  return entry;
}
const legacyChannels = ['latest.yml', 'latest-arm64.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];
export function verifyLegacyBridge(document, { publicKey, nextVersion, previousElectronVersion }) {
  verifySignedMetadata(document, publicKey);
  if (document.schema !== 1 || document.product !== 'varin-electron-transition' || !hex(document.sourceSha, 40)
    || !newerVersion(nextVersion, document.version) || !newerVersion(document.version, previousElectronVersion)
    || canonicalJson(Object.keys(document.feeds ?? {}).sort()) !== canonicalJson([...legacyChannels].sort())) throw new Error('Missing immutable Electron transition bridge');
  const base = `https://github.com/Youzini-afk/Varin/releases/download/v${document.version}/`;
  for (const channel of legacyChannels) {
    const feed = document.feeds[channel];
    if (!Number.isFinite(Date.parse(feed.date)) || feed.records?.length !== (channel === 'latest-mac.yml' ? 2 : 1)) throw new Error('Incomplete legacy transition feed');
    for (const record of feed.records) {
      if (typeof record.url !== 'string' || !record.url.startsWith(base) || !Number.isSafeInteger(record.size) || record.size <= 0
        || typeof record.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(record.sha512)) throw new Error('Invalid legacy transition artifact');
      const name = decodeURIComponent(record.url.slice(base.length));
      if (downloadUrl(base, name) !== record.url) throw new Error('Legacy bridge changed immutable release destination');
    }
  }
  return document;
}
export async function verifyCandidate(root,candidate,{publicKey}){
  if(candidate.schema!==1||candidate.product!=='varin-tauri-candidate'||!hex(candidate.sourceSha,40)||!versionPattern.test(candidate.version)
    ||!hex(candidate.toolingSha,40)||candidate.releaseRef!==`v${candidate.version}`)throw new Error('Invalid immutable Tauri candidate identity');
  if(!['electron-to-tauri','tauri'].includes(candidate.transition?.mode)
    ||!newerVersion(candidate.version,candidate.transition.previousElectronVersion)
    ||candidate.transition.previousTauriVersion!==null&&!newerVersion(candidate.version,candidate.transition.previousTauriVersion))throw new Error('Transition must be explicit and strictly newer than both installed shells');
  if(candidate.transition.mode==='electron-to-tauri' && candidate.transition.previousTauriVersion!==null) throw new Error('The initial Electron transition cannot replace an existing Tauri release history');
  if(candidate.transition.mode==='tauri') {
    if(candidate.transition.previousTauriVersion===null) throw new Error('Subsequent Tauri releases require the previous Tauri version');
    verifyLegacyBridge(candidate.transition.legacyBridge, { publicKey, nextVersion: candidate.version, previousElectronVersion: candidate.transition.previousElectronVersion });
  }
  if(canonicalJson(Object.keys(candidate.targets??{}).sort())!==canonicalJson([...releaseTargets].sort()))throw new Error('Every existing desktop platform and architecture is required');
  const names=new Map();
  for(const target of releaseTargets){
    const entry=candidate.targets[target];
    if(!hex(entry.runtimeManifestSha256,64)||!hex(entry.engineManifestSha256,64))throw new Error(`Missing runtime/engine identity: ${target}`);
    const runtime=JSON.parse(await bytesFor(root,entry.runtimeManifest));
    const engine=JSON.parse(await bytesFor(root,entry.engineManifest));
    if(entry.runtimeManifest.sha256!==entry.runtimeManifestSha256||entry.engineManifest.sha256!==entry.engineManifestSha256
      ||runtime.product!=='varin-tauri-desktop'||runtime.version!==candidate.version||runtime.sources?.sourceSha!==candidate.sourceSha||runtime.sources?.sourceDirty!==false
      ||`${runtime.platform}-${runtime.architecture}`!==target||engine.engine!=='CEF'||engine.architecture!==runtime.architecture
      ||engine.cefVersion!==cefLock.version||engine.sandbox!=='required'||engine.sourceSha!==candidate.sourceSha||engine.sdk?.sha1!==cefLock.targets[target].sha1
      ||runtime.browser?.engine!=='CEF'||runtime.browser?.version!==cefLock.version||runtime.browser?.sourceArchiveSha1!==cefLock.targets[target].sha1)
      throw new Error(`Runtime/engine receipt source mismatch: ${target}`);
    if(candidate.transition.mode==='tauri' && runtime.legacyElectron) throw new Error(`Steady-state Tauri must not retain the old browser engine: ${target}`);
    if(candidate.transition.mode==='electron-to-tauri'&&(!runtime.legacyElectron||runtime.legacyElectron.sourceSha!==candidate.sourceSha||runtime.legacyElectron.protocol!==1))throw new Error(`Transition must retain the controlled legacy reader: ${target}`);
    const artifacts=[entry.update,...(entry.electron??[])];
    if(!entry.update||entry.electron?.length!==(target.startsWith('darwin')?2:1))throw new Error(`Missing updater or legacy installer format: ${target}`);
    const expectedElectron=target.startsWith('win32')?['.exe']:target.startsWith('darwin')?['.dmg','.zip']:['.AppImage'];
    for(const extension of expectedElectron)if(!entry.electron.some(file=>file.name.endsWith(extension)))throw new Error(`Missing ${extension} transition artifact: ${target}`);
    if(!entry.update.name.endsWith(target.startsWith('win32')?'.exe':target.startsWith('darwin')?'.app.tar.gz':'.AppImage'))throw new Error(`Wrong Tauri update format: ${target}`);
    for(const record of artifacts){
      const bytes=await bytesFor(root,record);
      if(record.sha512!==createHash('sha512').update(bytes).digest('base64'))throw new Error(`Electron checksum mismatch: ${record.name}`);
      if(record===entry.update)verifyMinisign(bytes,record.signature,publicKey,{version:candidate.version});
      if(names.has(record.name)&&names.get(record.name)!==target)throw new Error('Artifact names collide across targets');
      names.set(record.name,target);
    }
    const acceptanceBytes=await bytesFor(root,entry.acceptance);
    await verifyAcceptance(root,JSON.parse(acceptanceBytes),{target,sourceSha:candidate.sourceSha,version:candidate.version,
      runtimeManifestSha256:entry.runtimeManifestSha256,engineManifestSha256:entry.engineManifestSha256,
      artifacts:Object.fromEntries(artifacts.map(file=>[file.name,file.sha256]))});
  }
  return candidate;
}
function downloadUrl(base,name){const url=new URL(encodeURIComponent(filename(name)),base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Release artifacts require immutable HTTPS URLs');return url.href;}
function electronYaml(version,records,date){return [`version: ${version}`,'files:',...records.flatMap(file=>[`  - url: ${file.url}`,`    sha512: ${file.sha512}`,`    size: ${file.size}`]),`path: ${records[0].url}`,`sha512: ${records[0].sha512}`,`releaseDate: '${date}'`,''].join('\n');}
export async function assembleRelease(root,candidate,{publicKey,sign,notes='',date=new Date().toISOString(),output}){
  await verifyCandidate(root,candidate,{publicKey});
  if(!Number.isFinite(Date.parse(date)))throw new Error('Invalid release date');
  const base=`https://github.com/Youzini-afk/Varin/releases/download/${candidate.releaseRef}/`;
  const feed={version:candidate.version,notes,pub_date:date,varin:{schema:1,product:'varin-tauri-desktop',channel:'stable',sourceSha:candidate.sourceSha},platforms:{}};
  const qualification={schema:1,product:'varin-tauri-qualification',version:candidate.version,sourceSha:candidate.sourceSha,targets:{}};
  const electron=new Map();
  for(const target of releaseTargets){
    const entry=candidate.targets[target];
    feed.platforms[target]={url:downloadUrl(base,entry.update.name),signature:entry.update.signature,sha256:entry.update.sha256,size:entry.update.size};
    qualification.targets[target]={runtimeManifestSha256:entry.runtimeManifestSha256,engineManifestSha256:entry.engineManifestSha256,acceptanceSha256:entry.acceptance.sha256,acceptedDomains:acceptanceDomains};
    const channel=target.startsWith('win32')?(target.endsWith('arm64')?'latest-arm64.yml':'latest.yml'):target.startsWith('darwin')?'latest-mac.yml':target.endsWith('arm64')?'latest-linux-arm64.yml':'latest-linux.yml';
    const selected=entry.electron.filter(record=>!record.name.endsWith('.dmg')).map(record=>({url:downloadUrl(base,record.name),sha512:record.sha512,size:record.size}));
    electron.set(channel,[...(electron.get(channel)??[]),...selected]);
  }
  const destination = path.resolve(output);
  if (await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Release metadata output must be a new directory');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  output = await fs.mkdtemp(path.join(path.dirname(destination), '.tauri-metadata-'));
  try {
  for(const [name,document] of [['tauri-v1.json',feed],['tauri-qualification.json',qualification]]){
    document.varinSignature=await sign(metadataBytes(document),candidate.version,name);
    verifySignedMetadata(document,publicKey);
    await fs.writeFile(path.join(output,name),JSON.stringify(document,null,2)+'\n');
  }
  let bridge = candidate.transition.legacyBridge;
  if (candidate.transition.mode === 'electron-to-tauri') {
    bridge = { schema: 1, product: 'varin-electron-transition', version: candidate.version, sourceSha: candidate.sourceSha,
      feeds: Object.fromEntries([...electron].map(([name, records]) => [name, { date, records }])) };
    bridge.varinSignature = await sign(metadataBytes(bridge), candidate.version, 'electron-transition.json');
    verifySignedMetadata(bridge, publicKey);
  }
  for (const [name, feed] of Object.entries(bridge.feeds)) await fs.writeFile(path.join(output, name), electronYaml(bridge.version, feed.records, feed.date));
  await fs.writeFile(path.join(output, 'electron-transition.json'), JSON.stringify(bridge, null, 2) + '\n');
  await fs.writeFile(path.join(output,'tauri-candidate.json'),JSON.stringify(candidate,null,2)+'\n');
  await fs.rename(output, destination);
  return{feed,qualification,bridge};
  } catch (error) { await fs.rm(output, { recursive: true, force: true }); throw error; }
}
export async function tauriSignFile(file,version,{environment=process.env}={}){
  if(!environment.TAURI_SIGNING_PRIVATE_KEY&&!environment.TAURI_SIGNING_PRIVATE_KEY_PATH)throw new Error('Supply TAURI_SIGNING_PRIVATE_KEY through the protected release environment; this tool never creates keys');
  const require=createRequire(new URL('../package.json',import.meta.url));
  const cli=path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')),'tauri.js');
  // No private keys/passwords in argv, stdout, thrown child output, or artifacts.
  try{execFileSync(process.execPath,[cli,'signer','sign','--app-version',version,file],{env:environment,stdio:'pipe'});}catch{throw new Error('Tauri signing failed; inspect protected runner configuration');}
  return(await fs.readFile(file+'.sig','utf8')).trim();
}
export async function recordArtifact(file,{signature}={}){
  const bytes=await fs.readFile(file);return{name:path.basename(file),size:bytes.length,sha256:hash(bytes),sha512:createHash('sha512').update(bytes).digest('base64'),...(signature?{signature}: {})};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);const option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw new Error(`Missing ${name}`);return args[i+1];};
  const root=path.resolve(option('--directory')),candidate=JSON.parse(await fs.readFile(option('--candidate'),'utf8'));
  const publicKey=process.env.VARIN_TAURI_UPDATER_PUBLIC_KEY;if(!publicKey)throw new Error('VARIN_TAURI_UPDATER_PUBLIC_KEY is required');
  if(command==='verify')await verifyCandidate(root,candidate,{publicKey});
  else if(command==='assemble'){
    const output=path.resolve(option('--output'));
    await assembleRelease(root,candidate,{publicKey,output,sign:async(bytes,version,name)=>{
      const temporary=await fs.mkdtemp(path.join(root,'.update-sign-'));const file=path.join(temporary,name);
      try{await fs.writeFile(file,bytes);return await tauriSignFile(file,version);}finally{await fs.rm(temporary,{recursive:true,force:true});}
    }});
  }else throw new Error('Usage: release.mjs verify|assemble --directory DIR --candidate FILE [--output DIR]');
}
