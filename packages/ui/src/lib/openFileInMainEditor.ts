import { getResolvedWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { openWorkbenchEditor } from '@/lib/workbench/editors/session';
import { useUIStore } from '@/stores/useUIStore';

type OpenFileInMainEditorOptions = {
  line?: number;
  column?: number;
  focus?: boolean;
};

const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/g, '');
  }

  return normalized;
};

const toComparablePath = (value: string): string => (
  /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
);

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

export const openFileInMainEditor = (
  directory: string | null | undefined,
  filePath: string | null | undefined,
  options: OpenFileInMainEditorOptions = {},
): boolean => {
  const root = normalizePath((directory || '').trim());
  const targetPath = normalizePath((filePath || '').trim());

  if (!root || !targetPath || !isPathWithinRoot(targetPath, root)) {
    return false;
  }

  const workspaceId = getResolvedWorkbenchWorkspaceId(root);
  const resourceId = resourceIdFromWorkspacePath(root, targetPath);
  if (!workspaceId || !resourceId) return false;
  openWorkbenchEditor(workspaceId, resourceId);

  const uiStore = useUIStore.getState();
  if (Number.isFinite(options.line ?? Number.NaN)) {
    uiStore.setPendingFileFocusPath(null);
    uiStore.setPendingFileNavigation({
      path: targetPath,
      line: Math.max(1, Math.trunc(options.line as number)),
      column: Number.isFinite(options.column ?? Number.NaN)
        ? Math.max(1, Math.trunc(options.column as number))
        : 1,
    });
  } else if (options.focus !== false) {
    uiStore.setPendingFileNavigation(null);
    uiStore.setPendingFileFocusPath(targetPath);
  }

  uiStore.setActiveMainTab('files');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('varin:ide-focus-editor'));
  return true;
};
