# Computer input stop before slow dependencies

Date: 2026-10-11. Baseline: `ffeac39c575ccc258e81e90ba79fca783b7fd455`.

This is a finite prerequisite for the native Computer integration required by runtime design §19.
It repairs the existing physical owner; it does not add native Computer tools, identities or handback
inputs, and does not claim those remaining capabilities are complete.

## Confirmed failure and original owner

Independent probes used the actual ComputerService and ComputerAutomation with controlled Storage,
script-revocation and driver ports. While a typing action held input:

- A blocked desktop record read prevented public `cancel` from requesting physical release.
- `takeover` sent the cancellation flag, but waited for script revocation or control persistence before
  calling the driver's actual release side channel.
- The real desktop control-bar consumer, `automation.cancelDesktop` → assignment removal →
  `releaseDesktop`, also waited for a catalog read before physical release.

These are deterministic ordering failures, not observations from an actual Windows desktop. A cancel
flag is not a key-release acknowledgement. The same original four blocked interleavings were retained
for post-fix review.

## Correction and boundaries

ComputerService remembers local placement on the existing lane only after loading its original desktop
record. Explicit cancel/takeover for that known local binding bypasses redundant target reads, applies
the original holder/transition/admission checks, fences old input and starts the existing driver's
cancel/interrupt immediately. Original assignment release uses the same path for a local controller.
Observer-only release does not cancel another controller. An unknown or remote target still resolves
through its actual owner; a caller-supplied desktop ID never establishes locality.

A shared helper waits for the release acknowledgement and original lane callback drainage. Missing
proof remains unconfirmed. Takeover starts that physical work before concurrently revoking the original
script and persisting control. Confirmed physical release followed by a failed control write reports
that partial result with a recovery action; it does not claim that persistence succeeded. Human
ownership and the old input fence remain in force. A late completion cannot clear a newer lane's
unconfirmed state. The old diagnostic journal remains best-effort evidence, not execution authority.

There is no new input queue, scheduler, database, permission list, retry layer or internal format.
No target is rebound and no product transport is changed. The original defaults, Pi runtime and
platform drivers remain in place.

## Verification

Independent review accepted this prerequisite slice with no confirmed remaining blocker.

- The existing ComputerService/ComputerAutomation suite passed **80 tests, 1 excluded socket case**.
  It covers the four held-dependency paths, release acknowledgement versus callback drain, original
  human-control recovery, unknown targets and distinct release/persistence failures. Changed-source
  lint and diff checks passed.
- Independent post-fix probes retained all four original gates: physical release now starts while the
  catalog read, script revoke or control write remains held. Seven additional boundary groups passed:
  invalid holder/unknown target; both cancel and takeover waiting for release plus callback; concurrent
  takeover rejection; human-held input protection; observer/controller separation; remote routing and
  disconnected-result truthfulness; and failed release retaining the control barrier.
- Final Host production and test types and actual production bundle passed. The bundle retained
  **541 reachable modules / 72 excluded legacy/test artifacts**. Documentation link checks passed.
  Native Rust and UI were not modified and their earlier broad suites were not repeated.

The final **5,231** tracked/unignored kernel/package/script inputs excluding Markdown remained unchanged
through verification. The saved manifest SHA-256 is
`2b067bbed236d7471ba34baa3e0fa7f6a36dea89662875c5e29e908ebd0f080c`.
These are owner/control-consumer checks with explicitly controlled physical ports, not real driver
or native runtime acceptance.

## Reproduce

From the repository root with the locked tools in [development](../development.md):

```sh
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts \
  packages/web/application-host/lib/computer/computer-service.test.ts \
  packages/web/application-host/lib/computer/computer-automation.test.ts \
  --maxWorkers=2 -t '^(?!.*enforces assignments on the actual remote Host).*'
bun run --cwd packages/web type-check:application-host:raw
bun run --cwd packages/web build:application-host
```

The name filter excludes the one real TCP-listening cross-Host case in this file; it was not executed
in this cloud, and its absence is not a product failure or pass. The other remote cases use controlled
fetch ports. A capable acceptance environment should also run the unfiltered owner suite and actual
platform controls. No real desktop, remote Host, VM, installed browser workflow or full Host IPC was
used here.

## Continuation

Next connect true Pi/native work and execution identities, the original tool invocation/result owner,
and actual public projection/cancel consumers. Native assignment requests and their durable Wait,
trusted environment inputs and handback continuation follow the same owners. Persistent scripts,
remaining remote capabilities and the other two-design domains remain open. The user still owns final
default-runtime cutover, Pi removal and broad asset migration after acceptance.
