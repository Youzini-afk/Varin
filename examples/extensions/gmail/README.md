# Gmail plugin

An ordinary installable plugin: its settings, connections, Google adapter and mail tools live here.
Varin supplies scoped secret storage, authorization interactions and one-action permission receipts,
not a Gmail account registry. Each trusted Host user sees their own connections on all their surfaces.
Tokens and PKCE verifiers stay in Host-only calls. The OAuth adapter rejects ordinary service RPC;
only a retained credential-owner authentication invocation can enter it. Plugin storage contains only opaque connection IDs.

## Build and install

With the workspace SDK and CLI built, run `varin-extension release .` here. Import the resulting
`release/varin.gmail-0.1.0-any-any.tgz` through Settings → Plugins, review code trust and capabilities,
enable it and open Configure. The self-contained JavaScript package uses Node built-ins and no native
modules; desktop Windows/macOS/Linux and remote Hosts use the same artifact. The settings surface works
on desktop, web and mobile. Platform packaging is portable; real OS/browser OAuth validation and Google's
production verification still need the publisher's registered application and release testing.

## Google setup

The publisher or Host operator must register their own Google OAuth application and enable Gmail API.
Set `VARIN_GMAIL_CLIENT_ID` and `VARIN_GMAIL_REDIRECT_URI` in the Host process environment, then restart
the plugin. Native/public clients use PKCE without a client secret. A confidential web client can set
`VARIN_GMAIL_CLIENT_SECRET` only in the Host environment; never put it in the package or settings UI.

This plugin uses the existing Host authorization reply flow. After Google redirects, paste the complete
callback URL into the plugin's Complete sign-in field. The callback origin and path, random state and
PKCE verifier are checked before token exchange. Native clients must use a registered loopback callback;
this package does not start a loopback HTTP listener, so a native callback receiver must be supplied by
the deployment (or copy the callback URL from the browser address bar if the loopback page cannot load).
Remote Hosts require an operator-provided reachable HTTPS callback page registered with Google. This is
not Google's deprecated out-of-band code flow: the registered redirect URL is validated unchanged.
No callback URL may be embedded in public marketplace links. Do not send callback URLs to a conversation.

The plugin requests Gmail readonly and send scopes. Production verification, restricted-scope policy
and applicable Google security assessment are the publisher's responsibility. Unverified app/testing
limits are not hidden by a successful plugin install. No real Google login or send is part of tests.

## Connections and mail

Connect Gmail creates a separate connection; multiple accounts are supported. Closing settings or
cancelling sign-in cancels a pending authorization without removing existing accounts. Refresh accounts
reloads current credential metadata. Local disconnect does not revoke Google access. Revoke Google
authorization contacts Google first and retains the local connection if revocation fails. Reconnect by
creating a new connection; old tool bindings cannot silently switch to it. Google revocation may affect
other connections using the same OAuth grant.

`gmail_accounts` lists nonsecret bindings. `gmail_search`, `gmail_read`, `gmail_thread` and
`gmail_attachment` operate on an explicit binding. Mail and HTML are untrusted data, never executable
instructions. Attachments are returned as bytes and SHA-256, not arbitrary filesystem writes.

`gmail_send` and `gmail_reply` require exact sender, To/Cc/Bcc, subject, body and fixed attachment bytes.
The native permission UI shows the full input and issues a one-use authorization. Reply headers and
original thread are verified; the plugin never infers recipients after approval. Cancel means no send.
Once dispatched, transport errors or invalid responses are uncertain outcomes: inspect Sent before a
new explicit request. The plugin never retries a dispatched send automatically, including 401/429/5xx.
There is no notification subscription or background inbox polling on install.

Run `node --import tsx --test *.test.ts` for MIME, confirmation and simulated Google OAuth checks.

## Publisher release and marketplace listing

`.github/workflows/gmail-plugin-release.yml` manually builds/tests the self-contained release and
uploads a CI artifact without publishing. After merging the plugin changes, the publisher may push
`gmail-v0.1.0` on the reviewed source commit to build, test and publish the archive plus
`varin.release.json` to that tag's GitHub Release. The workflow rejects a tag that differs from the
package/manifest version. Publication runs in a separate write-permission job only for tag pushes;
manual dispatch remains artifact-only, including when dispatched on a tag. Existing releases are not
overwritten, and plugin releases do not replace Varin's latest application release. Prerelease version
tags create prereleases. This does not register an OAuth application or deploy a callback page.
For subsequent versions, update both package/manifest versions and publish a new `gmail-v<version>` tag.
Use the GitHub source selector `owner/repository#stable?tagPrefix=gmail-v&manifest=varin.release.json`
with the actual publisher repository. A dedicated tag prefix separates Gmail versions from Varin's
application releases. Do not add an installable marketplace entry until this source has a real published
release. After that, submit the plugin metadata to the independent catalog; later Gmail releases are
found directly from the author source without editing the catalog. At this commit Gmail is locally
installable from the tested archive, not claimed to be publicly released or already listed.
