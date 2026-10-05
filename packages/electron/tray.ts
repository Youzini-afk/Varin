// Native tray/menu bar controller.
//
// Surfaces a glanceable, always-visible view of Varin's live state:
//  1. an aggregate activity indicator (idle / busy / error+retry) in the icon
//     title, rendered as a monochrome template image plus a text counter so it
//     adapts to light/dark menu bars (colour can't be shown in template mode);
//  2. pending approvals (permission + question requests) that block agents,
//     with inline Allow/Deny actions;
//  3. the list of active sessions with status + branch, click to focus;
//  4. quick actions (new session, show window, quit).
//
// The live state lives in the renderer (Zustand). It is pushed here over the
// existing IPC bridge via the `desktop_tray_update` command; this module owns
// only presentation. Tray clicks call back through `onAction`, which main.mjs
// routes to the renderer (focus-session, respond-permission, …) or handles
// natively (show-main-window, quit).

import { Tray, Menu, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';

export interface TrayAction extends Record<string, unknown> {
  type: string;
}

interface TraySession {
  directory?: string | undefined;
  hasError?: boolean | undefined;
  id: string;
  status?: string | undefined;
  subtitle?: string | undefined;
  title?: string | undefined;
  unseen?: number | undefined;
}

interface TrayApproval {
  directory?: string | undefined;
  id: string;
  kind: string;
  label?: string | undefined;
  sessionId: string;
  sessionTitle?: string | undefined;
}

interface TraySnapshot {
  approvals?: TrayApproval[];
  instanceName?: string;
  sessions?: TraySession[];
}

interface TrayCounts {
  approvals: number;
  busy: number;
  error: number;
  unseen: number;
}

const buildRemoteContextMenu = ({ onShowWindow, onQuit, getMode }: {
  getMode?: (() => string) | undefined;
  onQuit(): void;
  onShowWindow(): void;
}) => {
  const mode = typeof getMode === 'function' ? getMode() : 'local';
  const modeLabel = mode === 'local'
    ? 'Mode: Local'
    : `Mode: Remote (${mode})`;

  return Menu.buildFromTemplate([
    { label: 'Open Varin', click: onShowWindow },
    { type: 'separator' },
    { label: modeLabel, enabled: false },
    { type: 'separator' },
    { label: 'Quit Varin', click: onQuit },
  ]);
};

export const createTrayIcon = (): NativeImage => {
  // 16x16 RGBA buffer: white diamond on transparent background.
  const size = 16;
  const channels = 4;
  const buffer = Buffer.alloc(size * size * channels, 0);
  const rows = [
    { from: 6, to: 9 },
    { from: 6, to: 9 },
    { from: 4, to: 11 },
    { from: 4, to: 11 },
    { from: 2, to: 13 },
    { from: 2, to: 13 },
    { from: 0, to: 15 },
    { from: 0, to: 15 },
    { from: 0, to: 15 },
    { from: 0, to: 15 },
    { from: 2, to: 13 },
    { from: 2, to: 13 },
    { from: 4, to: 11 },
    { from: 4, to: 11 },
    { from: 6, to: 9 },
    { from: 6, to: 9 },
  ];

  for (let row = 0; row < size; row += 1) {
    const { from, to } = rows[row]!;
    for (let col = from; col <= to; col += 1) {
      const offset = (row * size + col) * channels;
      buffer[offset] = 255;
      buffer[offset + 1] = 255;
      buffer[offset + 2] = 255;
      buffer[offset + 3] = 255;
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
};

export const createTray = ({ onShowWindow, onQuit, getMode }: {
  getMode?: (() => string) | undefined;
  onQuit(): void;
  onShowWindow(): void;
}): Tray => {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('Varin');
  tray.setContextMenu(buildRemoteContextMenu({ onShowWindow, onQuit, getMode }));
  if (process.platform !== 'darwin') {
    tray.on('click', onShowWindow);
  }
  return tray;
};

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
// Linux StatusNotifier hosts often blank or drop oversized tray images; keep
// the icon at a panel-typical size so AppImage trays stay visible.
const LINUX_TRAY_ICON_PX = 22;

const MAX_SESSIONS = 8;
const MAX_APPROVALS = 10;

const truncate = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

// Which status icon key a session maps to. 'blank' (a transparent image)
// reserves the same left gutter for idle rows so every row aligns.
const statusIconKey = (session: TraySession): 'blank' | 'busy' | 'error' | 'retry' | 'unseen' => {
  if (session.status === 'busy') return 'busy';
  if (session.status === 'retry') return 'retry';
  if (session.hasError) return 'error';
  if ((session.unseen ?? 0) > 0) return 'unseen';
  return 'blank';
};

const sessionLabel = (session: TraySession): string => {
  // The status is a native left icon (the ✓ already signals unread), so the
  // label is just the session title.
  return truncate(session.title || 'Untitled session', 40);
};

const approvalLabel = (approval: TrayApproval): string => {
  const icon = approval.kind === 'permission' ? '⛔' : '❓';
  const who = truncate(approval.sessionTitle || 'Session', 24);
  const what = truncate(approval.label || (approval.kind === 'permission' ? 'Permission request' : 'Question'), 34);
  return `${icon} ${who} — ${what}`;
};

// Text shown next to the icon — reserved for the two states where a precise
// count is actionable: pending approvals and errors. Busy and unread are
// conveyed by the icon itself (animated / filled faces), so they add no text.
// Glyphs come from the Geometric Shapes block so macOS renders them monochrome
// (not colour emoji) and tints them with the menu bar like the template icon.
const computeTitle = (counts: TrayCounts): string => {
  if (counts.approvals > 0) return `◆ ${counts.approvals}`; // decision needed
  if (counts.error > 0) return `▲ ${counts.error}`;         // problem
  return '';
};

// Which icon variant to show. Busy work animates a "breathing" fill; unread
// (with nothing active) holds a static filled cube until the state clears;
// otherwise the plain outline.
const computeIconState = (counts: TrayCounts): 'busy' | 'idle' | 'unseen' => {
  if (counts.busy > 0) return 'busy';
  if (counts.unseen > 0) return 'unseen';
  return 'idle';
};

const computeTooltip = (counts: TrayCounts, sessionCount: number): string => {
  if (sessionCount === 0) return 'Varin — no active sessions';
  const bits = [];
  if (counts.approvals > 0) bits.push(`${counts.approvals} awaiting approval`);
  if (counts.error > 0) bits.push(`${counts.error} with errors`);
  if (counts.busy > 0) bits.push(`${counts.busy} working`);
  if (counts.unseen > 0) bits.push(`${counts.unseen} unread`);
  const suffix = bits.length ? ` · ${bits.join(', ')}` : ' · idle';
  return `Varin — ${sessionCount} session${sessionCount === 1 ? '' : 's'}${suffix}`;
};

// Frame cadence for the "breathing" busy animation. With the eased frame set
// (denser near the extremes) a slower tick reads as a calm, continuous glow
// rather than a snappy blink.
const ANIM_INTERVAL_MS = 75;

const toTemplateImage = (p: string): NativeImage => {
  let image = nativeImage.createFromPath(p);
  if (image.isEmpty()) return image;
  if (isMac) image.setTemplateImage(true);
  if (isLinux) {
    const { width, height } = image.getSize();
    if (width > LINUX_TRAY_ICON_PX || height > LINUX_TRAY_ICON_PX) {
      image = image.resize({
        width: LINUX_TRAY_ICON_PX,
        height: LINUX_TRAY_ICON_PX,
        quality: 'best',
      });
    }
  }
  return image;
};

// idleIconPath: plain outline (calm state). unseenIconPath: statically filled
// (a finished session left unread). breathIconPaths: eased outline→fill frames
// the busy state ping-pongs through.
export const createTrayController = ({ idleIconPath, unseenIconPath, breathIconPaths, statusIconPaths, onAction }: {
  breathIconPaths: string[];
  idleIconPath: string;
  onAction(action: TrayAction): void;
  statusIconPaths?: Record<string, string>;
  unseenIconPath: string;
}) => {
  let tray: Tray | null = null;
  let lastTitle: string | null = null;
  let lastTooltip: string | null = null;
  let lastMenuKey: string | null = null;

  // macOS auto-picks the @2x file next to each path and tints the alpha.
  // Windows uses the regular app icon and ignores template tinting.
  const idleFrame = toTemplateImage(idleIconPath);
  const unseenFrame = toTemplateImage(unseenIconPath);
  const breathFrames = breathIconPaths.map(toTemplateImage);
  // Per-row status icons (template images, tinted + vertically centred by macOS).
  const statusIcons: Record<string, NativeImage> = {};
  for (const [key, p] of Object.entries(statusIconPaths || {})) {
    statusIcons[key] = toTemplateImage(p);
  }

  let iconState: 'busy' | 'idle' | 'unseen' | null = null;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let animIndex = 0;
  let animDir = 1;

  const stopAnim = (): void => {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
  };

  const startAnim = (): void => {
    if (animTimer || !tray || tray.isDestroyed?.()) return;
    if (breathFrames.length < 2) return;
    animIndex = 0;
    animDir = 1;
    animTimer = setInterval(() => {
      if (!tray || tray.isDestroyed?.()) return;
      tray.setImage(breathFrames[animIndex] || idleFrame);
      // Ping-pong for a seamless, infinite in-and-out breath.
      animIndex += animDir;
      if (animIndex >= breathFrames.length - 1) { animIndex = breathFrames.length - 1; animDir = -1; }
      else if (animIndex <= 0) { animIndex = 0; animDir = 1; }
    }, ANIM_INTERVAL_MS);
  };

  const applyIconState = (nextState: 'busy' | 'idle' | 'unseen'): void => {
    if (nextState === iconState) return;
    iconState = nextState;
    if (!tray || tray.isDestroyed?.()) return;
    if (nextState === 'busy') {
      if (breathFrames.length > 1) startAnim();
      else tray.setImage(breathFrames[0] || idleFrame);
    } else if (nextState === 'unseen') {
      stopAnim();
      tray.setImage(unseenFrame);
    } else {
      stopAnim();
      tray.setImage(idleFrame);
    }
  };

  const ensureTray = (): Tray => {
    if (tray && !tray.isDestroyed?.()) return tray;
    tray = new Tray(idleFrame);
    tray.setIgnoreDoubleClickEvents(true);
    if (!isMac) {
      // Windows: left-click shows. Linux: left-click toggles show/hide so the
      // panel icon stays useful when the window is already open.
      tray.on('click', () => onAction({
        type: isLinux ? 'toggle-main-window' : 'show-main-window',
      }));
    }
    return tray;
  };

  const buildMenu = (snapshot: TraySnapshot) => {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    const header = typeof snapshot.instanceName === 'string' && snapshot.instanceName.trim()
      ? snapshot.instanceName.trim()
      : 'Varin';

    const template: MenuItemConstructorOptions[] = [
      { label: header, enabled: false },
      { type: 'separator' },
    ];

    if (approvals.length > 0) {
      template.push({ label: 'Needs your attention', enabled: false });
      const approvalItem = (approval: TrayApproval): MenuItemConstructorOptions => {
        if (approval.kind === 'permission') {
          return {
            label: approvalLabel(approval),
            submenu: [
              { label: 'Allow once', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'once' }) },
              { label: 'Allow always', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'always' }) },
              { type: 'separator' },
              { label: 'Deny', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'reject' }) },
              { type: 'separator' },
              { label: 'Open in app', click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }) },
            ],
          };
        }
        return {
          label: approvalLabel(approval),
          click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }),
        };
      };
      for (const approval of approvals.slice(0, MAX_APPROVALS)) {
        template.push(approvalItem(approval));
      }
      const approvalOverflow = approvals.slice(MAX_APPROVALS);
      if (approvalOverflow.length > 0) {
        template.push({
          label: `${approvalOverflow.length} more…`,
          submenu: approvalOverflow.map(approvalItem),
        });
      }
      template.push({ type: 'separator' });
    }

    const sessionItem = (session: TraySession): MenuItemConstructorOptions => ({
      label: sessionLabel(session),
      // Status icon on the left, centred across both lines; idle uses the blank
      // placeholder so every row keeps the same gutter.
      ...(statusIcons[statusIconKey(session)] || statusIcons.blank
        ? { icon: statusIcons[statusIconKey(session)] || statusIcons.blank! }
        : {}),
      // Secondary smaller line (macOS): project · branch.
      ...(session.subtitle ? { sublabel: truncate(session.subtitle, 48) } : {}),
      click: () => onAction({ type: 'focus-session', sessionId: session.id, directory: session.directory || '' }),
    });

    if (sessions.length > 0) {
      template.push({ label: 'Sessions', enabled: false });
      for (const session of sessions.slice(0, MAX_SESSIONS)) {
        template.push(sessionItem(session));
      }
      const overflow = sessions.slice(MAX_SESSIONS);
      if (overflow.length > 0) {
        template.push({
          label: `${overflow.length} more…`,
          submenu: overflow.map(sessionItem),
        });
      }
    } else {
      template.push({ label: 'No active sessions', enabled: false });
    }

    template.push(
      { type: 'separator' },
      { label: 'New Session', click: () => onAction({ type: 'new-session' }) },
    );

    if (isLinux || process.platform === 'win32') {
      // Right-click context menu: show / hide / close (quit). Matches the
      // expected AppImage / Windows tray controls.
      template.push(
        { type: 'separator' },
        { label: 'Show Window', click: () => onAction({ type: 'show-main-window' }) },
        { label: 'Hide Window', click: () => onAction({ type: 'hide-main-window' }) },
        { type: 'separator' },
        { label: 'Close', click: () => onAction({ type: 'quit' }) },
      );
    } else {
      template.push(
        { label: 'Show Varin', click: () => onAction({ type: 'show-main-window' }) },
        { type: 'separator' },
        { label: 'Quit Varin', click: () => onAction({ type: 'quit' }) },
      );
    }

    return Menu.buildFromTemplate(template);
  };

  // Lightweight signature of the menu-affecting content — skips nativeImage
  // and click handlers that can't be serialized. Cheaper than buildMenu itself.
  const menuKey = (snapshot: TraySnapshot): string => {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    return JSON.stringify({
      h: typeof snapshot.instanceName === 'string' ? snapshot.instanceName : '',
      s: sessions.map((s) => `${s.id}|${s.title}|${s.status}|${s.unseen}|${s.hasError}|${s.subtitle}|${s.directory}`),
      a: approvals.map((a) => `${a.id}|${a.kind}|${a.sessionId}|${a.sessionTitle}|${a.label}|${a.directory}`),
    });
  };

  const update = (rawSnapshot: TraySnapshot | null | undefined): void => {
    const snapshot: TraySnapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {};
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];

    const counts = {
      busy: sessions.filter((s) => s.status === 'busy' || s.status === 'retry').length,
      error: sessions.filter((s) => s.hasError).length,
      approvals: approvals.length,
      unseen: sessions.reduce((sum, session) => sum + (typeof session.unseen === 'number' && Number.isFinite(session.unseen) ? session.unseen : 0), 0),
    };

    const widget = ensureTray();
    const title = computeTitle(counts);
    if (title !== lastTitle) {
      widget.setTitle(title);
      lastTitle = title;
    }
    applyIconState(computeIconState(counts));
    const tooltip = computeTooltip(counts, sessions.length);
    if (tooltip !== lastTooltip) {
      widget.setToolTip(tooltip);
      lastTooltip = tooltip;
    }
    const key = menuKey(snapshot);
    if (key !== lastMenuKey) {
      widget.setContextMenu(buildMenu(snapshot));
      lastMenuKey = key;
    }
  };

  const destroy = (): void => {
    stopAnim();
    if (tray && !tray.isDestroyed?.()) {
      tray.destroy();
    }
    tray = null;
    lastTitle = null;
    lastTooltip = null;
    lastMenuKey = null;
    iconState = null;
  };

  return { update, destroy };
};
