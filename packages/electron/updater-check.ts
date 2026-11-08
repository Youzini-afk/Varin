import { isDeepStrictEqual } from 'node:util';

const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

export const isMissingUpdateFeedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

export interface DesktopUpdateInfo {
  files?: unknown;
  path?: unknown;
  sha512?: unknown;
  packages?: unknown;
  releaseDate?: string | null | undefined;
  releaseNotes?: unknown;
  version: string;
}

export interface DesktopUpdateResult {
  updateInfo: DesktopUpdateInfo;
}

export interface DesktopPendingUpdate<Result = DesktopUpdateResult> {
  downloaded?: boolean | undefined;
  electronUpdate?: Result | undefined;
  version: string;
}

export const checkForDesktopUpdate = async <Result extends DesktopUpdateResult>({
  autoUpdater,
  currentVersion,
  compareVersions,
  pendingUpdate,
}: {
  autoUpdater: { checkForUpdates(): Promise<Result | null> };
  compareVersions(left: string, right: string): number;
  currentVersion: string;
  pendingUpdate: DesktopPendingUpdate<Result> | null;
}) => {
  let updateResult: Result | null;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
    // Before the first Linux (or platform) release publishes its feed, electron-updater
    // returns 404 for latest-*.yml. Treat that as authoritative "no update" instead of
    // surfacing a hard failure that looks like a broken updater.
    if (isMissingUpdateFeedError(error)) {
      return {
        available: false,
        updateInfo: null,
        updateResult: null,
        nextVersion: currentVersion,
        pendingUpdate: null,
      };
    }
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    throw new Error(`Unable to check for updates${detail}. Check your network connection and try again.`, { cause: error });
  }

  const updateInfo = updateResult?.updateInfo;
  const nextVersion =
    (typeof updateInfo?.version === 'string' && updateInfo.version) ||
    currentVersion;
  const available = compareVersions(nextVersion, currentVersion) > 0;
  const previous = pendingUpdate?.electronUpdate?.updateInfo;
  const samePayload = pendingUpdate?.version === nextVersion && previous && updateInfo
    && isDeepStrictEqual(
      [previous.files, previous.path, previous.sha512, previous.packages],
      [updateInfo.files, updateInfo.path, updateInfo.sha512, updateInfo.packages],
    );
  return {
    available,
    updateInfo,
    updateResult,
    nextVersion,
    // Release notes/dates can change without replacing the downloaded installer.
    // Keep its record alive so a download completing during the check is not lost.
    pendingUpdate: available && updateResult
      ? samePayload ? pendingUpdate : { version: nextVersion, electronUpdate: updateResult }
      : null,
  };
};
