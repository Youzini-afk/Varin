import { runtimeFetch, getRuntimeEndpointGeneration } from '@varin/application-client';
export interface ModelTextRequest { key: string; purpose: 'git-commit' | 'review' | 'walkthrough' | 'text'; prompt: string; system?: string; model?: { providerId: string; modelId: string }; maxOutputTokens?: number; responseSchema?: Record<string, unknown> }
export class ModelTextError extends Error {
  constructor(message: string, readonly code: string, readonly requestId?: string) { super(message); this.name = 'ModelTextError'; }
}
export interface ModelTextResult { requestId: string; text: string; providerId: string; modelId: string }
/** Caller retains the original key while an outcome is uncertain. */
export async function generateModelText(input: ModelTextRequest, signal?: AbortSignal): Promise<ModelTextResult> {
  const owner = getRuntimeEndpointGeneration();
  const response = await runtimeFetch('/api/model-text/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const result = await response.json();
  if (owner !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while generating text');
  if (!response.ok) throw new ModelTextError(result.message ?? result.error ?? 'Text generation failed', typeof result.code === 'string' ? result.code : 'model-text-unavailable', typeof result.requestId === 'string' ? result.requestId : undefined);
  if (typeof result.text !== 'string' || typeof result.requestId !== 'string' || typeof result.providerId !== 'string' || typeof result.modelId !== 'string') throw new Error('Text generation returned an invalid result');
  return result;
}
export function parseStructuredGenerationText(text: string): Record<string, unknown> {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The model did not return a JSON object');
  return value as Record<string, unknown>;
}
