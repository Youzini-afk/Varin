import { readFileSync, writeFileSync } from 'node:fs';

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Refresh workspace identity fields without resolving or upgrading dependencies. */
export function syncWorkspaceLockVersions(lockPath, workspaces) {
  const original = readFileSync(lockPath, 'utf8');
  let source = original;
  for (const { directory, name, version } of workspaces) {
    const pattern = new RegExp(
      `("${escapeRegex(directory)}"\\s*:\\s*\\{\\s*"name"\\s*:\\s*"${escapeRegex(name)}"\\s*,\\s*"version"\\s*:\\s*")([^"]+)(")`,
      'g',
    );
    let count = 0;
    source = source.replace(pattern, (_match, prefix, _oldVersion, suffix) => {
      count += 1;
      return `${prefix}${version}${suffix}`;
    });
    if (count !== 1) throw new Error(`Expected one ${directory} workspace identity in ${lockPath}; found ${count}`);
  }
  if (source !== original) writeFileSync(lockPath, source);
}
