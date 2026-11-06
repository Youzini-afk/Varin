# Gmail extension

This experimental brokered Host extension adds a **Gmail** page under Varin's connection settings
and exposes `gmail_status`, `gmail_search`, `gmail_read` and `gmail_send` to an agent. When the Host
operator has configured a publisher-owned OAuth client, a user connects their own account in the system
browser without importing a client file. The page also supports a user-owned Desktop OAuth client as
an advanced fallback, account verification, cancellation and disconnect. This example does not share
or import another application's Gmail tokens.

It supports one account per isolated Host, Gmail search, reading bodies, and sending plain-text messages.
It reports attachment metadata but does not download or send attachments.

## Google setup and sign-in

Google requires an OAuth client registered to a Google Cloud project. The publisher can place its
**public client ID only** in `public-client.json` before building, or set
`VARIN_GMAIL_PUBLISHER_CLIENT_ID` on the Host. The controlled Host must separately receive
`VARIN_GMAIL_PUBLISHER_CLIENT_SECRET` from its operator and set `VARIN_GMAIL_ISOLATED_HOST=1` only
after provisioning one genuinely isolated OS user and Host for that person. With those inputs the page
enables **Connect Gmail** without asking the end user for JSON. In publisher mode each user's refresh
token is stored separately from the publisher secret; it is never returned to the page or agent.

`public-client.json` deliberately has no ID in this repository. No verified production client, hosted
OAuth service or secure secret-delivery mechanism for public desktop distributions is supplied here.
Do not publish a desktop client secret in source code, release files or a public environment. Native
applications cannot keep a bundled secret confidential. Although Google's desktop documentation calls
the secret optional, the test client used for this example rejected refresh requests without it. A
real public release needs a publisher-operated, reviewed solution for that discrepancy and must
comply with Google's policies. Host environment variables are visible to same-user native code and
are suitable only where the operator controls and trusts the entire Host.

When the publisher has not configured login, advanced users can use their own client:

