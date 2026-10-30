/** Explicit development-only static resources. Never modifies companion-assets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(args.length!==2||args.some(value=>!value.trim()))throw new Error('Provide frozen candidate bundle.json and a fresh generated web staging root');
const [input,webRoot]=args.map(value=>path.resolve(value));
if(!(await fs.stat(webRoot)).isDirectory())throw new Error('Web staging root must be an existing directory');
const bytes=await fs.readFile(input),bundle=JSON.parse(bytes);
if(bundle.candidateOnly!==true||!Array.isArray(bundle.packages)||!bundle.packages.length)throw new Error('Only explicit candidate material belongs to this review directory');
const target=path.join(webRoot,'companion-review-director');
try{await fs.access(target);throw new Error('Refuse existing review generation; use a fresh generated web staging root');}catch(error){if(error.code!=='ENOENT')throw error;}
const names=new Set(['bundle.json',...bundle.packages.flatMap(p=>p.pages.map(page=>page.file)),bundle.worldStool.file]);
const sha=b=>createHash('sha256').update(b).digest('hex'),files={},contents=new Map();
// Read and validate every input before creating any generation or completion marker.
for(const name of names){
 if(typeof name!=='string'||path.basename(name)!==name||name==='review-assets.json')throw new Error('Review asset name must be a basename');
 const data=await fs.readFile(path.join(path.dirname(input),name));contents.set(name,data);files[name]=sha(data);
}
if(files['bundle.json']!==sha(bytes))throw new Error('Candidate changed during input validation');
const staging=await fs.mkdtemp(path.join(webRoot,'.director-review-staging-'));
try{
 for(const [name,data] of contents)await fs.writeFile(path.join(staging,name),data);
 await fs.writeFile(path.join(staging,'review-assets.json'),JSON.stringify({reviewOnly:true,candidateBundleSHA256:sha(bytes),files,notProductionSelected:true},null,2)+'\n');
 await fs.rename(staging,target);
}catch(error){await fs.rm(staging,{recursive:true,force:true});throw error;}
console.log(JSON.stringify({target,candidateBundleSHA256:sha(bytes),files:names.size}));
