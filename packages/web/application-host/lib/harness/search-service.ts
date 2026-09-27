import path from "node:path";
import type { SearchContentParams, SearchContentResult, SearchContentFile, SearchContentHit } from "@varin/protocol";
import type { AgentInputContext, HarnessActorContext } from "@varin/protocol";
import type { WorkspaceContentSearchRequest, WorkspaceContentSearchOptions, WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import { compileGlobFilter } from "./glob-matcher.js";
import { uniqueFileCoverage } from "./explore-distinctiveness.js";

import type { WorkingBranchQuerySnapshot, WorkingBranchPinOptions } from "./working-state/working-branch-query.js";
import type { KernelComputeText } from "../kernel/compute-service.js";

export interface HarnessSearchDeps {
  search(request: WorkspaceContentSearchRequest & { query: string; workspaceId: string }, options: WorkspaceContentSearchOptions): Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  /**
   * HR2: resolve an unbound session's default search scope — register (or find)
   * the session authority root as a directory resource root. The trusted-root
   * gate applies; returns null when the directory is untrusted or unavailable.
   */
  resolveScopeRoot?: (canonicalPath: string) => Promise<{ workspaceId: string; root: string } | null>;
  readFile?: ExploreFileReader;
  /** Dirty paths this turn's fixed source still owns (D-088). */
  draftPaths?: (sessionId: string, context: AgentInputContext) => readonly string[];
  pinWorkingBranchQuery?: (sessionId: string, options?: WorkingBranchPinOptions) => Promise<WorkingBranchQuerySnapshot | null>;
}

export interface HarnessSearchContext {
  workspaceId: string | null;
  workspaceScope?: readonly string[];
  signal: AbortSignal;
  actor?: HarnessActorContext;
  /**
   * Router-authorized scope entries for this query. Each entry carries the
   * resource root it resolved against (`workspaceId`, which may be an external
   * file/directory root unrelated to the actor's workspace classification) and
   * the root-relative resource id. Multiple roots in one query are searched
   * independently and merged; entries take precedence over queryScope defaults.
   */
  authorizedPaths?: ReadonlyArray<{ workspaceId: string; resourceId: string }>;
  inputContext?: AgentInputContext;
  /**
   * Explore-only working hit budget. Absent for `search.content` / grep, which
   * keep `params.limit` as the displayed-hit cap and `maxResults = 3 * limit`.
   */
  candidateBudget?: number;
  /** Explore-only per-file hit cap applied before the working budget. */
  hitsPerFile?: number;
  /** An exact query handle, not expanded workspace bytes. */
  pinnedBranchQuery?: WorkingBranchQuerySnapshot | null;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

function fileScore(input: {
  hits: number;
  path: string;
  root: string;
  gitModified: boolean;
  ageDays: number;
}): number {
  const { hits, path, gitModified, ageDays } = input;
  const recency = gitModified ? 1 : Math.exp(-ageDays / 30);
  const pathPref = /test|spec|__tests__|fixtures/.test(path) ? 0.6 : 1.0;
  const depth = path.split("/").length - 1;
  const depthPenalty = 0.05 * Math.max(0, depth - 3);
  return 0.5 * Math.log1p(hits) + 0.3 * recency + 0.2 * pathPref - depthPenalty;
}

function toSearchFile(path: string, fileHits: WorkspaceSearchHit[]): SearchContentFile {
  return {
    path,
    hits: fileHits.map((hit): SearchContentHit => ({
      line: hit.line,
      text: hit.preview,
      before: hit.before ?? [],
      after: hit.after ?? [],
    })),
  };
}

function takeDepthFirst(files: SearchContentFile[], limit: number): SearchContentFile[] {
  let remaining = limit;
  const limited: SearchContentFile[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, file.hits.length);
    limited.push({ path: file.path, hits: file.hits.slice(0, take) });
    remaining -= take;
  }
  return limited;
}

/** Round-robin one hit per file, then deepen. Drops files only when file count exceeds the budget. */
function takeBreadthFirst(files: SearchContentFile[], limit: number): { files: SearchContentFile[]; filesDropped: number } {
  const kept = files.length > limit ? files.slice(0, limit) : files;
  const filesDropped = files.length - kept.length;
  const cursors = kept.map((file) => ({ path: file.path, source: file.hits, hits: [] as SearchContentHit[] }));
  let remaining = limit;
  let depth = 0;
  while (remaining > 0) {
    let progressed = false;
    for (const cursor of cursors) {
      if (remaining <= 0) break;
      if (depth < cursor.source.length) {
        cursor.hits.push(cursor.source[depth]!);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    depth += 1;
  }
  return {
    files: cursors.filter((cursor) => cursor.hits.length > 0).map(({ path, hits }) => ({ path, hits })),
    filesDropped,
  };
}

function groupAndSort(
  hits: WorkspaceSearchHit[],
  root: string,
  limit: number,
  options?: { hitsPerFile?: number; useFileScore?: boolean; breadthFirst?: boolean },
): { files: SearchContentFile[]; totalHits: number; totalFiles: number; perFileCapped: boolean; filesDropped: number } {
  const byFile = new Map<string, WorkspaceSearchHit[]>();
  for (const hit of hits) {
    const path = hit.resource.resourceId;
    const fileHits = byFile.get(path) ?? [];
    fileHits.push(hit);
    byFile.set(path, fileHits);
  }

  const hitsPerFile = options?.hitsPerFile;
  let perFileCapped = false;
  const prepared = Array.from(byFile.entries()).map(([path, fileHits]) => {
    const ordered = [...fileHits].sort((a, b) => a.line - b.line);
    if (hitsPerFile !== undefined && ordered.length > hitsPerFile) {
      perFileCapped = true;
      return { path, hits: ordered.slice(0, hitsPerFile) };
    }
    return { path, hits: ordered };
  });

  const useFileScore = options?.useFileScore !== false;
  const scored = prepared.map((file) => ({
    ...file,
    score: useFileScore
      ? fileScore({
        hits: file.hits.length,
        path: file.path,
        root,
        gitModified: false, // TODO: integrate with git status
        ageDays: 0, // TODO: integrate with file mtime
      })
      : 0,
  }));
  scored.sort((a, b) => {
    if (useFileScore && b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const files: SearchContentFile[] = scored.map(({ path, hits: fileHits }) => toSearchFile(path, fileHits));
  const totalHits = hits.length;
  const totalFiles = byFile.size;
  const displayedHits = files.reduce((sum, file) => sum + file.hits.length, 0);

  if (displayedHits <= limit) {
    return { files, totalHits, totalFiles, perFileCapped, filesDropped: 0 };
  }
  if (options?.breadthFirst === true) {
    const allocated = takeBreadthFirst(files, limit);
    return { files: allocated.files, totalHits, totalFiles, perFileCapped, filesDropped: allocated.filesDropped };
  }
  return { files: takeDepthFirst(files, limit), totalHits, totalFiles, perFileCapped, filesDropped: 0 };
}

const unavailableResult = (): SearchContentResult => ({
  status: "unavailable",
  files: [],
  totalHits: 0,
  totalFiles: 0,
  partial: false,
});

const emptyResult = (): SearchContentResult => ({
  status: "empty",
  files: [],
  totalHits: 0,
  totalFiles: 0,
  partial: false,
});


export type HarnessSearchService = ReturnType<typeof createHarnessSearchService>;
export function createHarnessSearchService(deps: HarnessSearchDeps) {
  return {
    async search(params: SearchContentParams, ctx: HarnessSearchContext): Promise<SearchContentResult> {
      if(ctx.inputContext?.source==="surface"&&ctx.inputContext.workspaceId!==ctx.workspaceId)return unavailableResult();
      if(typeof params.pattern!=="string"||!params.pattern.trim())return emptyResult();
      if(ctx.signal.aborted)return {...emptyResult(),partial:true};
      const within=(file:string,prefix:string)=>{
        if(process.platform==="win32"){file=file.toLowerCase();prefix=prefix.toLowerCase();}
        return !prefix||file===prefix||file.startsWith(prefix+"/");
      };
      const normalizePrefix=(root:string,value:string):string|null=>{
        const absolute=path.resolve(root,value);const relative=path.relative(root,absolute).replaceAll("\\","/");
        return path.isAbsolute(relative)||relative.split("/").includes("..")?null:relative;
      };
      const toPrefixes=(root:string,values:readonly string[]|undefined)=>{
        if(values===undefined)return [""];const result=values.map((value)=>normalizePrefix(root,value));
        return result.some(r=>r===null)?[]:result as string[];
      };
      // HR2: a query is a set of independently resolved resource units, not one
      // workspace root. Authorized path entries already carry the root each one
      // resolved against at admission — group them per root so a file root,
      // several directory roots, and the actor's own workspace can combine.
      // Internal callers (explore) pass workspace-relative `path`/`paths`
      // without router authorization; their single unit is the actor workspace.
      // With no explicit scope the actor's query scope applies, then the
      // operation dir, and for unbound sessions the authority root registers
      // itself as this query's directory scope.
      interface SearchUnit{rootWorkspaceId:string;root:string;prefixes:string[];actorBound:boolean;}
      const units:SearchUnit[]=[];
      let missingScope=false;
      if(ctx.authorizedPaths?.length){
        const byRoot=new Map<string,Set<string>>();
        for(const entry of ctx.authorizedPaths){
          const bucket=byRoot.get(entry.workspaceId)??new Set<string>();
          bucket.add(entry.resourceId);byRoot.set(entry.workspaceId,bucket);
        }
        for(const [rootWorkspaceId,resourceIds] of byRoot){
          const root=await deps.resolveWorkspaceRoot(rootWorkspaceId).catch(()=>null);
          if(!root){missingScope=true;continue;}
          units.push({rootWorkspaceId,root,prefixes:[...resourceIds],actorBound:rootWorkspaceId===ctx.workspaceId});
        }
        if(!units.length)return unavailableResult();
      }else if(ctx.workspaceId){
        const root=await deps.resolveWorkspaceRoot(ctx.workspaceId);if(!root)return unavailableResult();
        const explicit=params.paths!==undefined?[...params.paths]:params.path!==undefined?[params.path]:undefined;
        const defaultScope=ctx.actor?.queryScope?.length?[...ctx.actor.queryScope]:ctx.actor?.operationDir?[ctx.actor.operationDir]:undefined;
        const allowed=toPrefixes(root,ctx.workspaceScope),requested=toPrefixes(root,explicit??defaultScope);
        const prefixes=[...new Set(allowed.flatMap(a=>requested.flatMap(r=>within(r,a)?[r]:within(a,r)?[a]:[])))];
        if(!prefixes.length)return emptyResult();
        units.push({rootWorkspaceId:ctx.workspaceId,root,prefixes,actorBound:true});
      }else if(ctx.actor?.authorityRoot&&deps.resolveScopeRoot){
        const scope=await deps.resolveScopeRoot(ctx.actor.authorityRoot).catch(()=>null);
        const root=scope?await deps.resolveWorkspaceRoot(scope.workspaceId).catch(()=>null):null;
        if(!scope||!root)return unavailableResult();
        units.push({rootWorkspaceId:scope.workspaceId,root,prefixes:[""],actorBound:false});
      }else return unavailableResult();
      const glob=compileGlobFilter(params.glob);if(!glob)return unavailableResult();
      const limit=params.limit??DEFAULT_LIMIT;
      const candidateMode=ctx.candidateBudget!==undefined;
      const candidateBudget=Math.max(1,ctx.candidateBudget??limit);
      const backendLimit=candidateMode?undefined:limit*3;
      const before=Math.max(0,params.before??params.context??0),after=Math.max(0,params.after??params.context??0);
      const timeout=new AbortController();const timer=setTimeout(()=>timeout.abort(new DOMException("Search timed out","AbortError")),DEFAULT_TIMEOUT_MS);
      const signal=AbortSignal.any([ctx.signal,timeout.signal]);
      let ownedPin:WorkingBranchQuerySnapshot|null=null;
      const runUnit=async(unit:SearchUnit)=>{
        const inView=(file:string)=>unit.prefixes.some(prefix=>within(file,prefix))&&glob.matches(file);
        // Working-branch pins and draft overlays belong to the actor's own
        // workspace surface only; external roots read committed state.
        let unitPin:WorkingBranchQuerySnapshot|null=null;
        const pinned=unit.actorBound
          ? ctx.pinnedBranchQuery??(ctx.actor&&deps.pinWorkingBranchQuery
            ? unitPin=await deps.pinWorkingBranchQuery(ctx.actor.sessionId,{roots:unit.prefixes,signal}) : null)
          : null;
        const overlays:KernelComputeText[]=[];
        const context=ctx.inputContext??{source:"disk" as const};
        if(unit.actorBound&&!pinned&&context.source==="surface"&&ctx.actor){
          const paths=deps.draftPaths?.(ctx.actor.sessionId,context)??context.dirtyPaths;
          for(const raw of paths){signal.throwIfAborted();const file=normalizePrefix(unit.root,raw);if(file===null||!inView(file))continue;
            if(!deps.readFile)throw new Error("unavailable");
            const snapshot=await deps.readFile(ctx.actor,file,signal,context);
            if(snapshot.status!=="ready"||snapshot.source!=="surface-draft")throw new Error("unavailable");
            overlays.push({path:file,revision:snapshot.revision,text:snapshot.content});
          }
        }
        const request={query:params.pattern,workspaceId:unit.rootWorkspaceId,
          ...(unit.prefixes.length===1&&unit.prefixes[0]===""?{}:{paths:unit.prefixes}),before,after,
          ...(backendLimit===undefined?{}:{maxResults:backendLimit}),...(glob.rgPatterns.length?{glob:glob.rgPatterns}:{}),
          ...(params.ignoreCase===undefined?{}:{ignoreCase:params.ignoreCase}),...(params.fixedStrings===undefined?{}:{fixedStrings:params.fixedStrings})};
        const result=pinned?await pinned.search(request,{signal}):await deps.search(request,{signal,...(overlays.length?{overlays}:{})});
        return {unit,result,inView,pin:unitPin};
      };
      try {
        const settled=await Promise.all(units.map((unit)=>runUnit(unit).then((ok)=>ok,()=>null)));
        // Result paths must reopen: with a single unit on the actor's own
        // workspace they stay root-relative resource ids; any external or
        // multi-root query emits absolute paths, which resource-root
        // addressing resolves back to the same authorized roots.
        const multiRoot=units.length>1||units[0]!.rootWorkspaceId!==ctx.workspaceId;
        const hits:WorkspaceSearchHit[]=[];const seen=new Set<string>();
        let scanned=0,scannedKnown=true,backendCapped=false,backendIncomplete=false;
        let failedUnits=missingScope,succeededUnits=0,cancelledUnits=0;
        for(const entry of settled){
          if(!entry){failedUnits=true;continue;}
          const {unit,result,inView}=entry;
          if(result.status==="cancelled"){failedUnits=true;cancelledUnits+=1;continue;}
          if(result.status==="failure"){failedUnits=true;continue;}
          succeededUnits+=1;
          if(entry.pin)ownedPin=entry.pin;
          if(result.scannedFiles===undefined)scannedKnown=false;else scanned+=result.scannedFiles;
          if(result.status==="ready"){
            if(result.incomplete===true)backendIncomplete=true;
            if(backendLimit!==undefined&&result.hits.length>=backendLimit)backendCapped=true;
            for(const hit of result.hits){
              if(!inView(hit.resource.resourceId))continue;
              const file=multiRoot?path.join(unit.root,hit.resource.resourceId):hit.resource.resourceId;
              const key=`${file}\n${hit.line}\n${hit.column}\n${hit.preview}`;
              if(multiRoot&&seen.has(key))continue;
              seen.add(key);
              hits.push({...hit,resource:{workspaceId:unit.rootWorkspaceId,resourceId:file}});
            }
          }
        }
        // Every unit failed or nothing authorized resolved — nothing was
        // actually searched, so do not report a clean "empty".
        if(signal.aborted)return {...emptyResult(),partial:true};
        if(succeededUnits===0){
          if(cancelledUnits>0)return {...emptyResult(),partial:true};
          return unavailableResult();
        }
        const grouped=groupAndSort(hits,multiRoot?"":units[0]!.root,candidateMode?candidateBudget:limit,{
          ...(ctx.hitsPerFile===undefined?{}:{hitsPerFile:ctx.hitsPerFile}),useFileScore:!candidateMode,breadthFirst:candidateMode,
        });
        const shown=grouped.files.reduce((sum,file)=>sum+file.hits.length,0);
        const partial=failedUnits||backendCapped||backendIncomplete||shown<grouped.totalHits||grouped.perFileCapped||grouped.filesDropped>0||signal.aborted;
        return {status:grouped.totalHits?"ready":"empty",files:grouped.files,totalHits:grouped.totalHits,totalFiles:grouped.totalFiles,
          ...(scannedKnown?{searchedFiles:scanned}:{}),partial,
          ...(candidateMode?{filesDropped:grouped.filesDropped,fileCoverage:uniqueFileCoverage({filesDropped:grouped.filesDropped,backendIncomplete:backendIncomplete||failedUnits,backendCapped})}:{})};
      }catch{return ctx.signal.aborted||timeout.signal.aborted?{...emptyResult(),partial:true}:unavailableResult();}
      finally{clearTimeout(timer);await ownedPin?.release();}
    },
  };
}
