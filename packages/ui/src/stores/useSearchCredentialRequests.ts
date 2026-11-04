import { create } from 'zustand';
import { getRuntimeEndpointGeneration, searchCredentialRequest, subscribeRuntimeEndpointChanged, type SearchCredentialRequest } from '@varin/application-client';

/** Only presentation requests live here. The key stays in the dialog's local input. */
export const useSearchCredentialRequests = create<{ requests: SearchCredentialRequest[]; credentialRevision: number }>(() => ({ requests: [], credentialRevision: 0 }));
export async function openSearchCredentialRequest(id: string) {
  const generation = getRuntimeEndpointGeneration();
  const value = await searchCredentialRequest(id);
  if (generation !== getRuntimeEndpointGeneration()) throw new Error('The selected Host changed.');
  if (value.status !== 'pending') throw new Error('Credential entry is no longer pending.');
  useSearchCredentialRequests.setState(state => ({ requests: state.requests.some(request => request.id === id) ? state.requests : [...state.requests, value] }));
}
export function dismissSearchCredentialRequest(id: string) {
  useSearchCredentialRequests.setState(state => ({ requests: state.requests.filter(request => request.id !== id) }));
}
export function searchCredentialChanged(properties: Record<string, unknown>) {
  useSearchCredentialRequests.setState(state => ({
    credentialRevision: state.credentialRevision + (typeof properties.connectionId === 'string' ? 1 : 0),
    requests: state.requests.flatMap(request => {
      if (request.id !== properties.requestId) return [request];
      if (properties.status === 'completed' || properties.status === 'cancelled' || properties.status === 'failed') return [{ ...request, status: properties.status }];
      return [request];
    }),
  }));
}
subscribeRuntimeEndpointChanged(() => useSearchCredentialRequests.setState({ requests: [] }));
