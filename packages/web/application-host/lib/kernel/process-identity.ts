import path from "node:path";
import type { DocumentAuthority } from "../documents/authority.js";
import { canonicalizePathIdentity, isPathWithinRoot } from "../workspace/path-safety.js";
import type { NativeProcessIdentity } from "./process-service.js";

/** Ordinary Host tools require a currently admitted Documents root. Native source
 * processes use spawnAdmitted with their original source owner, never a pathname catalog. */
export function createKernelProcessIdentityResolver(options: {
  documents: Pick<DocumentAuthority, "resolveScopeId" | "resolveWorkspace" | "inspectWorkspace">;
}): (cwd: string) => Promise<NativeProcessIdentity> {
  return async cwd => {
    if (!path.isAbsolute(cwd)) throw new Error("Native process cwd must be absolute");
    const canonicalCwd = await canonicalizePathIdentity(cwd);
    const workspaceId = await options.documents.resolveScopeId(canonicalCwd);
    if (!workspaceId) throw new Error("Process cwd has no admitted Documents workspace");
    const workspace = await options.documents.inspectWorkspace(workspaceId);
    await options.documents.resolveWorkspace({ path: workspace.root });
    const canonicalRoot = await canonicalizePathIdentity(workspace.root);
    if (!isPathWithinRoot(canonicalCwd, canonicalRoot)) throw new Error("Process cwd escaped its Documents workspace");
    return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
  };
}
