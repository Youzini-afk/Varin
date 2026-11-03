/** Build only the one-shot old Chromium reader, never another normal desktop. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareHost,resolveBunExecutable,repository} from '../../../scripts/build-products.mjs';
import {stageRuntime} from '../../electron/scripts/stage-runtime.mjs';
const electronRoot=path.join(repository,'packages/electron'),require=createRequire(path.join(electronRoot,'package.json'));
export async function prepareLegacyExporter(destination){
  destination=path.resolve(destination);await fs.mkdir(destination,{recursive:false});
  const app=JSON.parse(await fs.readFile(path.join(repository,'package.json'),'utf8'));
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  const host=await prepareHost();const staging=path.join(destination,'staging');
  const layout=await stageRuntime({repository,destination:staging,hostDirectory:host.directory,platform:process.platform,architecture:process.arch,entries:[],
    manifest:{name:'@varin/electron-exporter',version:app.version,main:'bootstrap.mjs',private:true,type:'module',license:app.license,dependencies:{'@varin/web':'workspace:*'}}});
  execFileSync(resolveBunExecutable(),[path.join(import.meta.dirname,'exporter-bundle.mjs'),path.join(staging,'dist-bundle')],{cwd:repository,stdio:'inherit'});
  await fs.writeFile(path.join(staging,'bootstrap.mjs'),`// This controlled reader cannot start a normal legacy desktop or Host.\nif (!process.argv.includes('--varin-export-private-state')) process.exit(2);\ntry { await import('./dist-bundle/frontend-migration.mjs'); } catch { process.stderr.write('Legacy state reader could not start.\\n'); process.exit(1); }\n`);
  const configuration=structuredClone(require('./package.json').build);
  delete configuration.beforePack;delete configuration.afterPack;delete configuration.onNodeModuleFile;
  configuration.directories={app:staging,output:path.join(destination,'builder'),buildResources:path.join(electronRoot,'resources/icons')};
  configuration.files=['**/*'];configuration.extraResources=[];configuration.extraFiles=[];configuration.asarUnpack=layout.unpackPatterns;
  configuration.publish=null;configuration.electronVersion=require('electron/package.json').version;
  configuration.mac={...configuration.mac,identity:null,notarize:false,hardenedRuntime:false};delete configuration.mac.sign;
  configuration.win={...configuration.win,extraResources:[],signAndEditExecutable:false};
  const config=path.join(destination,'exporter-builder.cjs');await fs.writeFile(config,`module.exports = ${JSON.stringify(configuration,null,2)};\n`);
  execFileSync(process.execPath,[require.resolve('electron-builder/out/cli/cli.js'),'--config',config,'--dir',`--${process.platform==='win32'?'win':process.platform==='darwin'?'mac':'linux'}`,`--${process.arch}`,'--publish','never'],
    {cwd:electronRoot,stdio:'inherit',env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'}});
  const built=path.join(destination,'builder');const source=path.join(destination,'source');await fs.mkdir(source);
  const subdirectories=await fs.readdir(built,{withFileTypes:true});const matches=[];
  for(const entry of subdirectories){if(!entry.isDirectory())continue;const dir=path.join(built,entry.name),marker=path.join(dir,process.platform==='darwin'?'Varin.app':process.platform==='win32'?'Varin.exe':'varin');
    if(await fs.stat(marker).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))matches.push(dir);}
  if(matches.length!==1)throw new Error('Controlled Electron exporter output is ambiguous');
  if(process.platform==='darwin')await fs.cp(path.join(matches[0],'Varin.app'),path.join(source,'Varin.app'),{recursive:true,verbatimSymlinks:true});
  else await fs.cp(matches[0],source,{recursive:true});
  await fs.writeFile(path.join(source,'varin-exporter.json'),JSON.stringify({schema:1,protocol:1,version:app.version,sourceSha,platform:process.platform,architecture:process.arch,
    executable:process.platform==='darwin'?'Varin.app/Contents/MacOS/Varin':process.platform==='win32'?'Varin.exe':'varin',entry:'--varin-export-private-state'},null,2)+'\n');
  return source;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw new Error('Usage: prepare-exporter.mjs NEW-DIRECTORY');
  console.log(await prepareLegacyExporter(process.argv[2]));
}
