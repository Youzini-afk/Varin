import fs from "node:fs";
import path from "node:path";
import type { HarnessActorContext, DocumentReadPageRequest } from "@varin/protocol";
import { readHandlePage, readStableFile } from './read-page.js';
import type { HarnessAuthorizedPath } from "./router.js";
import { waitWithSignal } from "../cancellation.js";
import {
  assertAbsolutePathInWorkspace,
  canonicalizePathIdentity,
  isPathWithinRoot,
  isWinDriveAbsolute,
  normalizePathIdentity,
  WorkspacePathError,
  type PathSafetyFsPromises,
} from "../workspace/path-safety.js";

export interface HarnessPathAuthorityOptions {
  authorityId: string;
  documents: {
    inspectWorkspace(workspaceId: string, options?: { signal?: AbortSignal; reportPhase?: (phase: string) => void }): Promise<{ root: string }>;
    /**
     * HR0 resource addressing: the longest registered directory root
     * containing this canonical path (never a file root).
     */
    findContainingResourceRoot?(canonicalPath: string): Promise<{
      workspaceId: string;
      canonicalPath: string;
      kind: "directory" | "file";
    } | null>;
    /**
     * Register a resource root for an external target. `file` roots address
     * exactly one canonical file; `directory` roots address a subtree. These
     * are backend addressing records — the configured trusted-root gate still
     * applies inside Documents.
     */
    ensureResourceRoot?(
      canonicalPath: string,
      kind: "directory" | "file",
    ): Promise<{ workspaceId: string; canonicalPath: string; kind: "directory" | "file" }>;
  };
  fsPromises?: PathSafetyFsPromises;
  /** Test seam for interleaving a filesystem change with an authorized read. */
  readFsPromises?: Pick<typeof fs.promises, "open" | "stat">;
  pathModule?: typeof path;
  platform?: string;
  resolveInputPath?(actor: HarnessActorContext, input: string, signal?: AbortSignal): Promise<string>;
}

