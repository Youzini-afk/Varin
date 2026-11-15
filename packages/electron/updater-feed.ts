export type UpdaterFeed = {
  owner: string;
  provider: 'github';
  repo: string;
} | {
  provider: 'generic';
  url: string;
};

export const PRODUCTION_UPDATER_FEED: Readonly<UpdaterFeed> = Object.freeze({
  provider: 'github',
  owner: 'Astrmira',
  repo: 'Varin',
});

const isLoopbackHostname = (hostname: string): boolean => {
  if (hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value <= 255);
};

export const parseLoopbackUpdaterUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLoopbackHostname(url.hostname)
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const resolveUpdaterFeed = ({
  environment = process.env,
  testBuild = false,
}: {
  environment?: NodeJS.ProcessEnv;
  testBuild?: boolean;
} = {}): Readonly<UpdaterFeed> => {
  if (environment.VARIN_E2E !== '1'
    || testBuild !== true) {
    return PRODUCTION_UPDATER_FEED;
  }

  const url = parseLoopbackUpdaterUrl(environment.VARIN_UPDATER_E2E_URL);
  if (!url) return PRODUCTION_UPDATER_FEED;
  return { provider: 'generic', url };
};
