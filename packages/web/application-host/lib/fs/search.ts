import pathModule from "node:path";
import type { KernelComputeService } from "../kernel/compute-service.js";
import type { FileSearchItem, FileSearchItems, FileSearchEnumerationInfo, PathModule } from "./types.js";
const EXCLUDED = ["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", "coverage", "tmp", "logs"];
type FileMetadata = { byteLength: string; modifiedTimeNs: string };
const fuzzyMatchScoreNormalized = (normalizedQuery: string, candidate: string): number | null => {
  if (!normalizedQuery) return 0;

  const q = normalizedQuery;
  const c = candidate.toLowerCase();
  if (c.includes(q)) {
    const idx = c.indexOf(q);
    let bonus = 0;
    if (idx === 0) {
      bonus = 20;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        bonus = 15;
      }
    }
    return 100 + bonus - Math.min(idx, 20) - Math.floor(c.length / 5);
  }

  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (!ch || ch === ' ') continue;

    const idx = c.indexOf(ch, lastIndex + 1);
    if (idx === -1) {
      return null;
    }

    const gap = idx - lastIndex - 1;
    if (gap === 0) {
      consecutive += 1;
    } else {
      consecutive = 0;
    }

    score += 10;
    score += Math.max(0, 18 - idx);
    score -= Math.min(gap, 10);

    if (idx === 0) {
      score += 12;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        score += 10;
      }
    }

    score += consecutive > 0 ? 12 : 0;
    lastIndex = idx;
  }

  score += Math.max(0, 24 - Math.floor(c.length / 3));
  return score;
};


/** File membership/ignore/physical traversal are native; fuzzy presentation is
 * deliberately model/product-neutral and does not inspect the filesystem. */
export const createFsSearchRuntime = ({ compute, path = pathModule }: {
  compute: Pick<KernelComputeService, "directory">;
  path?: PathModule;
}) => {
  const searchFilesystemFiles = async (rootPath: string, options: {
    includeHidden?: boolean;
    includeRevisions?: boolean;
    limit?: number;
    query: string;
    respectGitignore?: boolean;
    signal?: AbortSignal;
  }): Promise<FileSearchItems> => {
    const candidates:Array<FileSearchItem & {score:number;metadata?:FileMetadata}>=[];
    let enumerationInfo: FileSearchEnumerationInfo | undefined;
    const query=options.query.trim().toLowerCase();
    const result=await compute.directory(rootPath,{operation:"list",lane:query?"foreground":"background",
      includeTracked:true,respectGitignore:options.respectGitignore!==false,includeHidden:options.includeHidden??false,excludeDirectories:EXCLUDED,
      ...(options.includeRevisions?{includeRevisions:true}:{}),
    },{signal:options.signal,collect:false,onRecords:records=>{
      for(const record of records){
        if (record.kind === 'inventory') {
          const info = record.data as Partial<FileSearchEnumerationInfo>;
          if (info.strategy === 'git-visible' || info.strategy === 'directory') enumerationInfo = {
            strategy: info.strategy, ...(typeof info.gitRoot === 'string' ? { gitRoot: info.gitRoot } : {}),
            ...(typeof info.selectedRootIgnored === 'boolean' ? { selectedRootIgnored: info.selectedRootIgnored } : {}),
          };
          continue;
        }
        if(record.kind!=="entry"||(record.data as {kind?:unknown}).kind!=="file")continue;
        const score=fuzzyMatchScoreNormalized(query,record.path);if(score===null)continue;
        const name=path.basename(record.path),extension=name.includes(".")?name.split(".").pop()?.toLowerCase():undefined;
        const rawMetadata=(record.data as {metadata?:{byteLength?:unknown;modifiedTimeNs?:unknown}}).metadata;
        const metadata=typeof rawMetadata?.byteLength==="string"&&typeof rawMetadata.modifiedTimeNs==="string"
          ?{byteLength:rawMetadata.byteLength,modifiedTimeNs:rawMetadata.modifiedTimeNs}:undefined;
        candidates.push({name,path:path.join(rootPath,record.path),relativePath:record.path,score,
          ...(record.revision?{revision:record.revision}:{}),...(metadata?{metadata}:{}),...(extension?{extension}:{})});
      }
    }});
    options.signal?.throwIfAborted();
    if(result.status==="failed"||result.status==="cancelled")throw new Error(result.message??"Native file enumeration failed");
    if(query)candidates.sort((a,b)=>b.score-a.score||a.relativePath.length-b.relativePath.length||a.relativePath.localeCompare(b.relativePath));
    const limited=options.limit!==undefined&&Number.isSafeInteger(options.limit)&&options.limit>0;
    const selected=(limited?candidates.slice(0,options.limit):candidates).map(({score:_score,...file})=>file) as FileSearchItems;
    const status=result.status==="partial"?"incomplete":limited&&candidates.length>selected.length?"incomplete":"complete";
    Object.defineProperty(selected,"enumerationStatus",{value:status,enumerable:false});
    if (enumerationInfo) Object.defineProperty(selected, 'enumerationInfo', { value: enumerationInfo, enumerable: false });
    return selected;
  };
  const isSearchableFile=async(root:string,resourceId:string,signal?:AbortSignal,options?:{respectGitignore:boolean}):Promise<boolean>=>{
    const normalized=resourceId.replaceAll("\\","/");
    if(path.isAbsolute(resourceId)||normalized.split("/").includes(".."))return false;
    const result=await compute.directory(root,{lane:"background",operation:"list",includeTracked:true,
      respectGitignore: options?.respectGitignore ?? true,
      excludeDirectories:EXCLUDED,includeHidden:false,files:[{path:normalized}],paths:[normalized]}, {signal});
    signal?.throwIfAborted();
    if(result.status==="failed"||result.status==="partial"||result.status==="cancelled")throw new Error(result.message??"Native file eligibility is unavailable");
    return result.records.some(r=>r.kind==="entry"&&(r.data as {kind?:unknown}).kind==="file"&&r.path===normalized);
  };
  return {searchFilesystemFiles,isSearchableFile};
};
