export type GateState = 'pending' | 'authenticated' | 'locked' | 'pairing-required' | 'error' | 'rate-limited';

export type RuntimeIdentity = {
  apiBaseUrl: string;
  runtimeKey: string;
};

export const runtimeIdentityMatches = (left: RuntimeIdentity, right: RuntimeIdentity): boolean => {
  return left.apiBaseUrl === right.apiBaseUrl && left.runtimeKey === right.runtimeKey;
};

export const resolveStatusCheckFailureState = (options: {
  shouldUseDesktopShellPasswordLogin?: boolean;
}): Extract<GateState, 'locked' | 'error'> => {
  if (options.shouldUseDesktopShellPasswordLogin) {
    return 'locked';
  }

  return 'error';
};
