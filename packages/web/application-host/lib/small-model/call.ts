import { sharedHostCredentialAuthority } from '@varin/runtime-broker';
import { resolvePiAgentDir } from '../pi-config/storage.js';
import { readPiConfiguration as readConfig } from '../pi-config/storage.js';
import { getCatalogProvider } from './catalog.js';
import { getAuthEntryForProvider } from './resolve.js';
import type { ModelsMetadata } from '../platform/models-metadata.js';

// Direct, non-streaming text generation against provider APIs using Pi's
// settings, model configuration, and auth store. Credentials never leave this
// process except in the request to their configured provider.

const REQUEST_TIMEOUT_MS = 60_000;
const COPILOT_MODELS_TIMEOUT_MS = 5_000;
// Generous default: thinking models that can't be switched off (DeepSeek,
// Qwen, …) spend part of this budget on reasoning before the actual answer.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

const USER_AGENT = 'varin/0.1';

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

type AuthEntry = Record<string, unknown>;
type AuthStore = Record<string, unknown>;

interface BaseModelCall {
  maxOutputTokens: number;
  modelID: string;
  prompt: string;
  responseSchema?: unknown;
  signal?: AbortSignal | undefined;
  system?: string | undefined;
  timeoutMs?: number | undefined;
}

interface HeaderModelCall extends BaseModelCall {
  headers: Record<string, string>;
  providerLabel: string;
}

interface OpenAiCompatibleCall extends HeaderModelCall {
  baseURL: string;
  extraBody?: Record<string, unknown> | undefined;
}

interface MessagesCall extends HeaderModelCall {
  url: string;
}

interface ApiKeyModelCall extends BaseModelCall {
  apiKey: string;
}

export interface CallSmallModelInput {
  auth: AuthStore;
  catalog: ModelsMetadata;
  maxOutputTokens?: unknown;
  modelID: string;
  prompt: string;
  providerID: string;
  responseSchema?: unknown;
  signal?: AbortSignal | undefined;
  system?: string | undefined;
  timeoutMs?: number | undefined;
  workingDirectory?: string | undefined;
}

interface ProviderConfig {
  auth: AuthEntry | null;
  baseURL: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const asString = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

const httpError = async (response: Response, provider: string): Promise<Error & { provider: string; status: number }> => {
  const body = await response.text().catch(() => '');
  const snippet = body ? `: ${body.slice(0, 300)}` : '';
  return Object.assign(new Error(`${provider} request failed with ${response.status}${snippet}`), {
    status: response.status,
    provider,
  });
};

const requestSignal = (timeoutMs?: number, signal?: AbortSignal): AbortSignal => {
  const deadline = AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
};

const STRUCTURED_OUTPUT_NAME = 'response';
const GOOGLE_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'definitions',
  '$defs',
  '$ref',
  'strict',
]);

const toGoogleSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(toGoogleSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GOOGLE_UNSUPPORTED_SCHEMA_KEYS.has(key)) result[key] = toGoogleSchema(value);
  }
  return result;
};

// ---------------------------------------------------------------------------
// OpenAI OAuth (ChatGPT plan / Codex) token refresh is single-flight, with the
// refreshed token persisted back into Pi's auth.json.
// ---------------------------------------------------------------------------



const decodeJwtClaims = (token: string): Record<string, unknown> | null => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
  } catch {
    return null;
  }
};

const extractChatgptAccountId = (accessToken: string): string | null => {
  const claims = decodeJwtClaims(accessToken);
  const auth = asRecord(claims?.['https://api.openai.com/auth']);
  const value = auth?.chatgpt_account_id;
  return typeof value === 'string' && value ? value : null;
};

