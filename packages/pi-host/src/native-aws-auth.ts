/** AWS credentials remain in the existing SDK chain; native requests are signed at dispatch. */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NativeCredentialDispatch { method: string; endpoint: string; payloadSha256: string }
interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
interface AwsClient {
  config: { credentials: () => Promise<AwsCredentials>; region: () => Promise<string>; sha256: unknown };
}
interface AwsModule { BedrockRuntimeClient: new (options: Record<string, unknown>) => AwsClient }
interface SigningModule { SignatureV4: new (options: Record<string, unknown>) => { sign(request: Record<string, unknown>): Promise<{ headers: Record<string, string> }> } }
interface Source { identity: string; client: Promise<AwsClient> }
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
let modules: Promise<{ client: AwsModule; signer: SigningModule }> | undefined;
function libraries() {
  if (!modules) {
    const ai = createRequire(import.meta.resolve('@earendil-works/pi-ai'));
    const entry = ai.resolve('@aws-sdk/client-bedrock-runtime');
    const aws = createRequire(entry);
    const core = createRequire(aws.resolve('@aws-sdk/core'));
    modules = Promise.all([import(pathToFileURL(entry).href), import(pathToFileURL(core.resolve('@smithy/signature-v4')).href)])
      .then(([client, signer]) => ({ client: client as AwsModule, signer: signer as SigningModule }));
  }
  return modules;
}
export class NativeAwsCredentialOwner {
  readonly #sources = new Map<string, { value: string; source: Source }>();
  async source(providerId: string, env?: Record<string, string>): Promise<Source> {
    const names = ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_EC2_METADATA_DISABLED'];
    const values: Record<string, string> = Object.create(null);
    for (const name of names) { const value = env?.[name] || process.env[name]; if (value) values[name] = value; }
    const revisions: string[] = [];
    for (const file of [values.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials'),
      values.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config')]) {
      try {
        const info = await stat(file, { bigint: true });
        revisions.push([file, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('aws-credential-source-unavailable'); }
    }
    // Secret source inputs are compared only in memory. SDK-issued temporary credentials do
    // not change this binding when the SDK refreshes them. Restart requires fresh selection.
    const value = JSON.stringify({ values, revisions });
    const old = this.#sources.get(providerId);
    if (old?.value === value) return old.source;
    const source: Source = { identity: randomUUID(), client: libraries().then(({ client }) => {
      const explicitProfile = env?.AWS_PROFILE;
      const credentials = values.AWS_ACCESS_KEY_ID && values.AWS_SECRET_ACCESS_KEY && !explicitProfile
        ? { accessKeyId: values.AWS_ACCESS_KEY_ID, secretAccessKey: values.AWS_SECRET_ACCESS_KEY,
          ...(values.AWS_SESSION_TOKEN ? { sessionToken: values.AWS_SESSION_TOKEN } : {}) } : undefined;
      const region = values.AWS_REGION || values.AWS_DEFAULT_REGION || (!values.AWS_PROFILE ? 'us-east-1' : undefined);
      return new client.BedrockRuntimeClient({ ...(values.AWS_PROFILE ? { profile: values.AWS_PROFILE } : {}),
        ...(region ? { region } : {}), ...(credentials ? { credentials } : {}),
        ...(values.AWS_SHARED_CREDENTIALS_FILE ? { filepath: values.AWS_SHARED_CREDENTIALS_FILE } : {}),
        ...(values.AWS_CONFIG_FILE ? { configFilepath: values.AWS_CONFIG_FILE } : {}),
        ...(values.AWS_WEB_IDENTITY_TOKEN_FILE ? { webIdentityTokenFile: values.AWS_WEB_IDENTITY_TOKEN_FILE } : {}),
        ...(values.AWS_ROLE_ARN ? { roleArn: values.AWS_ROLE_ARN } : {}),
        ...(values.AWS_ROLE_SESSION_NAME ? { roleSessionName: values.AWS_ROLE_SESSION_NAME } : {}) });
    }) };
    this.#sources.set(providerId, { value, source });
    return source;
  }
  async region(source: Source): Promise<string> {
    try { return await (await source.client).config.region(); }
    catch { return fail('aws-region-unavailable'); }
  }
  async sign(source: Source, dispatch: NativeCredentialDispatch, headers: Record<string, string>, selectedRegion?: string): Promise<Record<string, string>> {
    try {
      if (typeof dispatch.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dispatch.payloadSha256)) return fail('aws-request-payload-invalid');
      const client = await source.client;
      const url = new URL(dispatch.endpoint);
      const endpointRegion = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(url.hostname)?.[1];
      const region = selectedRegion || endpointRegion || await client.config.region();
      const { signer } = await libraries();
      const signing = new signer.SignatureV4({ credentials: client.config.credentials, region, service: 'bedrock', sha256: client.config.sha256 });
      const query: Record<string, string[]> = Object.create(null);
      for (const [name, value] of url.searchParams) (query[name] ??= []).push(value);
      // Smithy's getPayloadHash uses this header verbatim. It is computed by the trusted
      // native serializer; configured case variants must not shadow the frozen payload hash.
      const signingHeaders = Object.fromEntries(Object.entries(headers)
        .filter(([name]) => name.toLowerCase() !== 'x-amz-content-sha256'));
      const signed = await signing.sign({ method: dispatch.method, protocol: url.protocol, hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}), path: url.pathname, query,
        headers: { ...signingHeaders, host: url.host, 'content-type': 'application/json',
          accept: 'application/vnd.amazon.eventstream', 'x-amz-content-sha256': dispatch.payloadSha256 } });
      return signed.headers;
    } catch { return fail('aws-credential-signing-failed'); }
  }
}
