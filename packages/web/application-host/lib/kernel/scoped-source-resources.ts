/** Rebase fixed resource metadata together with a selected subtree. Resources
 * outside it remain immutable instruction/skill capsules, not writable siblings. */
import path from 'node:path';
import { CONTEXT_FILE_NAMES } from '../agent-resources/formats.js';
import type { SourceResourceCapture, SourceResourceCapsule, SourceResourceTarget } from './protocol.generated.js';
import type { WorkingStateRootStore } from '../harness/working-state/types.js';

export async function scopeFixedSourceResources(store: WorkingStateRootStore, source: { branchId: string; revision: number },
  capture: SourceResourceCapture, prefix: string, signal: AbortSignal): Promise<SourceResourceCapture> {
  const within = (file: string) => file === prefix || file.startsWith(`${prefix}/`);
  const strip = (file: string) => file === prefix ? '' : file.slice(prefix.length + 1);
  const capsules = new Map<string, Promise<SourceResourceCapsule>>();
  const known = (file: string) => capture.coverage.kind === 'complete' || capture.coverage.paths.includes(file)
    || capture.coverage.subtrees.some(root => !root || file === root || file.startsWith(`${root}/`));
  const capsule = (directory: string, contextOnly = false): Promise<SourceResourceCapsule> => {
    const key=JSON.stringify([directory,contextOnly]);
    let work=capsules.get(key);
    if (!work) {
      work=(async () => {
        const viewId=`${source.branchId}@${source.revision}`;
        const domainId=`source-dependency:${capture.root}:${directory}`;
        const result: SourceResourceCapsule={domainId,viewId,displayRoot:path.join(capture.root,directory),files:[],directories:[],missing:[],failures:[]};
        const requested=contextOnly ? CONTEXT_FILE_NAMES.map(name => path.posix.join(directory,name))
          : (await store.listPaths(source.branchId,[directory],{revision:source.revision,signal}))?.entries.map(entry=>entry.path) ?? [];
        const states=await store.readStateSlice(source.branchId,requested,{revision:source.revision,signal});
        if (!states) throw new Error('Original fixed resource source is unavailable');
        for (const file of requested) {
          signal.throwIfAborted();
          const relative=directory ? file.slice(directory.length).replace(/^\//,'') : file;
          if (!relative) continue;
          const location={domainId,viewId,path:relative};
          const state=states[file];
          if (!state || state.kind==='missing') {
            if (known(file)) result.missing.push(relative);
            else result.failures.push({...location,status:'unavailable',reason:'This path was not captured by the original fixed source'});
          } else if (state.kind==='regular-file') {
            const bytes=await store.getObject(state.objectHash);
            if (!bytes) throw new Error('Original fixed resource bytes are unavailable');
            try { result.files.push({reference:{...location,canonicalId:path.join(capture.root,file),version:state.objectHash},content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)}); }
            catch {result.failures.push({...location,status:'invalid',reason:'The captured resource is not UTF-8 text'});}
          } else if (state.kind==='directory') {
            const childPrefix=`${file}/`;
            result.directories.push({path:relative,version:viewId,entries:requested.filter(child=>child.startsWith(childPrefix)&&!child.slice(childPrefix.length).includes('/')).map(child=>({
              name:child.slice(childPrefix.length),kind:states[child]?.kind==='regular-file'?'file':states[child]?.kind==='directory'?'directory':states[child]?.kind==='symlink'?'symlink':'unsupported'}))});
          }
        }
        result.directories.push({path:'',version:viewId,entries:requested.filter(file=>!file.slice(directory.length).replace(/^\//,'').includes('/')).flatMap(file=>{
          const name=directory?file.slice(directory.length).replace(/^\//,''):file;
          const state=states[file];return name&&state&&state.kind!=='missing'?[{name,kind:state.kind==='regular-file'?'file' as const:state.kind==='directory'?'directory' as const:'unsupported' as const}]:[];
        })});
        return result;
      })();
      capsules.set(key,work);
    }
    return work;
  };
  const target=async (selected:SourceResourceTarget):Promise<SourceResourceTarget> => selected.kind==='capsule'?selected
    : within(selected.directory)?{kind:'source',directory:strip(selected.directory)}
      : {kind:'capsule',directory:'',capsule:await capsule(selected.directory)};
  const ancestors=[...capture.ancestors];
  let directory='';
  for(const segment of prefix.split('/')) {
    ancestors.push({capsule:await capsule(directory,true),appliesTo:'',includeSkills:false});
    directory=path.posix.join(directory,segment);
  }
  const coverage=capture.coverage.kind==='complete' || capture.coverage.subtrees.some(root=>!root||prefix===root||prefix.startsWith(`${root}/`))
    ? {kind:'complete' as const} : {kind:'selected' as const,paths:capture.coverage.paths.filter(within).map(strip),subtrees:capture.coverage.subtrees.filter(within).map(strip)};
  return {...capture,root:path.join(capture.root,prefix),cwd:'',skillAncestorBoundary:'',coverage,ancestors,
    configuredPaths:await Promise.all(capture.configuredPaths.map(async entry=>({...entry,target:await target(entry.target)}))),
    installedPackages:await Promise.all(capture.installedPackages.map(async entry=>({...entry,target:await target(entry.target)}))),
    sourceLinks:await Promise.all(capture.sourceLinks.filter(link=>within(link.path)).map(async link=>({...link,path:strip(link.path),target:await target(link.target)})))};
}
