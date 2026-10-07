import type { ExploreFileSnapshot } from "../explore-file-reader.js";
import { decodeNativeSearchHit, type WorkspaceContentSearchRequest, type WorkspaceContentSearchOptions, type WorkspaceContentSearchResult } from "../../search/content.js";
import type { WorkingStatePin, WorkingStateRootStore } from "./types.js";
import type { WorkingStateFileQuery, WorkingStateQueryOptions, WorkingStateQueryResult } from "./query-contract.js";

export interface WorkingBranchPinOptions { roots?: readonly string[]; signal?: AbortSignal; deadlineAt?: number }
export interface WorkingBranchQueryFile { path:string; revision:string }
export interface WorkingBranchQuerySnapshot {
  sessionId:string; workspaceId:string; branchId:string; writeRevision:number; revision:number; root:string; pinId:string;
  compute(request:WorkingStateFileQuery, options?:WorkingStateQueryOptions):Promise<WorkingStateQueryResult>;
  listFiles(signal?:AbortSignal):Promise<WorkingBranchQueryFile[]>;
  search(request:WorkspaceContentSearchRequest, options?:WorkspaceContentSearchOptions):Promise<WorkspaceContentSearchResult>;
  readFile(resourceId:string):Promise<ExploreFileSnapshot>;
  release():Promise<void>;
}
const normalize=(path:string):string=>{
  const raw=path.replaceAll("\\","/");if(raw.startsWith("/")||raw.includes(":")||raw.includes("\0")||raw.split("/").includes(".."))throw new Error("Query path is outside the fixed view");
  return raw.split("/").filter(p=>p&&p!==".").join("/");
};
const within=(file:string,root:string)=>!root||file===root||file.startsWith(root+"/");
const intersect=(requested:readonly string[],allowed:readonly string[]):string[]=>{
  const result=new Set<string>();for(const raw of requested){const path=normalize(raw);for(const root of allowed){if(within(path,root))result.add(path);else if(within(root,path))result.add(root);}}
  return [...result];
};
const recordOf=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid fixed-view record");return value as Record<string,unknown>;
};
/** The query owns just its pin and active requests, never a mirrored corpus. */
export function createWorkingBranchQuery(store:WorkingStateRootStore,pin:WorkingStatePin,sessionId:string,options:WorkingBranchPinOptions={}):WorkingBranchQuerySnapshot {
  const roots=(options.roots?.length?options.roots:[""]).map(normalize);
  const lifecycle=new AbortController();const active=new Set<Promise<unknown>>();let releasePromise:Promise<void>|undefined;
  const check=()=>{lifecycle.signal.throwIfAborted();options.signal?.throwIfAborted();if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw new DOMException("Explore query deadline exceeded","AbortError");};
  const run=(request:WorkingStateFileQuery,opts:WorkingStateQueryOptions={}):Promise<WorkingStateQueryResult>=>{
    check();const paths=intersect(request.paths??roots,roots);
    const files=request.files?.map(file=>{const path=normalize(file.path);if(!roots.some(root=>within(path,root)))throw new Error("Query file is outside the fixed view");return {...file,path};});
    const excludePaths=request.excludePaths?.map(normalize);
    const signal=AbortSignal.any([lifecycle.signal,...(options.signal?[options.signal]:[]),...(opts.signal?[opts.signal]:[])]);
    const work=store.queryFiles(pin,{...request,paths,...(files?{files}:{}),...(excludePaths?{excludePaths}:{}),includeHidden:request.includeHidden??true},{...opts,signal});active.add(work);
    void work.then(()=>active.delete(work),()=>active.delete(work));return work;
  };
  const release=():Promise<void>=>{
    if(!releasePromise){lifecycle.abort(new Error("Working-branch query was released"));releasePromise=(async()=>{await Promise.allSettled([...active]);await pin.release();options.signal?.removeEventListener("abort",onAbort);})().catch(error=>{releasePromise=undefined;throw error;});}
    return releasePromise;
  };
  const onAbort=()=>{void release().catch(()=>undefined);};options.signal?.addEventListener("abort",onAbort,{once:true});
  return {
    sessionId,workspaceId:pin.workspaceId,branchId:pin.branchId,root:pin.root,writeRevision:pin.writeRevision,revision:pin.revision,pinId:pin.pinId,
    release,compute:run,
    async listFiles(signal):Promise<WorkingBranchQueryFile[]>{
      const files:WorkingBranchQueryFile[]=[];
      const result=await run({operation:"list",lane:"foreground",paths:roots},{signal,collect:false,onRecords:records=>{
        for(const r of records){if(r.kind!=="entry")continue;const d=recordOf(r.data);if(d.kind==="file")files.push({path:r.path,revision:r.revision});}
      }});
      if(result.status==="failed"||result.status==="partial"||result.status==="cancelled")throw new Error(result.message??"Fixed-view file inventory did not complete");
      files.sort((left,right)=>left.path.localeCompare(right.path));return files;
    },
    async readFile(resourceId):Promise<ExploreFileSnapshot>{
      const path=normalize(resourceId);if(!roots.some(root=>within(path,root)))return {status:"forbidden",message:"Path is outside this query's fixed scope"};
      let revision="";let text="";let offset=0;let complete=false;
      const result=await run({operation:"read",lane:"foreground",paths:[path],files:[{path}]},{collect:false,onRecords:records=>{
        for(const r of records){if(r.kind!=="text"||r.path!==path)continue;const d=recordOf(r.data);
          if(d.offset===0){revision=r.revision;text="";offset=0;complete=false;}
          if(r.revision!==revision||d.offset!==offset||typeof d.text!=="string")throw new Error("Fixed-view text continuation changed");
          text+=d.text;offset+=Buffer.byteLength(d.text);if(d.final===true)complete=true;
        }
      }});
      if(result.status==="failed"||result.status==="partial"||result.status==="cancelled")return {status:"unavailable",message:result.message??"Fixed-view read did not complete"};
      return complete?{status:"ready",content:text,revision,source:"working-branch"}:{status:"unavailable",message:path+" is not a readable text file in this fixed working branch"};
    },
    async search(request,opts={}):Promise<WorkspaceContentSearchResult>{
      const generation=opts.generation;
      if(opts.signal?.aborted)return {status:"cancelled",generation};
      const hits:import("../../search/content.js").WorkspaceSearchHit[]=[];let count=0;
      const result=await run({lane:"foreground",operation:"search",query:request.query??"",paths:request.paths??roots,
        includeHidden:request.includeHidden??false,
        ...(request.respectGitignore===undefined?{}:{respectGitignore:request.respectGitignore}),
        ...(request.glob?{globs:request.glob}:{}),...(request.fixedStrings===undefined?{}:{fixedStrings:request.fixedStrings}),
        ...(request.ignoreCase===undefined?{}:{ignoreCase:request.ignoreCase}),...(request.maxResults===undefined?{}:{maxResults:request.maxResults}),
        ...(request.before===undefined?{}:{before:request.before}),...(request.after===undefined?{}:{after:request.after}),
      },{signal:opts.signal,collect:false,onRecords:async records=>{
        const batch=records.map(r=>decodeNativeSearchHit(r,pin.workspaceId)).filter((r):r is NonNullable<typeof r>=>r!==null);
        count+=batch.length;if(opts.collect!==false)hits.push(...batch);
        if(batch.length&&opts.onBatch?.(batch)===false&&opts.onDrain)await opts.onDrain();
      }});
      if(result.status==="failed"||result.status==="partial"&&!count)return {status:"failure",generation,message:result.message??"Fixed-view search incomplete"};
      if(result.status==="cancelled")return {status:"cancelled",generation};
      return count?{status:"ready",generation,hits,scannedFiles:result.scannedFiles,...(result.status==="partial"?{incomplete:true as const}:{})}:{status:"empty",generation,scannedFiles:result.scannedFiles};
    },
  };
}
