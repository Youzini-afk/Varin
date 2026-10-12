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
generation's values. Service requirements explicitly declare nonempty `realms`; this runtime consumes
only those including `surface`. `single`, `selected`, and `all` resolve against the same complete
provider set before activation. The loader uses the authoritative Host service-routing document for
selected choices and supplies `exactProviderIds`, immutable implementation references for this owner.
This runtime has no mutable service selection table. `single` requires exactly one candidate; `all`
binds every compatible candidate. Missing required or ambiguous dependencies fail before extension
activation, retaining the previous committed owner.

Most extension authors use `@varin/extension-sdk`; this lower-level package is public for alternate
Surface hosts and advanced lifecycle tests. See the
[authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).

An injected `SurfaceExternalService` may carry a disposer. The runtime attaches it to the consumer
owner scope, so candidate rollback, generation replacement, and disable clean up the exact service
instance that was created for that owner. Optional requirements remain non-blocking when no external
service is available.

Lifecycle work is ordered by extension owner. Candidate activation and connected-consumer mount
preparation run outside publication reservations. Only conflicting contribution IDs, replacement
points, and declared service keys coordinate publication; unrelated owners can publish even while
another owner is preparing, awaiting its external commit, or cleaning up.

`registerContributionConsumer` is a local Surface-host seam, not an extension permission or another
registry. Its preview projects candidate owners from the existing registry. Consumers stage mounts,
validate their existing owner binding, commit synchronously, and return retirement cleanup. Failed
preparation rolls back those leases; successful publication retires mounts before their old owner
resources. Window closure during an already successful external commit cleans the staged mount
without claiming that the Host's selected artifact was rolled back.

Preparation options and connected-consumer leases carry their actual owner signals. The commit
callback receives their combined signal after validation, so cancellation also reaches a queued
external publication. The callback's confirmed external result remains the boundary: a signal that
aborts after that commit cannot turn the selected generation into an uncommitted candidate. Consumer
signals fence local mounts; they do not create a global window registry or a screen-presentation claim.


Owned context writers and read-only candidate projection form one provider capability. Before mount
preparation, the original context store projects the proposed layer commits/withdrawals without
publishing them. `when` visibility and its actual dependent mount points use that projection; the same
view is checked again before publication. Plain read-only context providers need no writer or preview.
Context withdrawal and registry withdrawal publish together, before the retired owner's resources.

Local service declarations carry a stable `providerKey` and a generation-specific `providerId`.
Activation freezes actual clients; calling `useService` again cannot pick a different registry
generation. Consumers retain their selected local provider owners, and admitted method calls retain
the actual resources until completion. Ordinary replacement withdraws presentation and closes the
external lifetime through `onRetire`, then releases resources after retained calls drain. Explicit
disable cancels the owner signal. Retiring a Surface does not own or stop independent Host backend
work; Host leases and their admitted-call pins govern those resources.
