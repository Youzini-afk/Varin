# @varin/extension-surface

Framework-neutral Surface lifecycle foundation for Varin extensions.

Activations stage contributions, services, and cleanup ownership before one atomic commit. Failed or
superseded generations roll back without becoming visible. Deactivation withdraws visible records
before running reverse-order cleanup. The registry also resolves explicit replacements, selected or
multiple service providers, ordered contributions, and retained layout references for contributions
that are temporarily absent. Actual state remains attributed to extension, entrypoint, realm, and
generation. This package does not import React or load external bundles.

Owner context keys participate in the same activation transaction. A candidate writes into a private
layer; the layer becomes visible only after the external commit succeeds. Replacing an owner fences the
old writer before cleanup, and disposing one entrypoint cannot remove another entrypoint or a newer
generation's values. `single`, `selected`, and `all` service requirements use the same complete provider
set: selected requires one explicit matching provider, single requires exactly one candidate, and all
exposes every compatible candidate.

Most extension authors use `@varin/extension-sdk`; this lower-level package is public for alternate
Surface hosts and advanced lifecycle tests. See the
[authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).

An injected `SurfaceExternalService` may carry a disposer. The runtime attaches it to the consumer
owner scope, so candidate rollback, generation replacement, and disable clean up the exact service
instance that was created for that owner. Optional requirements remain non-blocking when no external
service is available.
