interface StartupUrlProbeOptions {
  development: boolean;
  packagedUi: boolean;
  skipLocalServer?: boolean;
}

export const resolveStartupUrlProbePlan = ({ development, packagedUi, skipLocalServer }: StartupUrlProbeOptions) => ({
  probeHmrApi: development === true && packagedUi !== true && skipLocalServer !== true,
  probeHmrUi: development === true && packagedUi !== true,
});

export const shouldIgnoreLoopbackConnectionLimit = ({ development, packagedUi }: StartupUrlProbeOptions) => (
  development !== true || packagedUi === true
);

/** A relay descriptor is not an HTTP endpoint. The trusted bundled renderer owns
 * transport restoration and receives only the profile ID, never a guessed base. */
export function rendererRelayStartup(host: { id: string; url: string; apiUrl?: string; relay?: unknown }, uiUrl: string | null, localAvailable: boolean) {
  if (!host.relay || !uiUrl) return null;
  return { initialUrl: uiUrl, apiBaseUrl: '', clientToken: '', requestHeaders: {}, relayHostId: host.id,
    bootOutcome: { target: 'remote' as const, status: 'relay-pending' as const, hostId: host.id, url: host.url, localAvailable } };
}