const refreshOpenaiOauth = async (_entry: AuthEntry): Promise<AuthEntry> => {
  const owner = sharedHostCredentialAuthority(resolvePiAgentDir());
  const result = await owner.modifyWithIntent('openai', 'refresh', async current => {
    if (current?.type !== 'oauth') throw new Error('OpenAI OAuth credential is no longer selected');
    if (current.access && current.expires > Date.now()) return undefined;
    const response = await fetch(CODEX_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: current.refresh, client_id: CODEX_CLIENT_ID }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('OpenAI token refresh failed');
    const payload = asRecord(await response.json()) ?? {};
    const access = asString(payload.access_token);
    const expiresIn = Number(payload.expires_in);
    if (!access || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('OpenAI token refresh returned invalid credentials');
    return { ...current, type: 'oauth' as const, access,
      refresh: asString(payload.refresh_token) ?? current.refresh, expires: Date.now() + expiresIn * 1000 };
  });
  if (!result) throw new Error('OpenAI OAuth credential is unavailable');
  return result as AuthEntry;
};

const ensureFreshOpenaiOauth = async (entry: AuthEntry): Promise<AuthEntry> => {
  if (typeof entry.access === 'string' && entry.access && Number(entry.expires) > Date.now()) {
    return entry;
  }
  if (!entry.refresh) {
    throw new Error('OpenAI OAuth entry has no refresh token');
  }
  return refreshOpenaiOauth(entry);
};

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

const callOpenaiCompatible = async ({ baseURL, headers, modelID, prompt, system, maxOutputTokens, providerLabel, extraBody, responseSchema, timeoutMs, signal }: OpenAiCompatibleCall): Promise<string> => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  console.log('[small-model:diagnostic] request', {
    provider: providerLabel,
    model: modelID,
    maxOutputTokens,
    thinkingDisabled: asRecord(extraBody?.thinking)?.type === 'disabled',
    promptChars: prompt.length,
    systemChars: system?.length ?? 0,
    inputChars: prompt.length + (system?.length ?? 0),
  });
  const response = await fetch(`${trimmedBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: maxOutputTokens,
      stream: false,
      ...(responseSchema
        ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: STRUCTURED_OUTPUT_NAME, strict: true, schema: responseSchema },
          },
        }
        : {}),
      ...(extraBody || {}),
    }),
    signal: requestSignal(timeoutMs, signal),
  });
  console.log('[small-model:diagnostic] response', {
    provider: providerLabel,
    model: modelID,
    httpStatus: response.status,
    ok: response.ok,
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = asRecord(await response.json()) ?? {};
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  console.log('[small-model:diagnostic] completion', {
    provider: providerLabel,
    model: modelID,
    finishReason: firstChoice?.finish_reason ?? null,
    contentType: Array.isArray(message?.content) ? 'parts' : typeof message?.content,
    contentChars: typeof message?.content === 'string'
      ? message.content.length
      : Array.isArray(message?.content)
        ? message.content.reduce((total, part) => total + (typeof part?.text === 'string' ? part.text.length : 0), 0)
        : 0,
    reasoningChars: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
  });

  // Providers disagree on the content shape: plain string, an array of
  // typed parts, or (thinking models) an empty content with the budget spent
  // on reasoning_content.
  let text = '';
  if (typeof message?.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  const finishReason = firstChoice?.finish_reason;
  if (!text.trim() && (finishReason === 'length' || (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()))) {
    throw Object.assign(
      new Error(
        `${providerLabel} spent the output budget on reasoning and returned no answer`
        + (finishReason ? ` (finish_reason: ${finishReason})` : ''),
      ),
      { code: 'output-exhausted', provider: providerLabel },
    );
  }
  if (!text.trim()) {
    throw new Error(`${providerLabel} returned no message content`);
  }
  return text;
};

const callOpenaiResponses = async ({ baseURL, headers, modelID, prompt, system, maxOutputTokens, providerLabel, responseSchema, timeoutMs, signal }: HeaderModelCall & { baseURL: string }): Promise<string> => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  const response = await fetch(`${trimmedBase}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      ...(system ? { instructions: system } : {}),
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }],
      max_output_tokens: maxOutputTokens,
      ...(responseSchema
        ? {
          text: {
            format: {
              type: 'json_schema',
              name: STRUCTURED_OUTPUT_NAME,
              strict: true,
              schema: responseSchema,
            },
          },
        }
        : {}),
      stream: false,
      store: false,
    }),
    signal: requestSignal(timeoutMs, signal),
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = asRecord(await response.json()) ?? {};
  const text = typeof payload?.output_text === 'string'
    ? payload.output_text
    : Array.isArray(payload?.output)
      ? payload.output
        .flatMap((item) => {
          const record = asRecord(item);
          return Array.isArray(record?.content) ? record.content : [];
        })
        .map((part) => {
          const record = asRecord(part);
          return record?.type === 'output_text' && typeof record.text === 'string' ? record.text : '';
        })
        .join('')
      : '';
  if (!text.trim()) {
    throw new Error(`${providerLabel} returned no text output`);
  }
  return text;
};

