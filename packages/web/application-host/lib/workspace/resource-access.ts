import { canonicalizePathIdentity, isPathWithinRoot } from './path-safety.js';

/** Respect an explicitly restricted paired client; an unrestricted device has no extra root policy. */
export async function assertResourcePathAllowed(root: string, allowedDirectories?: readonly string[]): Promise<void> {
  if (!allowedDirectories?.length) return;
  const actual = await canonicalizePathIdentity(root, { allowMissing: true });
  for (const directory of allowedDirectories) {
    const allowed = await canonicalizePathIdentity(directory, { allowMissing: true });
    if (isPathWithinRoot(actual, allowed)) return;
  }
  throw new Error('The connected client does not have access to this file location');
}
