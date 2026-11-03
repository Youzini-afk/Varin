# Parallel Proposal and Challenge

A genuinely different Run driver, not a `policy@4` decision wrapped in another name.
`host.ts` starts two independent model requests concurrently. Each branch can execute its
read-only evidence tools as soon as its own request completes, while the other model remains
in flight. After the branches join, the driver calls `context.driver.context()` to consume
available entries from the original Inbox and compile fresh native context. It then combines
that current history with both branches and their actual receipts, makes a tool-free synthesis
request, and delivers the answer. It then calls the original atomic `finish` admission. If steering
arrived during synthesis, the same callback refreshes context and makes a newly identified synthesis;
it keeps the original two branch/tool receipts rather than replaying their work. If original work
still needs to settle, it waits on original events. New user input is not lost behind a last-refresh race.
This context refresh is non-blocking: it does not wait for future messages or create another queue.
Other algorithms can explicitly await original input/work events through `context.driver.wait`;
this one chooses to finish after its two branches rather than wait for a further user turn.

This example deliberately chooses one evidence round, the explicitly named native file helpers
`file_read`, `file_list`, `file_search`, and registered tools whose metadata declares read/result.
Native file helpers do not carry registered-service metadata; other tools with missing metadata
are not assumed read-only. Those are algorithm choices, not restrictions on the driver API. The
original tool owner still owns permission/resource admission. Branch output is quoted as
`external_data`, never relabeled as user authorization or stitched into a fictitious serial
tool exchange. Adapter-private opaque data is not copied between requests.

## Build and select

From the repository root, build `extension-contract`, `extension-surface` and `extension-sdk`,
then run `node examples/extensions/parallel-driver/build.mjs`. This produces the bundled
`host.cjs` and manifest from the same public service/capability constants used by registration.
The bundle is a build artifact, not checked-in executable source.

Install the folder through Extensions, review its trusted Host code and the separate
`runtime.driver` capability request, and enable it. In **Extensions → Service routing →
Execution loop**, explicitly select **Parallel Proposal and Challenge** for the user or the
actual execution workspace. Merely installing the only third-party driver does not select it.
**Varin default loop (Rust)** explicitly overrides an inherited extension choice;
**Inherit** removes only this scope's rule. Selection affects new Runs, not the original
driver/configuration of existing Runs. An unavailable selected driver fails explicitly.

Both branches use the original Run's primary model here. Drivers can also declare the
currently supported `agentPlanning` model role and use its prepared capability when available.
No credentials, invented Run identity, fake parent tool invocation or private Kernel client
are needed by this author code.

## Recovery and stopping

The example declares `recovery: 'none'`. It does not replay an interrupted attempt from its
initial user input. Actual model/tool/delivery records remain owned by the original Run.
Authors implementing checkpoint recovery must declare an exact schema and implement an
explicit `resume` callback using the supplied checkpoint and reconciled receipts; the SDK
does not substitute `run` when resume is absent.

An aborted signal is stop intent, not evidence that an executor has stopped. New capability
calls stop being admitted; already-dispatched work is settled by its original owner. Returning
`{ kind: 'complete' }` after a committed `finish` ends the algorithm, not the lifetime of unjoined native operations.
Broker capability grants constrain broker APIs; trusted Host code is **not** OS-sandboxed.
Drivers may independently cancel a no-longer-useful branch with
`context.driver.cancel({ kind: 'model' | 'tool', id })` while their scope remains live. The
returned `requested` flag records intent, not actual stop; inspect the original receipt.
This example joins both branches rather than imposing a cancellation policy on every driver.

The SDK test executes this actual built bundle and holds one model response behind a barrier
to prove that the other branch executes a tool before the join. Native/Host integration tests
separately own real Run admission, receipts, cancellation and recovery verification.