const callMessages = async ({ url, headers, modelID, prompt, system, maxOutputTokens, providerLabel, responseSchema, timeoutMs, signal }: MessagesCall): Promise<string> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      max_tokens: maxOutputTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      ...(responseSchema
        ? {
          tools: [{
            name: STRUCTURED_OUTPUT_NAME,
            description: 'Return the answer in the required structure.',
            input_schema: responseSchema,
          }],
          tool_choice: { type: 'tool', name: STRUCTURED_OUTPUT_NAME },
        }
        : {}),
    }),
    signal: requestSignal(timeoutMs, signal),
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = asRecord(await response.json()) ?? {};
  const content = Array.isArray(payload.content)
    ? payload.content.map(asRecord).filter((part): part is Record<string, unknown> => Boolean(part))
    : [];
  if (responseSchema) {
    const toolUse = content.find(
      (part) => part?.type === 'tool_use' && part.name === STRUCTURED_OUTPUT_NAME,
    );
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
      throw new Error(`${providerLabel} returned no structured output`);
    }
    return JSON.stringify(toolUse.input);
  }
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text) {
    throw new Error(`${providerLabel} returned no text content`);
  }
  return text;
};

const callAnthropic = async ({ apiKey, modelID, prompt, system, maxOutputTokens, responseSchema, timeoutMs, signal }: ApiKeyModelCall) => callMessages({
  url: 'https://api.anthropic.com/v1/messages',
  headers: {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  modelID,
  prompt,
  system,
  maxOutputTokens,
  providerLabel: 'Anthropic',
  responseSchema,
  timeoutMs,
  signal,
});

const getCopilotEndpoint = async ({ baseURL, headers, modelID }: {
  baseURL: string;
  headers: Record<string, string>;
  modelID: string;
}): Promise<'chat' | 'messages' | 'responses'> => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  const response = await fetch(`${trimmedBase}/models`, {
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(COPILOT_MODELS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'GitHub Copilot models');
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(await response.json());
  } catch {
    throw new Error('GitHub Copilot models returned invalid JSON');
  }
  if (!Array.isArray(payload?.data)) {
    throw new Error('GitHub Copilot models returned an invalid model list');
  }

  const model = payload.data.map(asRecord).find((item) => item?.id === modelID);
  if (!model) {
    throw new Error(`GitHub Copilot model "${modelID}" was not returned by /models`);
  }
  if (model.supported_endpoints === undefined) {
    return 'chat';
  }
  if (!Array.isArray(model.supported_endpoints)) {
    throw new Error(`GitHub Copilot model "${modelID}" returned invalid endpoint metadata`);
  }
  if (model.supported_endpoints.includes('/v1/messages')) {
    return 'messages';
  }
  if (model.supported_endpoints.includes('/responses')) {
    return 'responses';
  }
  if (model.supported_endpoints.includes('/chat/completions')) {
    return 'chat';
  }
  throw new Error(`GitHub Copilot model "${modelID}" has no supported text endpoint`);
};

const callGoogle = async ({ apiKey, modelID, prompt, system, maxOutputTokens, responseSchema, timeoutMs, signal }: ApiKeyModelCall): Promise<string> => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelID)}:generateContent`;
  const thinkingConfig = modelID.toLowerCase().startsWith('gemini-3')
    ? { thinkingLevel: modelID.toLowerCase().includes('flash') ? 'minimal' : 'low' }
    : { thinkingBudget: 0 };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        maxOutputTokens,
        thinkingConfig,
        ...(responseSchema
          ? { responseMimeType: 'application/json', responseSchema: toGoogleSchema(responseSchema) }
          : {}),
      },
    }),
    signal: requestSignal(timeoutMs, signal),
  });
  if (!response.ok) {
    throw await httpError(response, 'Google');
  }
  const payload = asRecord(await response.json()) ?? {};
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .join('');
  if (!text) {
    throw new Error('Google returned no text content');
  }
  return text;
};

// ChatGPT-plan traffic goes to the codex backend, which only speaks the
// streaming Responses API — collect the output_text deltas from the SSE body.
const callCodexResponses = async ({ accessToken, accountId, modelID, prompt, system, timeoutMs, signal }: {
  accessToken: string;
  accountId: string | null;
  modelID: string;
  prompt: string;
  signal?: AbortSignal | undefined;
  system?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<string> => {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      originator: 'varin',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: modelID,
      ...(system ? { instructions: system } : {}),
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
      // The Codex backend rejects max_output_tokens for subscription traffic.
      stream: true,
      store: false,
    }),
    signal: requestSignal(timeoutMs, signal),
  });
  if (!response.ok) {
    throw await httpError(response, 'OpenAI (ChatGPT plan)');
  }

  const raw = await response.text();
  let text = '';
  let completedText = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(data) as unknown);
    } catch {
      continue;
    }
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    }
    if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
      completedText = event.text;
    }
    if (event?.type === 'response.failed' || event?.type === 'error') {
      const responseRecord = asRecord(event?.response);
      const responseError = asRecord(responseRecord?.error);
      const message = asString(responseError?.message) || asString(event?.message) || 'response failed';
      throw new Error(`OpenAI (ChatGPT plan) stream error: ${message}`);
    }
  }
  const result = completedText || text;
  if (!result) {
    throw new Error('OpenAI (ChatGPT plan) returned no text output');
  }
  return result;
};

// ---------------------------------------------------------------------------
// Custom provider configuration support
// ---------------------------------------------------------------------------

const resolveConfigApiKey = (value: string): string | null => {
  if (value.startsWith('$$')) return value.slice(1);
  if (value.startsWith('$!')) return value.slice(1);
  if (value.startsWith('!')) return null;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => (
    process.env[braced || plain] || ''
  ));
  return expanded.trim() || null;
};

const readProviderConfig = (workingDirectory: string | undefined, providerID: string): ProviderConfig | null => {
  try {
    const config = readConfig(workingDirectory);
    const providers = asRecord(config.providers);
    const providerCfg = asRecord(providers?.[providerID]);
    if (!providerCfg) return null;
    const baseURL = typeof providerCfg.baseUrl === 'string' ? providerCfg.baseUrl.trim() : null;
    const rawApiKey = typeof providerCfg.apiKey === 'string' ? providerCfg.apiKey.trim() : null;
    const apiKey = rawApiKey ? resolveConfigApiKey(rawApiKey) : null;
    return {
      baseURL,
      // Treat a provider-configured key like a regular Pi API-key credential.
      auth: apiKey ? { type: 'api_key', key: apiKey } : null,
    };
  } catch {
    // Provider config is non-essential — continue with catalog-only resolution.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function resolveProviderLogin({ auth, workingDirectory, providerID }: {
  auth: AuthStore;
  providerID: string;
  workingDirectory?: string | undefined;
}): AuthEntry | null {
  const providerConfig = readProviderConfig(workingDirectory, providerID);
  return providerConfig?.auth || getAuthEntryForProvider(auth, providerID) || null;
}

export async function callSmallModel({ auth, catalog, workingDirectory, providerID, modelID, prompt, system, maxOutputTokens, responseSchema, timeoutMs, signal }: CallSmallModelInput): Promise<string> {
  const tokens = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS;
  const providerConfig = readProviderConfig(workingDirectory, providerID);
  // Pi's provider-specific models.json key takes precedence over auth.json.
  const entry = providerConfig?.auth || getAuthEntryForProvider(auth, providerID);
  if (!entry) {
    throw Object.assign(new Error(`No Pi credential found for provider "${providerID}"`), {
      statusCode: 401,
      code: 'no-provider-login',
      providerID,
    });
  }

  if (providerID === 'github-copilot') {
    // Copilot stores the device OAuth token as the bearer; no token exchange
    // is required for model calls.
    const token = asString(entry.refresh) || asString(entry.access) || asString(entry.key);
    if (!token) {
      throw new Error('GitHub Copilot login has no token');
    }
    const enterpriseDomain = asString(entry.enterpriseDomain) || asString(entry.enterpriseUrl);
    const baseURL = enterpriseDomain
      ? `https://copilot-api.${String(enterpriseDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
      : 'https://api.githubcopilot.com';
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2026-06-01',
    };
    const headers = {
      ...authHeaders,
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'agent',
    };
    const endpoint = await getCopilotEndpoint({
      baseURL,
      headers: authHeaders,
      modelID,
    });
    const request = {
      baseURL,
      headers,
      modelID,
      prompt,
      system,
      maxOutputTokens: tokens,
      providerLabel: 'GitHub Copilot',
      responseSchema,
      timeoutMs,
      signal,
    };
    if (endpoint === 'messages') {
      return callMessages({
        ...request,
        url: `${baseURL.replace(/\/+$/, '')}/v1/messages`,
        headers: {
          ...headers,
          'anthropic-version': '2023-06-01',
        },
      });
    }
    if (endpoint === 'responses') {
      return callOpenaiResponses(request);
    }
    return callOpenaiCompatible(request);
  }

  if (providerID === 'openai' && entry.type === 'oauth') {
    if (responseSchema) {
      throw Object.assign(
        new Error('The ChatGPT-plan OpenAI login does not support structured output — choose another small model'),
        { code: 'structured-output-unsupported' },
      );
    }
    const fresh = await ensureFreshOpenaiOauth(entry);
    const accessToken = asString(fresh.access);
    if (!accessToken) throw new Error('OpenAI OAuth refresh returned no access token');
    return callCodexResponses({
      accessToken,
      accountId: asString(fresh.accountId) || extractChatgptAccountId(accessToken),
      modelID,
      prompt,
      system,
      timeoutMs,
      signal,
    });
  }

  const apiKey = entry.type === 'api_key' ? asString(entry.key) : asString(entry.access);
  if (!apiKey) {
    throw new Error(`Pi credential for "${providerID}" has no usable key`);
  }

  if (providerID === 'anthropic') {
    return callAnthropic({ apiKey, modelID, prompt, system, maxOutputTokens: tokens, responseSchema, timeoutMs, signal });
  }
  if (providerID === 'google') {
    return callGoogle({ apiKey, modelID, prompt, system, maxOutputTokens: tokens, responseSchema, timeoutMs, signal });
  }

  // Everything else uses OpenAI-compatible chat completions. A custom Pi
  // provider may supply its own baseUrl even when it is absent from the public
  // model catalog.
  const provider = getCatalogProvider(catalog, providerID);
  const providerConfigUrl = providerConfig?.baseURL;
  const defaultOpenaiUrl = 'https://api.openai.com/v1';
  const baseURL = typeof providerConfigUrl === 'string' && providerConfigUrl
    ? providerConfigUrl
    : providerID === 'openai'
      ? defaultOpenaiUrl
      : typeof provider?.api === 'string' && provider.api
        ? provider.api
        : null;
  if (!baseURL) {
    throw new Error(`Provider "${providerID}" has no known API base URL`);
  }

  // Thinking models can exhaust the output budget before returning content.
  // Disable thinking only where a known wire-format switch exists because
  // several providers reject unknown body fields.
  const lowerModel = modelID.toLowerCase();
  const supportsThinkingToggle = providerID.includes('zai')
    || providerID.includes('zhipu')
    || lowerModel.includes('glm')
    || lowerModel.includes('minimax-m3');
  const extraBody = supportsThinkingToggle ? { thinking: { type: 'disabled' } } : undefined;

  return callOpenaiCompatible({
    baseURL,
    headers: { Authorization: `Bearer ${apiKey}` },
    modelID,
    prompt,
    system,
    maxOutputTokens: tokens,
    providerLabel: asString(provider?.name) || providerID,
    extraBody,
    responseSchema,
    timeoutMs,
    signal,
  });
}
