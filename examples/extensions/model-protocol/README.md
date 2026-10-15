# Model protocol example

This brokered `varin.models@1` provider contributes a channel type, read-only model candidates and
an actual custom text/SSE codec. Its request has `engine`, `turns` and `outputLimit`; it does not
alias a built-in adapter. It has no default endpoint and does not contact a real commercial provider.

Build after the repository's extension-contract and extension-sdk packages have been built:

```sh
node examples/extensions/model-protocol/build.mjs
```

Install the directory through the existing local-extension flow. If more than one model-contribution
provider is enabled, select the ordered collection through the existing service-routing settings.
Create a channel, select **Example text SSE service**, enter the actual service base URL, and explicitly
choose/add a model from the contributed candidates. Merely installing a provider does not save a
channel or change a selected model. `/respond` is appended to the configured base path.

The service must accept a POST body with `engine`, `turns` and nullable `outputLimit`. Each turn keeps
its original provenance and text. It returns SSE data such as:

```text
data: {"kind":"delta","text":"Hello"}

data: {"kind":"complete","text":"Hello","continuation":"opaque-receipt","inputTokens":4,"outputTokens":1,"usage":{"inputTokens":4,"outputTokens":1}}
```

Text-only input is deliberate. Tools, media, reasoning-only items and unknown frames fail explicitly.
An EOF without the `complete` frame is not success. Missing usage remains missing. The continuation
is confined to the same protocol version and original connection/account identity. Rust performs HTTP,
SSE framing, credential dispatch, cancellation and writes to the original request/Operation. The codec
never receives a secret or starts a replacement request. No retries, second request ledger or native
plugin loader are introduced.

The SDK's optional `authenticate` callback handles `begin`, `complete` and `refresh` under the reviewed
`varin.models.authentication` capability. It receives a call-scoped client for a single POST to one of
its declared exact HTTPS token endpoints, with no redirects. Sign-in prompts use the existing
workbench flow; tokens and account-safe refresh stay in the Host credential store. This sample does
not invent an OAuth server or request this capability. See the production owner tests for the full
reviewed credential/refresh path.

Source-level example tests exercise the real codec and strict failure/usage behavior. Product tests
exercise SDK registration, Host service pins, replacement, kernel disconnect and authentication; Rust
fixtures exercise actual codec callbacks with the Rust HTTP owner. These are not a live-provider or
installed-product certification.