export function createHarnessPathAuthority({
  authorityId,
  documents,
  fsPromises = fs.promises,
  readFsPromises = fs.promises,
  pathModule = path,
  platform = process.platform,
  resolveInputPath,
}: HarnessPathAuthorityOptions) {
  const isAbsoluteInput = (value: string): boolean => (
    pathModule.isAbsolute(value) || isWinDriveAbsolute(value)
  );

  const scopedPermits = async (
    actor: HarnessActorContext,
    authorityRoot: string | null,
    targetIdentity: string,
  ): Promise<boolean> => {
    if (!actor.workspaceScope?.length) return true;
    for (const scopePath of actor.workspaceScope) {
      // A relative scope has no meaning for a rootless actor; it cannot
      // broaden the grant, so it simply does not match.
      if (!isAbsoluteInput(scopePath) && !authorityRoot) continue;
      const scopeAbsolute = isAbsoluteInput(scopePath)
        ? scopePath
        : pathModule.resolve(authorityRoot!, scopePath);
      try {
        const scopeIdentity = normalizePathIdentity(
          await canonicalizePathIdentity(scopeAbsolute, { allowMissing: true, fsPromises, pathModule }),
          { pathModule, platform },
        );
        if (isPathWithinRoot(targetIdentity, scopeIdentity, pathModule, { platform })) return true;
      } catch (error) {
        if (!(error instanceof WorkspacePathError)) throw error;
      }
    }
    return false;
  };

  /**
   * Path-authorized reads and writes use the same directory identity. The
   * native mutation journal requires a non-empty path below its root, and
   * rereads must not switch to a legacy exact-file root midway through a call.
   */
  const resolveResourceRooted = async (
    inputPath: string,
    canonical: string,
    stat: { isDirectory(): boolean } | null,
  ): Promise<HarnessAuthorizedPath | null> => {
    const containing = await documents.findContainingResourceRoot?.(canonical);
    if (containing) {
      const relative = pathModule.relative(containing.canonicalPath, canonical);
      return {
        authorityId,
        workspaceId: containing.workspaceId,
        canonicalResourceId: normalizePathIdentity(canonical, { pathModule, platform }),
        resolvedPath: canonical,
        inputPath,
        resourceId: relative.split(pathModule.sep).join("/"),
      };
    }
    if (!documents.ensureResourceRoot) return null;
    let rootPath = canonical;
    if (!stat?.isDirectory()) {
      rootPath = pathModule.dirname(canonical);
      for (;;) {
        try {
          if ((await fsPromises.stat(rootPath)).isDirectory()) break;
          throw new WorkspacePathError(`Resource parent is not a directory: ${rootPath}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
          const parent = pathModule.dirname(rootPath);
          if (parent === rootPath) throw error;
          rootPath = parent;
        }
      }
    }
    const created = await documents.ensureResourceRoot(rootPath, "directory");
    return {
      authorityId,
      workspaceId: created.workspaceId,
      canonicalResourceId: normalizePathIdentity(canonical, { pathModule, platform }),
      resolvedPath: canonical,
      inputPath,
      resourceId: pathModule.relative(created.canonicalPath, canonical).split(pathModule.sep).join("/"),
    };
  };

  const resolve = async (
      actor: HarnessActorContext,
      inputPath: string,
      options: { allowMissing: boolean; signal?: AbortSignal; reportPhase?: (phase: string) => void },
    ): Promise<HarnessAuthorizedPath | null> => {
      const stage = (phase: string): void => {
        options.signal?.throwIfAborted();
        options.reportPhase?.(`authorize:${phase}`);
      };
      stage("workspace");
      const workspace = actor.workspaceId
        ? await waitWithSignal(documents.inspectWorkspace(actor.workspaceId, options), options.signal)
        : null;
      const authorityRoot = workspace?.root ?? actor.authorityRoot ?? null;
      const baseDir = actor.cwd ?? authorityRoot;
      stage("normalize");
      const resolvedInput = resolveInputPath ? await resolveInputPath(actor, inputPath, options.signal) : inputPath;
      const absolutePath = isAbsoluteInput(resolvedInput)
        ? resolvedInput
        : baseDir ? pathModule.resolve(baseDir, resolvedInput) : null;
      if (!absolutePath || absolutePath.includes("\0")) return null;

      stage("path");
      if (workspace) {
        try {
          const resolved = await waitWithSignal(assertAbsolutePathInWorkspace(absolutePath, {
            root: workspace.root,
            fsPromises,
            pathModule,
            allowMissing: options.allowMissing,
          }), options.signal);
          stage("scope");
          if (!await waitWithSignal(scopedPermits(actor, workspace.root, normalizePathIdentity(resolved.realPath, { pathModule, platform })), options.signal)) {
            return null;
          }
          return {
            authorityId,
            // `workspace` is only resolved when `actor.workspaceId` is set.
            workspaceId: actor.workspaceId!,
            canonicalResourceId: normalizePathIdentity(resolved.realPath, { pathModule, platform }),
            resolvedPath: resolved.realPath,
            inputPath,
            resourceId: resolved.relativePath.split(pathModule.sep).join("/"),
          };
        } catch (error) {
          // Only containment failures fall through to external addressing;
          // registry/authority failures must not masquerade as "outside".
          if (!(error instanceof WorkspacePathError)) throw error;
        }
      }

      stage("path");
      const canonical = await waitWithSignal(canonicalizePathIdentity(absolutePath, {
        allowMissing: options.allowMissing,
        fsPromises,
        pathModule,
      }), options.signal);
      let stat: { isDirectory(): boolean } | null = null;
      try {
        stat = await waitWithSignal(fsPromises.stat(canonical), options.signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && (error as NodeJS.ErrnoException)?.code !== "ENOTDIR") throw error;
        if (!options.allowMissing) throw error;
      }
      stage("scope");
      if (!await waitWithSignal(scopedPermits(actor, authorityRoot, normalizePathIdentity(canonical, { pathModule, platform })), options.signal)) {
        return null;
      }
      stage("resource");
      return waitWithSignal(resolveResourceRooted(inputPath, canonical, stat), options.signal);
    };

  const withAuthorizedFile = async <T>(
    actor: HarnessActorContext,
    authorized: HarnessAuthorizedPath,
    read: (handle: fs.promises.FileHandle, stat: fs.BigIntStats) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T; revision: string }> => {
    // The Documents root record is part of the resolved resource identity,
    // independent of the actor's session classification.
    if (authorized.authorityId !== authorityId) {
      throw new Error("Document read authorization changed");
    }
    if (!authorized.resolvedPath) throw new Error("Authorized disk target has no resolved filesystem path");
    signal?.throwIfAborted();
    const before = await resolve(actor, authorized.inputPath, { allowMissing: false, ...(signal ? { signal } : {}) });
    if (!before || before.workspaceId !== authorized.workspaceId || before.canonicalResourceId !== authorized.canonicalResourceId
      || before.resourceId !== authorized.resourceId || before.resolvedPath !== authorized.resolvedPath) {
      throw new Error("Document path changed before reading");
    }

    // Open the admitted canonical target; re-resolving the caller's alias is
    // only an identity check, never a second content selection.
    return readStableFile(authorized.resolvedPath, read, signal, async () => {
      const after = await resolve(actor, authorized.inputPath, { allowMissing: false, ...(signal ? { signal } : {}) });
      if (!after || after.workspaceId !== authorized.workspaceId || after.canonicalResourceId !== authorized.canonicalResourceId
        || after.resourceId !== authorized.resourceId || after.resolvedPath !== authorized.resolvedPath) {
        throw new Error("Document path changed while reading");
      }
    }, readFsPromises);
  };

  const readAuthorizedFile = async (actor: HarnessActorContext, authorized: HarnessAuthorizedPath, signal?: AbortSignal): Promise<Buffer> => (
    await withAuthorizedFile(actor, authorized, handle => handle.readFile(signal ? { signal } : undefined), signal)
  ).value;

  const readAuthorizedPage = async (actor: HarnessActorContext, authorized: HarnessAuthorizedPath, page: DocumentReadPageRequest, signal?: AbortSignal) => (
    await withAuthorizedFile(actor, authorized, (handle, stat) => readHandlePage(handle, Number(stat.size), page, signal), signal)
  );

  return {
    resolve,
    readAuthorizedFile,
    readAuthorizedPage,
  };
}

export type HarnessPathAuthority = ReturnType<typeof createHarnessPathAuthority>;
