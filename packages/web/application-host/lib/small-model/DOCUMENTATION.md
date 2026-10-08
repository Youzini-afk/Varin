# Small model utility calls

This Host module makes short, direct provider calls for conversation titles and goal progress audits.
It uses Pi configuration and credentials through `../pi-config/storage.ts`; it does not read an
OpenCode auth store or run a second agent runtime.

## Ownership and credentials

- `index.ts` owns `generateSmallModelText()` and `describeSmallModel()`, input/output budgets,
  request cancellation, and the Varin small-model settings override.
- `resolve.ts` selects the model. An explicit request model wins, followed by the Varin override,
  Pi's `smallModel` setting, then authenticated utility-model candidates. With session context,
  resolution prefers that provider and can fall back to the session model.
- `call.ts` resolves the configured provider connection, handles provider-specific requests and
  OAuth refresh, and returns text. A Pi `models.json` provider key takes precedence over its
  `auth.json` entry. Configured keys support environment-variable expansion; this utility adapter
  does not execute command-valued keys.
- `catalog.ts` reads the shared models.dev metadata cache from `../platform/models-metadata.ts`.
- `routes.ts` exposes authenticated `GET /api/small-model` and `POST /api/small-model/generate`.

The Pi agent directory comes from `VARIN_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, otherwise
`~/.pi/agent`. User and project `settings.json`/`models.json` are read through the Pi storage helper.
The Varin override is stored in `settings.json` under the platform's Varin data directory.
Credentials stay on the Host except when authorizing requests to their configured provider;
renderer metadata must not include them.

`restrictToPreferredProvider` prevents an implicit fallback to another provider. An explicit
request, Varin settings override, or Pi small-model setting remains an intentional selection and
can name a different provider. A caller must not promise that utility calls always use the exact
session model.

## Provider adapter boundaries

The utility adapter supports GitHub Copilot endpoint discovery, the ChatGPT-plan OpenAI OAuth
Responses path, Anthropic and Google request formats, and an OpenAI-compatible fallback using the
configured `providers.<id>.baseUrl`. OAuth refresh is single-flight and persists to the Pi auth
store. This direct-call adapter is narrower than Pi's complete provider runtime: do not infer
support for every Pi credential chain or model protocol from the main chat catalog.

Copilot metadata and endpoint errors remain errors rather than guessed success. The ChatGPT-plan
adapter rejects structured-output requests. Other structured-output support follows the adapter's
actual request format; callers must handle unsupported or malformed results.

## Budgets and failures

Input size is estimated from catalog context limits with an output reserve, or a conservative
fallback when metadata is missing. The default overflow behavior truncates the prompt and reports
`inputTruncated`; callers can request `onOverflow: 'error'` for a `413` instead. System text is part
of the same budget. Provider timeouts and cancellation propagate to the request.

No resolved model yields `404`; a selected provider without a usable credential fails rather than
using an unrelated login. Structural diagnostics may include provider/model identifiers and sizes,
but must not log prompts, generated text, or credentials.

## Verification

Run the focused source suite through the Web package's Vitest command:

```sh
bun run --cwd packages/web test application-host/lib/small-model
```

These tests establish selection, serialization and error behavior with controlled responses.
They do not establish live provider availability, model quality, or subscription eligibility.
