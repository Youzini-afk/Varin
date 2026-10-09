# Project context contribution

This is an ordinary brokered Host extension, using the executable
`provideContextFragments(context, { sections })` author contract. The declaration is immutable;
`describe` accepts no arguments and returns no executable callbacks. Do not perform model calls,
retrieval, network access or external effects in this contract. Such work needs an explicit operation.

Build with the repository's current SDK (the published SDK must include this API before building
outside the repository):

```sh
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/project-context/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/project-context/host.cjs
```

The command produces a self-contained `host.cjs`; the installable package deliberately declares no
runtime or development dependencies. Install this folder through the ordinary local extension
install/enable flow. It receives no Host
capability grants. The built-in `varin.builtin.context-fragments` remains the distribution default.
In the existing service-routing settings/API, add a rule with:

```json
{
  "serviceId": "varin.context.fragments",
  "version": 1,
  "providerKey": "example.project-context:host:varin.context.fragments@1",
  "scope": { "projectId": "YOUR_PROJECT_ID" },
  "allowFallback": false
}
```

The service-routing update API also requires the routing document's current `expectedRevision`.
Use a different project rule to choose another implementation; a thread-specific `sessionId` rule
can override a project rule. Existing default/project/thread routing precedence is authoritative.
Installing an unrelated provider does not activate it or change the selected implementation.

A new native context checkpoint uses the selected provider's named sections. Memory refresh/input
admission rechecks selection; failure preserves the old checkpoint and reports preparation failure.
The Rust compiler reuses a typed binding for unchanged declarations, appends instruction sections as
system instructions and data sections as external data, and freezes the result in the normal model
snapshot. Conversation history is never rewritten. Inspect the native context checkpoint's
`personalization.contextComposition` for the exact provider, immutable content digest and selection
revision. Previously prepared model requests retain their compiled context.