1. Create or select a project in [Google Cloud](https://console.cloud.google.com/), enable the Gmail
   API, and configure the OAuth consent screen. Create a **Desktop app** OAuth client, mark it for use
   by an AI-powered agent, and download its JSON file. Add the Gmail account as a test user if the
   application is in testing mode. Google recommends separate clients for agent and conventional
   interactive workflows; see [OAuth clients for AI agents](https://support.google.com/cloud/answer/15549257#agentic-client).
2. Add `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.send` to the consent screen. Google classifies the first as
   restricted and the second as sensitive; production access may require verification. For an
   external app in testing mode, Google expires the Gmail refresh token after seven days. See
   [Google's scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes),
   [OAuth token expiration rules](https://developers.google.com/identity/protocols/oauth2), and
   [desktop OAuth instructions](https://developers.google.com/identity/protocols/oauth2/native-app).
3. In Varin open **Settings → Gmail → Advanced**, choose the downloaded Desktop OAuth JSON, and select
   **Connect Gmail**. Complete sign-in and grant both scopes in your system browser; the page shows
   pending, connected or failed state. Use **Verify connection** to request and display the Gmail
   account address. The system browser and Varin Host must run on the same computer: this flow uses
   a random loopback port, state and PKCE. Remote browser callbacks are not supported.

If the browser does not open, use the sign-in link shown in the page. Cancel stops an in-progress
login. **Disconnect** asks Google to revoke the refresh token before removing local credentials;
if revocation fails, credentials are retained and the page reports the error. Alternatively revoke
access through Google account settings and remove the local credentials file.

Credentials are stored under `$XDG_CONFIG_HOME/varin-gmail`, or `~/.config/varin-gmail` if unset.
Set `VARIN_GMAIL_CONFIG_DIR` for the Varin Host to use a different directory. This is one account per
Host, **not shared-Host multi-user isolation**: Varin's extension service does not receive a trusted
end-user identity, and a caller-provided user ID is not an authorization boundary. Run a separate Host
under a distinct OS account for each person; do not expose one configured Host to unrelated users.
The isolation flag is an operator assertion, not a substitute for that OS boundary. The `gmail_status` tool
only checks that local credentials exist; use the settings page's verification action to check them.
The optional terminal authorization command remains available:

```sh
node examples/extensions/gmail/runtime/authorize.mjs /path/to/desktop-oauth-client.json
```

## Build and install

Use matching `@varin/*` workspace packages; their `0.2.0` versions do not assert an npm publication.
From a repository checkout with Bun and workspace dependencies installed:

```sh
bun run --cwd packages/extension-cli build
mkdir -p examples/extensions/gmail/node_modules/@varin
ln -s "$(pwd)/packages/extension-sdk" examples/extensions/gmail/node_modules/@varin/extension-sdk
ln -s "$(pwd)/packages/ui/node_modules/linkedom" examples/extensions/gmail/node_modules/linkedom
node packages/extension-cli/dist/cli.js build examples/extensions/gmail
node packages/extension-cli/dist/cli.js check examples/extensions/gmail
node --test examples/extensions/gmail/*.test.mjs
```

In **Settings → Varin Extensions → Install or update**, choose the built local
`examples/extensions/gmail` directory and review its code identity. Enable and select its tools in
the intended Run. Use local directory reload and candidate review when changing code. The user must
trust the extension: brokered Host code is not an OS sandbox and this extension directly uses the
local filesystem and Google network APIs even though it requests no broker capabilities.

## Permissions and handling failures

`gmail_send` declares a mandatory one-time confirmation and requires a Varin Host implementing that
contract. The Host presents the exact recipient, subject and body before each dispatch, including in
bypass mode; persistent approval and direct unscoped service execution cannot authorize the send.
Existing explicit denial still applies. Recipients must be
individual email addresses without display names. `gmail_search` accepts Gmail search syntax and
`gmail_read` returns a bounded body plus attachment metadata. Email content is untrusted data, not
instructions to the agent. Mail returned to a conversation may be sent to the AI model provider
configured for that conversation; review the provider's data handling before using these tools.

Gmail may receive a send even if the client loses the response or is cancelled. The extension never
automatically retries a dispatched send. Varin records a failed or ambiguous effect callback
conservatively as indeterminate; inspect Gmail **Sent** before deciding whether to send again. A
successful call is reported only when Gmail returns a message ID.

The refresh token is stored in **plaintext** in a local file, not an OS keyring; manually imported
client secrets are stored with it. Publisher secrets remain in the Host environment instead. On Unix
the credential directory and file must belong to the effective OS user and use `0700` and `0600`.
Access by the same OS user or other trusted native extensions is still possible. Protect backups and
the downloaded client JSON.

## Verification boundaries

The tests cover a real local loopback callback with mocked Google token/API responses, PKCE and state,
settings-page interaction, cancellation and revocation failures, SDK registration, MIME/header
validation and uncertain sends. The separate `packages/extension-host/test/gmail-example.test.ts`
installs the example and exercises services in a real broker with an isolated credential directory.
The settings page was also loaded in a running Varin instance and rejected an invalid client file.
One personal test-mode Google Cloud client completed live browser authorization, and the installed
extension verified its account against Gmail's profile endpoint. A single self-addressed message was
also sent through an isolated broker using the same Host bundle as the installed extension. Gmail
accepted the message; the extension read it back and found it in the account's inbox. These checks do
not establish Google app verification. A Varin conversation using the earlier installed version invoked
`gmail_status` and discovered the send, search and read tools. A native acceptance test now drives a
model-requested Gmail send through the real kernel, authenticated thread route and extension broker,
with only the outbound Gmail API replaced by a local test sink. It confirms one approved call and
rejects a second. UI behavior tests cover the preview. Agent-initiated live sending, a production
publisher deployment, and shared-Host multi-user isolation remain untested or unavailable. Keep the
pull request in draft.
