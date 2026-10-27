import type {
  RecoveryState,
  ThreeWayMergePlan,
  ThreeWayPathPlan,
} from "./types.js";
import type { ThreadDiffStats } from "@varin/protocol";
import { diffArrays } from "diff";
import { sameState } from "../../recovery/journal-files.js";
import { mergeFileAttributes } from './file-attributes-merge.js';

export interface TextMergeResult {
  clean: boolean;
  text: string;
}

export const isBinaryBuffer = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
};

const splitLineTokens = (text: string): string[] => (
  text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter((token) => token.length > 0) ?? []
);

/** Adapt the existing Myers implementation without allocating a line-pair matrix. */
export const lcsMatches = (a: string[], b: string[]): Array<[number, number]> => {
  const matches: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const change of diffArrays(a, b)) {
    if (change.added) newIndex += change.count;
    else if (change.removed) oldIndex += change.count;
    else for (let index = 0; index < change.count; index += 1) matches.push([oldIndex++, newIndex++]);
  }
  return matches;
};

interface ChunkMapping {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

const appendLines = (output: string[], lines: string[]): void => {
  for (const line of lines) output.push(line);
};

const computeChunks = (baseLines: string[], targetLines: string[]): ChunkMapping[] => {
  const matches = lcsMatches(baseLines, targetLines);
  const chunks: ChunkMapping[] = [];

  let lastBase = 0;
  let lastTarget = 0;

  for (const [bIdx, tIdx] of matches) {
    if (bIdx > lastBase || tIdx > lastTarget) {
      chunks.push({
        baseStart: lastBase,
        baseEnd: bIdx,
        lines: targetLines.slice(lastTarget, tIdx),
      });
    }
    lastBase = bIdx + 1;
    lastTarget = tIdx + 1;
  }

  if (lastBase < baseLines.length || lastTarget < targetLines.length) {
    chunks.push({
      baseStart: lastBase,
      baseEnd: baseLines.length,
      lines: targetLines.slice(lastTarget),
    });
  }

  return chunks;
};

/**
 * 3-way line-based text merge.
 * Returns merged text and clean flag. If conflicting, injects conflict markers.
 */
export const mergeText3Way = (
  baseText: string,
  parentText: string,
  childText: string,
  options: { parentLabel?: string; childLabel?: string } = {},
): TextMergeResult => {
  if (parentText === childText) return { clean: true, text: parentText };
  if (parentText === baseText) return { clean: true, text: childText };
  if (childText === baseText) return { clean: true, text: parentText };

  const baseLines = splitLineTokens(baseText);
  const parentLines = splitLineTokens(parentText);
  const childLines = splitLineTokens(childText);

  const parentChunks = computeChunks(baseLines, parentLines);
  const childChunks = computeChunks(baseLines, childLines);

  const pLabel = options.parentLabel ?? "parent";
  const cLabel = options.childLabel ?? "child";
  const markerEol = parentText.match(/\r\n|\n|\r/u)?.[0]
    ?? childText.match(/\r\n|\n|\r/u)?.[0]
    ?? baseText.match(/\r\n|\n|\r/u)?.[0]
    ?? "\n";

  let clean = true;
  const resultLines: string[] = [];
  let cursor = 0;
  let pChunkIdx = 0;
  let cChunkIdx = 0;

  const overlaps = (left: ChunkMapping, right: ChunkMapping): boolean => {
    const leftInsertion = left.baseStart === left.baseEnd;
    const rightInsertion = right.baseStart === right.baseEnd;
    if (leftInsertion && rightInsertion) return left.baseStart === right.baseStart;
    if (leftInsertion) return left.baseStart >= right.baseStart && left.baseStart < right.baseEnd;
    if (rightInsertion) return right.baseStart >= left.baseStart && right.baseStart < left.baseEnd;
    return Math.max(left.baseStart, right.baseStart) < Math.min(left.baseEnd, right.baseEnd);
  };

  const render = (start: number, end: number, chunks: ChunkMapping[]): string[] => {
    const output: string[] = [];
    let at = start;
    for (const chunk of chunks) {
      appendLines(output, baseLines.slice(at, chunk.baseStart));
      appendLines(output, chunk.lines);
      at = chunk.baseEnd;
    }
    appendLines(output, baseLines.slice(at, end));
    return output;
  };

  while (pChunkIdx < parentChunks.length || cChunkIdx < childChunks.length) {
    const parent = parentChunks[pChunkIdx];
    const child = childChunks[cChunkIdx];
    if (parent && child && overlaps(parent, child)) {
      const parentGroup: ChunkMapping[] = [parent];
      const childGroup: ChunkMapping[] = [child];
      pChunkIdx += 1;
      cChunkIdx += 1;
      let expanded = true;
      while (expanded) {
        expanded = false;
        const nextParent = parentChunks[pChunkIdx];
        if (nextParent && childGroup.some((change) => overlaps(nextParent, change))) {
          parentGroup.push(nextParent);
          pChunkIdx += 1;
          expanded = true;
        }
        const nextChild = childChunks[cChunkIdx];
        if (nextChild && parentGroup.some((change) => overlaps(nextChild, change))) {
          childGroup.push(nextChild);
          cChunkIdx += 1;
          expanded = true;
        }
      }
      const start = Math.min(parent.baseStart, child.baseStart);
      const end = Math.max(parentGroup.at(-1)!.baseEnd, childGroup.at(-1)!.baseEnd);
      appendLines(resultLines, baseLines.slice(cursor, start));
      const parentOutput = render(start, end, parentGroup);
      const childOutput = render(start, end, childGroup);
      if (parentOutput.join("") === childOutput.join("")) {
        appendLines(resultLines, parentOutput);
      } else {
        clean = false;
        resultLines.push(`<<<<<<< ${pLabel}${markerEol}`);
        appendLines(resultLines, parentOutput);
        if (parentOutput.length > 0 && !/[\r\n]$/u.test(parentOutput.at(-1)!)) resultLines.push(markerEol);
        resultLines.push(`=======${markerEol}`);
        appendLines(resultLines, childOutput);
        if (childOutput.length > 0 && !/[\r\n]$/u.test(childOutput.at(-1)!)) resultLines.push(markerEol);
        resultLines.push(`>>>>>>> ${cLabel}${markerEol}`);
      }
      cursor = end;
      continue;
    }

    const takeParent = Boolean(parent && (!child || parent.baseStart <= child.baseStart));
    const change = takeParent ? parent! : child!;
    appendLines(resultLines, baseLines.slice(cursor, change.baseStart));
    appendLines(resultLines, change.lines);
    cursor = change.baseEnd;
    if (takeParent) pChunkIdx += 1;
    else cChunkIdx += 1;
  }
  appendLines(resultLines, baseLines.slice(cursor));

  return { clean, text: resultLines.join("") };
};

export const statesEqual = (a?: RecoveryState | null, b?: RecoveryState | null): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return sameState(a, b);
};

