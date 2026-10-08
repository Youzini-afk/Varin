import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RemoteCredentialStore } from './credential-store-rpc.js';
let store: RemoteCredentialStore | undefined;
/** Standalone launches keep their existing owner; brokered workers never open a second auth store. */
export async function createHostModelRuntime(options: Parameters<typeof ModelRuntime.create>[0] = {}): Promise<ModelRuntime> {
  if (process.env.VARIN_PRIVATE_CREDENTIAL_AUTHORITY !== '1') return ModelRuntime.create(options);
  store ??= new RemoteCredentialStore();
  const credentials = store;
  const runtime = await ModelRuntime.create({ ...options, credentials });
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = ((...args: Parameters<typeof getAuth>) => credentials.refresh(() => getAuth(...args))) as typeof runtime.getAuth;
  return runtime;
}
