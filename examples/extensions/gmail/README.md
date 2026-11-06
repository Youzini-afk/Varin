# Gmail extension

This experimental brokered Host extension exposes `gmail_status`, `gmail_search`, `gmail_read` and
`gmail_send` to a Varin agent. It uses a Google Desktop OAuth client belonging to the user: it does
not share, import or require credentials from Codex. It supports one account per Host user, plain-text
messages, search, and message bodies. It reports attachment metadata but does not download or send
attachments. This is an example extension, not a built-in or hosted Google integration.

## Requirements and Google setup

1. Use Node.js 22.19 or later on the **same Host and OS user that runs Varin**. For this first
   version, authorization runs in a terminal on that Host and uses a local browser and loopback
   callback. It is not an in-app login dialog and does not support remote browser callbacks.
2. In [Google Cloud](https://console.cloud.google.com/), create or select a project, enable the Gmail
   API, and configure the OAuth consent screen. Create a **Desktop app** OAuth client and download
   its JSON file. Add the Gmail account as a test user if the app is in testing mode.
3. Request `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.send` on the consent screen. Google classifies the first
   as restricted and the second as sensitive; verification and other requirements can apply to a
   production app. Testing-mode grants may expire. See Google's
   [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and
   [desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) documentation.

No client ID, client secret or refresh token is bundled with the extension. OAuth uses the system
browser, a random loopback port, a state value and PKCE. From the repository root, run:

```sh
node examples/extensions/gmail/runtime/authorize.mjs /path/to/desktop-oauth-client.json
```

Open the printed Google URL if the browser does not open automatically and grant both requested
scopes. The command writes `credentials.json` under `$XDG_CONFIG_HOME/varin-gmail`, or
`~/.config/varin-gmail` when `XDG_CONFIG_HOME` is unset. Set `VARIN_GMAIL_CONFIG_DIR` for both the
command and the Varin Host to use a different directory. Re-run the command to replace the account.
The `gmail_status` tool only checks that local credentials exist; it does not prove they remain valid.

## Build and install

The following uses matching `@varin/*` workspace packages; the `0.2.0` package versions in this
example do not imply that they have been published to npm. From a repository checkout with Bun and
workspace dependencies installed:

```sh
bun run --cwd packages/extension-cli build
mkdir -p examples/extensions/gmail/node_modules/@varin
ln -s "$(pwd)/packages/extension-sdk" examples/extensions/gmail/node_modules/@varin/extension-sdk
node packages/extension-cli/dist/cli.js build examples/extensions/gmail
node packages/extension-cli/dist/cli.js check examples/extensions/gmail
node --test examples/extensions/gmail/gmail.test.mjs
```

In **Settings → Varin Extensions → Install or update**, choose the built local
`examples/extensions/gmail` directory and review its code identity. Enable and select its tools in
the intended Run as you would other extension tools. Use the documented local directory reload and
candidate review flow after changing code. The user must trust the extension: brokered Host code is
not an OS sandbox and this extension directly uses the local filesystem and Google network APIs,
even though it requests no broker capabilities.

## Permissions and handling failures

`gmail_send` is declared as an effect, passes through Varin's ordinary per-tool permission policy,
and should only be used after an explicit user request. A policy that automatically allows tools
will not show a per-send confirmation; configure Varin's permissions accordingly. Recipients must be
individual email addresses without display names. The message is a UTF-8 plain-text RFC MIME message
sent by Gmail's API. `gmail_search` accepts Gmail search syntax and `gmail_read` returns a bounded
body plus attachment metadata; email content is untrusted data, not instructions to the agent.

Gmail may receive a send even if the client loses the response or is cancelled. The extension never
automatically retries a dispatched send. Varin records a failed or ambiguous effect callback
conservatively as indeterminate; inspect Gmail **Sent** before deciding whether to send again. A
successful call is reported only when Gmail returns a message ID. Google API errors do not include
credentials in the tool output. The tests use fake token and Gmail responses and do not send mail.

The refresh token and desktop client credentials are stored in **plaintext** in a local file, not an
OS keyring; on Linux the directory and file are restricted to modes `0700` and `0600`. Access by the
same OS user or trusted native extensions is still possible. Protect backups and the downloaded
client JSON. To disconnect, revoke access in your Google account's third-party app settings and
remove the `credentials.json` file. Revocation is not performed merely by removing the extension.

## Verification boundaries

`gmail.test.mjs` exercises the real local loopback callback, OAuth state and PKCE handling, the SDK
registration, MIME/header validation, mocked Google requests and uncertainty handling. It does not
perform a live Google authorization, test Google verification, prove a production Host permission
configuration, or send a real message. Test with a user-owned Google Cloud client and account before
promoting the extension from draft. The separate
`packages/extension-host/test/gmail-example.test.ts` installs the example and exercises its service
descriptors in a real broker with an isolated, unconfigured credential directory.
