# Plan, question and process policy

This ordinary `varin.agent.policy@3` extension demonstrates a stateful workflow without provider
inference: read a plan → CAS update → ask the user → read the authentic answer → optionally start and
resize and write to a fixed PTY process → observe its actual exit → deliver → explicitly pause/resume → complete. Core owns every action,
permission, Wait, result and history item. The extension owns only its versioned private state.

## Try it in a dedicated native Thread

This example replaces that Thread's plan after reading its current reference. Use a new, dedicated
native Thread. Select an admitted physical execution source with `process_spawn`, `process_resize`, `process_write` and
`process_inspect`; the example's execution environment must have `node` on its PATH. The process
waits for input. The policy resizes its original PTY, writes a fixed line, then the process prints it and exits. Its executable/arguments are declared in `host.ts`, not derived from
the answer or run in the extension broker. A question answer does not authorize a process: ordinary
source and process permissions are still checked independently by core.

From the repository root:

```sh
bun run --cwd packages/extension-sdk build
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/domain-policy/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/domain-policy/host.cjs
```

Use **Settings → Varin Extensions → Install or update → local folder** to install this directory.
Select the installed provider through the existing service routing interface, using the routing
revision you just read:

```json
{
  "serviceId": "varin.agent.policy",
  "version": 3,
  "providerKey": "example.domain-policy:host:varin.agent.policy@3",
  "scope": { "sessionId": "YOUR_NATIVE_THREAD_ID" },
  "allowFallback": false
}
```

Submit an input to the native Thread. The plan card updates and the original question appears.
Reopening while the question is pending must retain that question, rather than deciding or asking it
again. Answer exactly `run` to select the fixed probe. Cancelling the question or supplying any other
answer ends the example without starting a process. The policy reads `question_status` through the
ordinary graph/result interface; it cannot mistake the original `JobAccepted` for an answer.

Each resize/write advances only from a successful Confirmed Result; partial or unknown input fails without replaying bytes. The receipt confirms OS input acceptance, not the program’s semantic interpretation.

While an accepted PTY is live, **Open process terminal** opens that same handle in the shared terminal panel. Closing the view leaves the original job and output intact; explicit process cancellation targets its original Operation. No extra interactive shell is launched.

After observing the process, the policy reads `process_inspect` and delivers its actual status. A
cancelled observation does not stop the process and is not a successful exit. Inspect the delivery,
then use **Resume run** with the displayed original Run/Wait identity. The final delivery completes
the example. Do not resend input as a substitute for explicit resume.

The installer pins an immutable artifact. Rebuilding an uninstalled source file does not change a
running policy. This version deliberately declares no private-state migration hook; changing its
implementation (policy state version 2) requires the ordinary policy selection/restart-state controls. Installing it does not
change the product's default Pi runtime.

## Recovery and evidence

The plan owner retains its CAS receipt under the original operation and tagged tool origin. A lost
reply is reconciled from that receipt, not by repeating a mutation. The policy fails on an unsuccessful
or indeterminate plan result. Question and process acceptance remain separate from later terminal
facts; old handles are retained in private state. Result bytes are read in owned chunks, including
UTF-8 split across chunks, without inventing a provider call or history entry.

Portable installed-artifact/Host consumer checks:

```sh
bun run --cwd packages/web test application-host/lib/kernel/policy-domains.test.ts application-host/lib/knowledge/plan-owner-review.test.ts application-host/lib/kernel/tool-composition.test.ts
```

The installed-policy test supplies committed domain events as fixtures and verifies the real installer,
broker, SDK parsing, private checkpoint and consumer decisions. The plan test uses the actual private
Host bridge, plan owner, KnowledgeStore worker and database with an explicit Catalog-ancestry fixture.
Native domain execution is separately covered in `kernel/crates/varin-kernel/src/policy_domains_review.rs`.
From a Linux development shell, run the actual domain owners and the fresh guardian executable:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib policy_domains_review
cargo build --manifest-path kernel/Cargo.toml -p varin-kernel --bin varin-kernel --locked
VARIN_TEST_KERNEL_EXECUTABLE="$PWD/kernel/target/debug/varin-kernel" cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib policy_todo_question_reopen_process_wait_and_explicit_resume_use_real_domains -- --ignored
```

The native combined case uses real Catalog, Storage and process execution with an explicit plan-owner
reply fixture; the separate Host plan tests exercise the real KnowledgeStore owner.
These layers do not establish product Host IPC, a real user desktop, remote process availability or
cross-platform acceptance. Run those checks in the intended acceptance environment before migration.
