# Provider connections and inference capabilities

Status: implemented. Native Pi remains the provider/auth authority.

`provider-configuration.ts` reads and writes the existing Pi `models.json` provider entries.
Native `api`, `models`, `modelOverrides`, credentials, headers and extension registrations keep
their existing owners. Varin's optional `capabilities` field declares additional operation-specific
connections and model suggestions; it never registers an embedding, reranking or decision model
as a chat model or installs a pretend streaming API.

## Configuration

```json
{
  "providers": {
    "typesafe": {
      "name": "TypeSafe",
      "baseUrl": "https://api.example.com",
      "models": [],
      "capabilities": {
        "chat": false,
        "decision": {
          "protocol": "typesafe-systemone",
          "endpoint": "/v1/systemone",
          "models": [{ "id": "jev-1.13", "name": "Jev" }]
        }
      }
    }
  }
}
```

The common provider address and Pi credential owner are defaults. Each inference capability can
override `baseUrl`, `endpoint` and `credentialRef`; the latter names another Pi provider's credential
owner, not a copied key. A capability model can also retain its own `baseUrl`. Model definitions are
suggestions for the relevant Harness picker; an operator can explicitly enter an undiscovered ID.
The same ID can occur in several capabilities. Duplicate IDs inside one capability are rejected.

| Capability | Protocol | Default request path | Result |
| --- | --- | --- | --- |
| embedding | `openai-compatible` | `/embeddings` | Ordered vectors |
| rerank | `http-rerank` | `/rerank` | Scores mapped to submitted material IDs |
| decision | `typesafe-systemone` | `/v1/systemone` | Judge / choose / score answers |

Protocol selection is independent of the native chat `api`. A pure inference provider can have no
chat API and no chat model definitions. `chat: false` suppresses its native chat catalog after all
configuration layers are composed. Existing native model definitions are retained on disk; enabling
chat again restores them. An inference capability's `enabled: false` likewise retains its connection
and models while rejecting new inference calls. An absent capability is undeclared, rather than
evidence that an existing provider cannot serve that operation.

## Ownership and bindings

Native chat configuration uses user < trusted project < operator precedence. Background inference
uses only user < operator capability declarations and connection settings. Project capability
metadata cannot redirect its endpoints, choose its credential reference or contribute auth headers.
The UI's `ProviderConfigDetails.capabilities` catalog uses that same project-free resolution; its
`config` field remains the raw editable layer. Non-persistent runtime credentials can be reused, while
configured credentials and headers are resolved through the project-free Pi runtime.

Harness settings still choose provider/model per operation and retain fast-decision default,
purpose overrides and explicit off choices. An explicit Harness rerank/decision endpoint overrides
the capability endpoint; otherwise the capability endpoint, then adapter default, applies. The
resolved endpoint appears in the credential-free binding returned by `describe`. Embedding capability
endpoint changes participate in its configuration/vector-space identity. Changing a chat API does
not invalidate an explicitly declared embedding connection, and rotating a key does not change its
vector space.

## Verification boundaries

Focused tests use the actual Pi `ModelRuntime`, native configuration layering and credential storage,
with controlled provider responses. They cover pure inference registration, three independent
request shapes/endpoints, credential references, project isolation, binding changes, disabling and
restoring capabilities. UI checks cover serialization, translation parity and a pending manual model
input not overwriting a newer declared-model choice. These do not establish live provider availability
or model quality; no paid inference request is needed for these checks.
