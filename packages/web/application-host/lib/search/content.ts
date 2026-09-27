import path from "node:path";
import type { KernelComputeService } from "../kernel/compute-service.js";
import type { KernelComputeRecord } from "../kernel/protocol.generated.js";

export const CONTENT_SEARCH_EXCLUDED_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", "coverage"];
export interface WorkspaceSearchHit {
  after?: string[];
  before?: string[];
  column: number;
  line: number;
  preview: string;
  revision?: string;
  resource: { resourceId: string; workspaceId: string };
}
export type WorkspaceContentSearchResult =
  | { generation: number | undefined; hits: WorkspaceSearchHit[]; status: "ready"; incomplete?: true; scannedFiles?: number }
  | { generation: number | undefined; status: "empty" | "cancelled"; scannedFiles?: number }
  | { generation: number | undefined; message: string; status: "failure"; scannedFiles?: number };
export interface WorkspaceContentSearchRequest {
  glob?: string[];
  includeHidden?: boolean;
  maxResults?: number | undefined;
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  excludeResourceIds?: string[];
  paths?: string[];
  query?: string;
  workspaceId?: string;
  before?: number;
  after?: number;
}
export interface WorkspaceContentSearchOptions {
  /** Host-captured immutable inputs; never accepted from an HTTP body. */
  overlays?: readonly import("../kernel/compute-service.js").KernelComputeText[];
  collect?: boolean;
  generation?: number;
  onBatch?: (hits: WorkspaceSearchHit[]) => boolean | void;
  onDrain?: () => Promise<void>;
  signal?: AbortSignal;
}
export interface WorkspaceContentSearchDependencies {
  documents: { inspectWorkspace(workspaceId: string): Promise<{ root: string; kind?: 'directory' | 'file' }> };
  compute: Pick<KernelComputeService, "directory">;
  pathModule?: typeof path;
}
export function decodeNativeSearchHit(record: KernelComputeRecord, workspaceId: string): WorkspaceSearchHit | null {
  if (record.kind !== "hit") return null;
  const d = record.data as Record<string, unknown>;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v=>typeof v==="string");
  if (!d || typeof d !== "object" || !Number.isSafeInteger(d.line) || Number(d.line) < 1
    || !Number.isSafeInteger(d.column) || Number(d.column) < 1 || typeof d.preview !== "string"
    || !strings(d.before) || !strings(d.after) || !record.revision
    || record.path.startsWith("/") || record.path.split("/").includes("..")) throw new Error("Invalid native search result");
  return {resource:{workspaceId,resourceId:record.path},line:Number(d.line),column:Number(d.column),
    preview:d.preview,before:d.before,after:d.after,revision:record.revision};
}
/** Search execution is entirely native. This adapter only admits the workspace,
 * validates records, and delivers HTTP/NDJSON backpressure and presentation. */
export function createWorkspaceContentSearch({ documents, compute, pathModule = path }: WorkspaceContentSearchDependencies) {
  return {
    async searchContent(request: WorkspaceContentSearchRequest, options: WorkspaceContentSearchOptions = {}): Promise<WorkspaceContentSearchResult> {
      const generation = options.generation;
      if (options.signal?.aborted) return {status:"cancelled",generation};
      const workspaceId=request.workspaceId;
      if(!workspaceId)return {status:"failure",generation,message:"workspaceId is required"};
      if(typeof request.query!=="string"||!request.query.trim())return {status:"empty",generation};
      try {
        const {root,kind}=await documents.inspectWorkspace(workspaceId);
        const fileRoot=kind==='file';
        const computeRoot=fileRoot?pathModule.dirname(root):root;
        const fileName=fileRoot?pathModule.basename(root):null;
        const relative=(input:string):string=>{
          const value=pathModule.isAbsolute(input)?pathModule.relative(root,input):input;
          const result=value.replaceAll("\\","/");
          if(pathModule.isAbsolute(value)||result.split("/").includes(".."))throw new Error("Search path is outside the workspace");
          const resourceId=result.split("/").filter(s=>s&&s!==".").join("/");
          if(fileRoot&&resourceId)throw new Error("Search path is outside the file resource root");
          return resourceId;
        };
        if(request.paths!==undefined&&(!Array.isArray(request.paths)||!request.paths.length||!request.paths.every(p=>typeof p==="string"&&p.trim())))throw new Error("Search paths must be a non-empty string array");
        const hits:WorkspaceSearchHit[]=[];let count=0;
        const excludes=(request.excludeResourceIds??[]).map(relative);
        const requestedPaths=request.paths?.map(relative);
        const nativeOverlays=options.overlays?.map((overlay)=>{
          const resourceId=relative(overlay.path);
          return {...overlay,path:fileRoot?fileName!:resourceId};
        });
        const result=await compute.directory(computeRoot,{operation:"search",lane:"foreground",query:request.query.trim(),
          excludeDirectories:CONTENT_SEARCH_EXCLUDED_DIRS,excludePaths:fileRoot?excludes.map(()=>fileName!):excludes,
          ...(fileRoot?{paths:[fileName!]}:requestedPaths?{paths:requestedPaths}:{}),...(request.glob?{globs:request.glob}:{}),
          ...(request.includeHidden===undefined?{}:{includeHidden:request.includeHidden}),
          ...(request.ignoreCase===undefined?{}:{ignoreCase:request.ignoreCase}),
          ...(request.fixedStrings===undefined?{}:{fixedStrings:request.fixedStrings}),
          ...(request.maxResults===undefined?{}:{maxResults:request.maxResults}),
          ...(request.before===undefined?{}:{before:request.before}),...(request.after===undefined?{}:{after:request.after}),
        },{signal:options.signal,collect:false,onRecords:async records=>{
          const batch=records.map(record=>{
            const hit=decodeNativeSearchHit(record,workspaceId);
            if(!hit)return null;
            if(fileRoot){
              if(hit.resource.resourceId!==fileName)throw new Error("Search escaped the file resource root");
              return {...hit,resource:{workspaceId,resourceId:""}};
            }
            return hit;
          }).filter((hit):hit is WorkspaceSearchHit=>hit!==null);
          if(!batch.length)return;
          count+=batch.length;if(options.collect!==false)hits.push(...batch);
          if(options.onBatch?.(batch)===false&&options.onDrain)await options.onDrain();
        }},nativeOverlays);
        if(result.status==="cancelled")return {status:"cancelled",generation};
        if(result.status==="failed"||(result.status==="partial"&&count===0))return {status:"failure",generation,message:result.message??"Content search coverage is incomplete"};
        if(count===0)return {status:"empty",generation,scannedFiles:result.scannedFiles};
        return {status:"ready",generation,hits,scannedFiles:result.scannedFiles,...(result.status==="partial"?{incomplete:true as const}:{})};
      }catch(error){return options.signal?.aborted?{status:"cancelled",generation}:{status:"failure",generation,message:error instanceof Error?error.message:String(error)};}
    },
  };
}