export interface PathMergeContext {
  path: string;
  baseState: RecoveryState;
  parentState: RecoveryState;
  childState: RecoveryState;
  readContent(state: RecoveryState): Promise<Buffer | null>;
}

const mergeMode = (
  baseMode: number | undefined,
  parentMode: number | undefined,
  childMode: number | undefined,
): { clean: true; mode: number | undefined } | { clean: false } => {
  if (parentMode === childMode) return { clean: true, mode: parentMode };
  if (parentMode === baseMode) return { clean: true, mode: childMode };
  if (childMode === baseMode) return { clean: true, mode: parentMode };
  return { clean: false };
};

export const planThreeWayPath = async (ctx: PathMergeContext): Promise<ThreeWayPathPlan> => {
  const { path, baseState, parentState, childState, readContent } = ctx;

  // 1. parentNow == child
  if (statesEqual(parentState, childState)) {
    return {
      path,
      decision: "identical",
      baseState,
      parentState,
      childState,
      isText: childState.kind === "regular-file",
    };
  }

  // 2. parentNow == base -> cleanly apply child
  if (statesEqual(parentState, baseState)) {
    return {
      path,
      decision: "apply-child",
      baseState,
      parentState,
      childState,
      isText: childState.kind === "regular-file",
    };
  }

  // 3. child == base -> keep parent (parent was edited, child did not touch)
  if (statesEqual(childState, baseState)) {
    return {
      path,
      decision: "keep-parent",
      baseState,
      parentState,
      childState,
      isText: parentState.kind === "regular-file",
    };
  }

  // 4. Both sides diverged from base
  const attributes=mergeFileAttributes('native' in baseState?baseState.native:undefined,
    'native' in parentState?parentState.native:undefined,'native' in childState?childState.native:undefined);
  const mode=mergeMode('mode' in baseState?baseState.mode:undefined,'mode' in parentState?parentState.mode:undefined,'mode' in childState?childState.mode:undefined);
  if(!attributes.clean||!mode.clean){return {path,decision:'conflict',conflictReason:!attributes.clean?'File attributes changed differently on both sides':'File mode changed differently on both sides',baseState,parentState,childState,isText:false};}
  const body=(state:RecoveryState):RecoveryState=>{
    if(!('mode' in state)&&!('native' in state))return state;
    const {mode:_,native:__,...rest}=state as RecoveryState&{mode?:number;native?:unknown};return rest as RecoveryState;
  };
  let selected:RecoveryState|undefined;
  if(statesEqual(body(parentState),body(childState)))selected=parentState;
  else if(statesEqual(body(parentState),body(baseState)))selected=childState;
  else if(statesEqual(body(childState),body(baseState)))selected=parentState;
  if(selected&&selected.kind!=='missing'&&selected.kind!=='unsupported'){
    const state={...selected,...(mode.mode===undefined?{}:{mode:mode.mode}),...(attributes.value?{native:attributes.value}:{})};
    return {path,decision:'merge-clean',baseState,parentState,childState,mergedState:state,isText:state.kind==='regular-file'};
  }
  // Check if both are regular files
  if (parentState.kind === "regular-file" && childState.kind === "regular-file") {
    const parentBuf = await readContent(parentState);
    const childBuf = await readContent(childState);
    const baseBuf = baseState.kind === "regular-file" ? await readContent(baseState) : Buffer.from("");

    if (!parentBuf || !childBuf) {
      return {
        path,
        decision: "conflict",
        conflictReason: "Unable to read file content for three-way merge",
        baseState,
        parentState,
        childState,
        isText: false,
      };
    }

    const isBinary = isBinaryBuffer(parentBuf) || isBinaryBuffer(childBuf) || isBinaryBuffer(baseBuf ?? Buffer.from(""));
    if (isBinary) {
      return {
        path,
        decision: "conflict",
        conflictReason: "Binary file modified on both sides",
        baseState,
        parentState,
        childState,
        isText: false,
      };
    }

    const baseStr = (baseBuf ?? Buffer.from("")).toString("utf8");
    const parentStr = parentBuf.toString("utf8");
    const childStr = childBuf.toString("utf8");

    const merged = mergeText3Way(baseStr, parentStr, childStr);
    if (merged.clean) {
      return {
        path,
        decision: "merge-clean",
        baseState,
        parentState,
        childState,
        mergedText: merged.text,
        ...(mode.mode === undefined ? {} : { mergedMode: mode.mode }),
        ...(attributes.value?{mergedNative:attributes.value}:{}),
        isText: true,
      };
    }

    return {
      path,
      decision: "conflict",
      conflictMarkers: merged.text,
      conflictReason: "Text divergence with conflicting chunks",
      baseState,
      parentState,
      childState,
      isText: true,
    };
  }

  // Non-text divergence (type mismatch, delete vs edit, symlink divergence)
  let reason = "Structural divergence";
  if (parentState.kind === "missing" && childState.kind !== "missing") {
    reason = "File deleted in parent but modified in child";
  } else if (parentState.kind !== "missing" && childState.kind === "missing") {
    reason = "File modified in parent but deleted in child";
  } else if (parentState.kind === "symlink" && childState.kind === "symlink") {
    reason = "Symbolic link target changed to different destinations";
  } else if (parentState.kind !== childState.kind) {
    reason = `Type conflict: parent is ${parentState.kind}, child is ${childState.kind}`;
  }

  return {
    path,
    decision: "conflict",
    conflictReason: reason,
    baseState,
    parentState,
    childState,
    isText: false,
  };
};

