# Gmail extension

This experimental brokered Host extension adds a **Gmail** page under Varin's connection settings
and exposes `gmail_status`, `gmail_search`, `gmail_read` and `gmail_send` to an agent. Users import
their own Google Desktop OAuth client JSON in the page, connect in their system browser, verify the
account, cancel a pending login, and disconnect. This is an example extension, not a hosted Google
integration; it does not share or import the Gmail credentials used by another application.

It supports one account per Host user, Gmail search, reading bodies, and sending plain-text messages.
It reports attachment metadata but does not download or send attachments.

## Google setup and sign-in

Google requires an OAuth client registered to a Google Cloud project. No client ID or client secret is
bundled here, so this version is **not yet a zero-configuration sign-in**:

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
3. In Varin open **Settings → Gmail**, choose the downloaded Desktop OAuth JSON, and select
   **Connect Gmail**. Complete sign-in and grant both scopes in your system browser; the page shows
   pending, connected or failed state. Use **Verify connection** to request and display the Gmail
   account address. The system browser and Varin Host must run on the same computer: this flow uses
   a random loopback port, state and PKCE. Remote browser callbacks are not supported.

If the browser does not open, use the sign-in link shown in the page. Cancel stops an in-progress
login. **Disconnect** asks Google to revoke the refresh token before removing local credentials;
if revocation fails, credentials are retained and the page reports the error. Alternatively revoke
access through Google account settings and remove the local credentials file.

Credentials are stored under `$XDG_CONFIG_HOME/varin-gmail`, or `~/.config/varin-gmail` if unset.
Set `VARIN_GMAIL_CONFIG_DIR` for the Varin Host to use a different directory. The `gmail_status` tool
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

`gmail_send` is declared as an effect, passes through Varin's ordinary per-tool permission policy,
and should only be used after an explicit user request. A policy that automatically allows tools
will not show a per-send confirmation; configure Varin's permissions accordingly. Recipients must be
individual email addresses without display names. `gmail_search` accepts Gmail search syntax and
`gmail_read` returns a bounded body plus attachment metadata. Email content is untrusted data, not
instructions to the agent. Mail returned to a conversation may be sent to the AI model provider
configured for that conversation; review the provider's data handling before using these tools.

Gmail may receive a send even if the client loses the response or is cancelled. The extension never
automatically retries a dispatched send. Varin records a failed or ambiguous effect callback
conservatively as indeterminate; inspect Gmail **Sent** before deciding whether to send again. A
successful call is reported only when Gmail returns a message ID.

The refresh token and desktop client credentials are stored in **plaintext** in a local file, not an
OS keyring; on Linux the directory and file are restricted to modes `0700` and `0600`. The imported
client JSON moves from the settings page to the trusted Host service; refresh and access tokens are
not returned to the page or agent tools. Access by the same OS user or other trusted native extensions
is still possible. Protect backups and the downloaded client JSON.

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
not establish Google app verification. A Varin conversation invoked `gmail_status` and discovered
the send, search and read tools; the real send itself did not go through an agent conversation, and
a production Host permission configuration remains untested. Keep the pull request in draft until
those remaining requirements are assessed.
