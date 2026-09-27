import fs from "node:fs";
import path from "node:path";
import type { HarnessActorContext } from "@varin/protocol";
import type { HarnessAuthorizedPath } from "./router.js";
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
    inspectWorkspace(workspaceId: string): Promise<{ root: string }>;
    /**
     * HR0 resource addressing: the longest registered directory root
     * containing this canonical path (never a file root).
     */
    findContainingResourceRoot?(canonicalPath: string): Promise<{
      workspaceId: string;
      canonicalPath: string;
      kind: "directory" | "file";
    } | null>;
    /** Exact registered root for this canonical path, optionally by kind. */
    findExactResourceRoot?(
      canonicalPath: string,
      kind?: "directory" | "file",
    ): Promise<{ workspaceId: string; canonicalPath: string; kind: "directory" | "file" } | null>;
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
}

export function createHarnessPathAuthority({
  authorityId,
  documents,
  fsPromises = fs.promises,
  readFsPromises = fs.promises,
  pathModule = path,
  platform = process.platform,
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
   * Address a resolved canonical target through a resource root: an existing
   * file root wins exactly, then the longest containing directory root, then a
   * freshly registered root matching the target kind.
   */
  const resolveResourceRooted = async (
    inputPath: string,
    canonical: string,
    stat: { isDirectory(): boolean } | null,
  ): Promise<HarnessAuthorizedPath | null> => {
    const fileRoot = await documents.findExactResourceRoot?.(canonical, "file");
    if (fileRoot) {
      return {
        authorityId,
        workspaceId: fileRoot.workspaceId,
        canonicalResourceId: normalizePathIdentity(canonical, { pathModule, platform }),
        resolvedPath: canonical,
        inputPath,
        resourceId: "",
      };
    }
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
    // A missing target registers a file root (write destinations); callers
    // that required existence already failed on the stat above.
    const created = await documents.ensureResourceRoot(canonical, stat?.isDirectory() ? "directory" : "file");
    return {
      authorityId,
      workspaceId: created.workspaceId,
      canonicalResourceId: normalizePathIdentity(canonical, { pathModule, platform }),
      resolvedPath: canonical,
      inputPath,
      resourceId: "",
    };
  };

  const resolve = async (
      actor: HarnessActorContext,
      inputPath: string,
      options: { allowMissing: boolean },
    ): Promise<HarnessAuthorizedPath | null> => {
      const workspace = actor.workspaceId
        ? await documents.inspectWorkspace(actor.workspaceId)
        : null;
      const authorityRoot = workspace?.root ?? actor.authorityRoot ?? null;
      const baseDir = actor.cwd ?? authorityRoot;
      const absolutePath = isAbsoluteInput(inputPath)
        ? inputPath
        : baseDir ? pathModule.resolve(baseDir, inputPath) : null;
      if (!absolutePath || absolutePath.includes("\0")) return null;

      if (workspace) {
        try {
          const resolved = await assertAbsolutePathInWorkspace(absolutePath, {
            root: workspace.root,
            fsPromises,
            pathModule,
            allowMissing: options.allowMissing,
          });
          if (!await scopedPermits(actor, workspace.root, normalizePathIdentity(resolved.realPath, { pathModule, platform }))) {
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

      const canonical = await canonicalizePathIdentity(absolutePath, {
        allowMissing: options.allowMissing,
        fsPromises,
        pathModule,
      });
      let stat: { isDirectory(): boolean } | null = null;
      try {
        stat = await fsPromises.stat(canonical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && (error as NodeJS.ErrnoException)?.code !== "ENOTDIR") throw error;
        if (!options.allowMissing) throw error;
      }
      if (!await scopedPermits(actor, authorityRoot, normalizePathIdentity(canonical, { pathModule, platform }))) {
        return null;
      }
      return resolveResourceRooted(inputPath, canonical, stat);
    };

  const readAuthorizedFile = async (
    actor: HarnessActorContext,
    authorized: HarnessAuthorizedPath,
    signal?: AbortSignal,
  ): Promise<Buffer> => {
    // `authorized.workspaceId` is the Documents root record the admission-time
    // resolve produced; it is not the actor's session classification, so it is
    // intentionally not compared here — the re-resolve below detects drift.
    if (authorized.authorityId !== authorityId) {
      throw new Error("Document read authorization changed");
    }
    if (!authorized.resolvedPath) throw new Error("Authorized disk target has no resolved filesystem path");
    signal?.throwIfAborted();
    const before = await resolve(actor, authorized.inputPath, { allowMissing: false });
    if (!before || before.canonicalResourceId !== authorized.canonicalResourceId
      || before.resourceId !== authorized.resourceId || before.resolvedPath !== authorized.resolvedPath) {
      throw new Error("Document path changed before reading");
    }

    // Open the canonical target selected during router authorization, never
    // the original alias. O_NOFOLLOW protects the final component on systems
    // that support it; handle identity checks below cover systems that do not.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const handle = await readFsPromises.open(
      authorized.resolvedPath,
      fs.constants.O_RDONLY | noFollow,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.ino === 0n) throw new Error("Document path is not a readable regular file");
      signal?.throwIfAborted();
      const bytes = await handle.readFile(signal ? { signal } : undefined);
      signal?.throwIfAborted();

      const after = await resolve(actor, authorized.inputPath, { allowMissing: false });
      if (!after || after.canonicalResourceId !== authorized.canonicalResourceId
        || after.resourceId !== authorized.resourceId || after.resolvedPath !== authorized.resolvedPath) {
        throw new Error("Document path changed while reading");
      }
      const current = await readFsPromises.stat(after.resolvedPath, { bigint: true });
      if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error("Document path changed while reading");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  };

  return {
    resolve,
    readAuthorizedFile,
  };
}

export type HarnessPathAuthority = ReturnType<typeof createHarnessPathAuthority>;
