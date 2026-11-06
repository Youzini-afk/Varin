import publicClient from '../public-client.json' with { type: 'json' };

// Deployment-owned settings. Never accept these from a Surface, tool argument or email.
// A publisher must provision its own Google-verified application; no credentials are shipped here.
export function publisherClient(env = process.env, bundled = publicClient) {
  if (!bundled || typeof bundled !== 'object' || Array.isArray(bundled)
    || Object.keys(bundled).some(key => key !== 'client_id')) throw new Error('The Gmail public client configuration is invalid');
  const id = env.VARIN_GMAIL_PUBLISHER_CLIENT_ID ?? bundled.client_id ?? undefined;
  const secret = env.VARIN_GMAIL_PUBLISHER_CLIENT_SECRET;
  if (id === undefined && secret === undefined) return null;
  // This is a deployment assertion, not an identity boundary. Never silently enable the
  // shared client on a Host that has not been provisioned for exactly one isolated OS user.
  if (env.VARIN_GMAIL_ISOLATED_HOST !== '1') {
    throw new Error('Publisher Gmail login requires an isolated single-user Host');
  }
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.apps\.googleusercontent\.com$/iu.test(id)
    || typeof secret !== 'string' || !secret || /\s/u.test(secret)) {
    throw new Error('The Gmail publisher OAuth client is not configured correctly');
  }
  return { kind: 'publisher', client_id: id, client_secret: secret };
}
