import type { MobileLayoutPreference } from '@varin/ui/lib/mobileLayoutPreference';
import type { HostedSurface } from '@varin/ui/lib/runtimeSurface';

export type HostedSurfaceDetectionInput = {
  search: string;
  innerWidth: number;
  screenWidth: number;
  maxTouchPoints: number;
  isCoarsePointer: boolean;
  mobileLayoutPreference: MobileLayoutPreference;
};

const EMBEDDED_SESSION_CHAT_PANEL = 'session-chat';

export const detectHostedSurface = ({
  search,
  innerWidth,
  screenWidth,
  maxTouchPoints,
  isCoarsePointer,
  mobileLayoutPreference,
}: HostedSurfaceDetectionInput): HostedSurface => {
  const params = new URLSearchParams(search);

  if (params.get('panel') === EMBEDDED_SESSION_CHAT_PANEL) {
    return 'desktop';
  }

  const override = params.get('surface');
  if (override === 'mobile') return 'mobile';
  if (override === 'desktop') return 'desktop';

  const width = Math.min(innerWidth || 0, screenWidth || innerWidth || 0);
  const hasTouchInput = maxTouchPoints > 0 || isCoarsePointer;
  const likelyPhone = width > 0 && width <= 760 && hasTouchInput;
  const likelyTablet = width > 760 && width <= 1366 && isCoarsePointer;
  return (likelyPhone || likelyTablet) && mobileLayoutPreference === 'new' ? 'mobile' : 'desktop';
};
