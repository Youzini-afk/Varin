/** Google ADC remains owned by Google's credential client; no copied credential store. */
import { createHash, randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface GoogleAuthClient { getRequestHeaders(): Promise<Headers> }
interface GoogleAuthModule { GoogleAuth: new (options: { scopes: string[]; keyFilename?: string }) => GoogleAuthClient }
export interface GoogleCredentialSource { identity: string; keyFilename?: string }
let modulePromise: Promise<GoogleAuthModule> | undefined;
function googleAuthLibrary(): Promise<GoogleAuthModule> {
  // Resolve from the locked SDK's own dependency graph, also for a selected external SDK.
  const ai = createRequire(import.meta.resolve('@earendil-works/pi-ai'));
  const genai = createRequire(ai.resolve('@google/genai'));
  modulePromise ??= import(pathToFileURL(genai.resolve('google-auth-library')).href) as Promise<GoogleAuthModule>;
  return modulePromise;
}
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export class NativeGoogleCredentialOwner {
  readonly #ambientIdentity = randomUUID();
  readonly #clients = new Map<string, Promise<GoogleAuthClient>>();
  async source(env?: Record<string, string>): Promise<GoogleCredentialSource> {
    const explicit = env?.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS
      || process.env.google_application_credentials;
    const config = process.env.CLOUDSDK_CONFIG || (process.platform === 'win32'
      ? process.env.APPDATA && join(process.env.APPDATA, 'gcloud')
      : process.env.HOME && join(process.env.HOME, '.config', 'gcloud'));
    const path = explicit || (config && join(config, 'application_default_credentials.json'));
    if (path) {
      try {
        const keyFilename = await realpath(resolve(path));
        const info = await stat(keyFilename, { bigint: true });
        // Filesystem identity, not credential content or token-derived identity.
        const identity = createHash('sha256').update([keyFilename, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')).digest('hex');
        return { identity, keyFilename };
      } catch (error) {
        if (explicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('google-credential-source-unavailable');
      }
    }
    // Metadata-service ADC has no file revision. A new Host must explicitly rebind it.
    return { identity: this.#ambientIdentity };
  }
  async headers(source: GoogleCredentialSource): Promise<Record<string, string>> {
    let pending = this.#clients.get(source.identity);
    if (!pending) {
      pending = googleAuthLibrary().then(({ GoogleAuth }) => new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...(source.keyFilename ? { keyFilename: source.keyFilename } : {}),
      }));
      this.#clients.set(source.identity, pending);
    }
    try {
      const headers = await (await pending).getRequestHeaders();
      const values: Record<string, string> = Object.create(null);
      headers.forEach((value, name) => { values[name] = value; });
      if (!values.authorization) return fail('google-credential-token-missing');
      return values;
    } catch { return fail('google-credential-resolution-failed'); }
  }
}
