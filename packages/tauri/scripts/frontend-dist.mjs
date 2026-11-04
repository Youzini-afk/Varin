import path from 'node:path';

export function frontendDist(runtime) {
  // Tauri tries to parse frontendDist as a URL before trying a directory.
  // A Windows drive letter parses as a URL scheme. The verbatim path keeps
  // it a filesystem path and works even when the runtime is on another drive.
  return path.toNamespacedPath(path.resolve(runtime, 'frontend'));
}
