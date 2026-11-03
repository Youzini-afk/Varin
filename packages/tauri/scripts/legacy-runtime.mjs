/** A transition-only, controlled old-engine reader. It is never a second Host. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { inventory, readBinaryIdentity, relativePath } from './runtime-manifest.mjs';
const entries={win32:'Varin.exe',darwin:'Varin.app/Contents/MacOS/Varin',linux:'varin'};
export async function stageLegacyElectron({source,destination,platform,architecture,version,sourceSha}){
  if(!entries[platform]||!['x64','arm64'].includes(architecture)||!/^\d+\.\d+\.\d+$/u.test(version)||!/^[a-f0-9]{40}$/u.test(sourceSha))throw new Error('Invalid legacy engine source identity');
  source=await fs.realpath(source);destination=path.resolve(destination);
  if(destination===source||destination.startsWith(source+path.sep)||source.startsWith(destination+path.sep))throw new Error('Legacy stage must be separate from its source');
  // Normalize framework symlinks for the portable immutable file inventory, but
  // never follow an external link or a cycle. Native signing MUST run after this
  // copy; an old bundle's signature cannot attest this new byte/layout generation.
  const scan=async(file,parents=new Set())=>{
    const real=await fs.realpath(file);if(real!==source&&!real.startsWith(source+path.sep))throw new Error('Legacy engine contains an external symbolic link');
    const stat=await fs.stat(file);if(stat.isDirectory()){
      if(parents.has(real))throw new Error('Legacy engine contains a symbolic-link cycle');
      const next=new Set(parents).add(real);for(const entry of await fs.readdir(file))await scan(path.join(file,entry),next);
    }else if(!stat.isFile())throw new Error('Legacy engine contains a special file');
  };
  await scan(source);
  const binary=await readBinaryIdentity(path.join(source,entries[platform]));
  if(binary.platform!==platform||binary.arch!==architecture)throw new Error('Legacy engine architecture does not match the desktop');
  const sourceManifest=JSON.parse(await fs.readFile(path.join(source,'varin-exporter.json'),'utf8'));
  if(sourceManifest.schema!==1||sourceManifest.protocol!==1||sourceManifest.version!==version||sourceManifest.sourceSha!==sourceSha
    ||sourceManifest.platform!==platform||sourceManifest.architecture!==architecture||sourceManifest.executable!==entries[platform]
    ||sourceManifest.entry!=='--varin-export-private-state')throw new Error('Legacy artifact is not the controlled exporter from this source');
  // Refuse replacement of an existing staged generation.
  await fs.mkdir(destination,{recursive:false});
  try{for(const name of await fs.readdir(source))await fs.cp(path.join(source,name),path.join(destination,name),{recursive:true,dereference:true,errorOnExist:true,force:false});}
  catch(error){await fs.rm(destination,{recursive:true,force:true});throw error;}
  const files=await inventory(destination);
  if(!files.some(file=>file.path===entries[platform]&&file.size))throw new Error('Legacy engine executable is missing');
  return{schema:1,version,sourceSha,executable:`legacy-electron/${entries[platform]}`,directory:'legacy-electron',protocol:1};
}
export function validateLegacyManifest(manifest){
  const legacy=manifest.legacyElectron;if(!legacy)return;
  if(legacy.schema!==1||legacy.protocol!==1||legacy.directory!=='legacy-electron'||legacy.executable!==`legacy-electron/${entries[manifest.platform]}`
    ||typeof legacy.version!=='string'||!/^[a-f0-9]{40}$/u.test(legacy.sourceSha))throw new Error('Invalid controlled legacy engine declaration');
  relativePath(legacy.executable);
  if(!manifest.files.some(file=>file.path===legacy.executable&&file.size)||!manifest.files.some(file=>file.path==='legacy-electron/varin-exporter.json'))throw new Error('Controlled legacy engine is not in the complete runtime inventory');
}