export interface BuildPlanInput {
  operationId: string;
  workspaceId: string;
  threadId: string;
  resultRevision: number | string;
  allPaths: string[];
  baseState: Record<string, RecoveryState>;
  parentState: Record<string, RecoveryState>;
  childState: Record<string, RecoveryState>;
  readContent(state: RecoveryState): Promise<Buffer | null>;
}

export const buildThreeWayMergePlan = async (input: BuildPlanInput): Promise<ThreeWayMergePlan> => {
  const paths: ThreeWayPathPlan[] = [];
  const appliedPaths: string[] = [];
  const conflictPaths: string[] = [];
  let insertions = 0;
  const deletions = 0;

  for (const p of input.allPaths) {
    const bState = input.baseState[p] ?? { kind: "missing" };
    const pState = input.parentState[p] ?? { kind: "missing" };
    const cState = input.childState[p] ?? { kind: "missing" };

    const pathPlan = await planThreeWayPath({
      path: p,
      baseState: bState,
      parentState: pState,
      childState: cState,
      readContent: input.readContent,
    });

    paths.push(pathPlan);

    if (pathPlan.decision === "apply-child" || pathPlan.decision === "merge-clean") {
      appliedPaths.push(p);
      insertions += 1;
    } else if (pathPlan.decision === "conflict") {
      conflictPaths.push(p);
    }
  }

  const clean = conflictPaths.length === 0;
  const diffStats: ThreadDiffStats = {
    files: appliedPaths.length + conflictPaths.length,
    insertions,
    deletions,
  };

  return {
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    resultRevision: input.resultRevision,
    clean,
    paths,
    appliedPaths,
    conflictPaths,
    diffStats,
  };
};
