import { recordOf } from './runtime-types.js';
import { normalizeLocale } from '@varin/application-client/locale';
import {
  VARIN_REMOTE_SAFE_DESKTOP_COMMANDS,
  type VarinDesktopCommand,
  type PreloadBootstrapPayload,
  type PreloadBootstrapShared,
} from '@varin/application-client/desktop';

const asTrimmedString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const REMOTE_SAFE_DESKTOP_COMMANDS: ReadonlySet<VarinDesktopCommand> = new Set(
  VARIN_REMOTE_SAFE_DESKTOP_COMMANDS,
);

export const normalizeExternalUrl = (raw: unknown): string | null => {
  const value = asTrimmedString(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

export interface RendererTrustOptions {
  developmentUiOrigin?: string | null | undefined;
  localOrigins?: Array<string | null | undefined> | undefined;
  uiProtocol?: string | undefined;
}

export const isTrustedLocalRendererUrl = (raw: unknown, options: RendererTrustOptions = {}): boolean => {
  const value = asTrimmedString(raw);
  if (!value) return false;

  try {
    const url = new URL(value);
    const uiProtocol = asTrimmedString(options.uiProtocol) || 'varin-ui';
    if (url.protocol === `${uiProtocol}:` && url.hostname === 'app') return true;

    const developmentUiOrigin = asTrimmedString(options.developmentUiOrigin);
    if (developmentUiOrigin && url.origin === developmentUiOrigin) return true;

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    for (const candidate of options.localOrigins || []) {
      const local = asTrimmedString(candidate);
      if (!local) continue;
      try {
        if (new URL(local).origin === url.origin) return true;
      } catch {
        /* invalid localOrigin entry; skip malformed configured origin */
      }
    }
    return false;
  } catch {
    return false;
  }
};

export interface PreloadBootstrapInput extends RendererTrustOptions {
  locale?: unknown;
  apiBaseUrl?: unknown;
  clientToken?: unknown;
  homeDirectory?: unknown;
  localOrigin?: unknown;
  macosMajor?: unknown;
  macVibrancy?: unknown;
  relayHostId?: unknown;
  requestHeaders?: unknown;
  senderUrl?: unknown;
  trayEnabled?: unknown;
}

// Re-export the bootstrap payload types from the shared desktop contract so
// consumers import from a single owner. The implementation below still
// constructs the discriminated union; the types live in application-client.
export type { PreloadBootstrapPayload, PreloadBootstrapShared };

export const createPreloadBootstrapPayload = (input: PreloadBootstrapInput = {}): PreloadBootstrapPayload => {
  const localPage = isTrustedLocalRendererUrl(input.senderUrl, {
    uiProtocol: input.uiProtocol,
    developmentUiOrigin: input.developmentUiOrigin,
    localOrigins: input.localOrigins,
  });
  const shared: PreloadBootstrapShared = {
    ...(typeof input.locale === 'string' ? { locale: normalizeLocale(input.locale) } : {}),
    localPage,
    localOrigin: asTrimmedString(input.localOrigin),
    apiBaseUrl: asTrimmedString(input.apiBaseUrl),
    macosMajor: typeof input.macosMajor === 'number' && Number.isFinite(input.macosMajor) ? input.macosMajor : 0,
    macVibrancy: input.macVibrancy !== false,
    trayEnabled: input.trayEnabled !== false,
  };
  if (!localPage) return { ...shared, localPage: false as const };

  const requestHeaders = recordOf(input.requestHeaders);
  return {
    ...shared,
    localPage: true,
    clientToken: asTrimmedString(input.clientToken),
    requestHeaders,
    homeDirectory: asTrimmedString(input.homeDirectory),
    relayHostId: asTrimmedString(input.relayHostId),
  };
};
