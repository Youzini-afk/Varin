# macOS native semantic reads

The resident input owner retains AX objects by native equality. A child-index path
is descriptive only: a local read or sibling reorder does not retire another
observation's object. `release_elements` drops handles when the Host no longer
retains their observation; a closed window's retained identity remains sufficient
to report `window_lost`, never to adopt a same-title replacement.

`query_elements` reads requested properties directly from the original object, or
walks only the original `within` object. Discovery filters in the native helper.
Records include parent/depth, ancestor labels, standard roles, platform roles and
known states. Missing attributes remain missing, including unknown checkbox state;
AX checkbox value 2 is `mixed`. Depth/node budgets report incomplete traversal and
expandable containers. `window_only` checks the original window without a tree.
Virtualized descendants are limited to the provider's currently exposed children.
Secure text subroles and AXContainsProtectedContent suppress text/name/value reads
before fetching them; protection is inherited by descendants and checked through
ancestors for an exact or scoped read. Exact query values above the short-value budget are unavailable rather than truncated.
Screenshots retain the capture owner's
existing platform restrictions.

Semantic input revalidates window/object identity but not an old screenshot's
position. The opaque native target carries separate AX and raster generations:
physical input still validates raster generation, geometry, scale, focus and point
ownership. Auto primary element clicks prefer advertised AXPress; coordinates,
right/multiple clicks and explicit global input stay physical. There is no retry
through another mechanism after a native call was attempted.

State actions use settable AX attributes. A checkbox toggle is allowed only when
its boolean current state is readable; mixed/unreadable state cannot be guessed.
Selection replace writes the container's full AXSelectedChildren; add/remove use
AXSelected or an explicitly read selection. Scroll-into-view requires an advertised
AXScrollToVisible action. Unsupported properties/actions are not emulated with
unverified clicks. A satisfied state sends no input (`none`); `verified` means only
that the indicated property or selection was read back, not business completion.

Waits currently use the Host's scoped polling (`semanticEvents: polling`).
AXObserver was evaluated, but registering a notification does not establish that
a provider covers all descendant/property changes. There is no live subscription
contract in this driver yet; no dormant observer or second event service is added.
This is a declared support limit, not complete native event coverage. Read request
cancellation uses the existing per-request flag and does not release held viewer
input, retire the helper, or close ScreenCaptureKit.

## Verification

Run `node --test packages/computer-driver/macos/test_*.mjs`. Build/publication tests
run anywhere. The Swift semantic tests compile the production matching, state
selection and receipt code on macOS and exercise it without Accessibility consent
or input injection; they are explicitly skipped elsewhere. Build the full helper
with `node packages/computer-driver/macos/build-helper.mjs` on macOS.

Provider identity/reordering, native input, incomplete trees, TCC permission,
window close/reopen, retained ScreenCaptureKit, cancellation during a blocked AX
call and distribution signing still require macOS desktop acceptance. Portable
build tests are not evidence that these platform behaviors ran.
