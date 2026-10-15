# Agent Harness Replay Set

This is a small, manual paired replay set for diagnosing behavior changes and
comparing configurations when useful. It is not an activation gate. The runner
does not call a model or mutate user settings by itself.

Each case comes from a real Varin change and pins both the repository state
before the task and the known delivered change. The reference commit is evidence
for reviewers, not an exact-patch oracle: a different implementation can pass if
it meets the acceptance criteria.

The recorder preserves historical variant labels `native` and `harness-shadow`; they are result
labels, not runtime selectors or current settings. When comparing configurations, record the actual
native model, policy, memory and delegation choices and hold the prompt, starting commit and machine
constant. The pinned historical tasks may refer to APIs no longer present in the current product.

Record only three aggregate metrics: success, total tokens, and human
interventions. A failed run also receives one diagnostic category. Deterministic
security, crash, recovery, and storage invariants stay in E2E/fault-injection
tests and are not judged from replay scores.

```powershell
node scripts/harness-replay.mjs validate
node scripts/harness-replay.mjs show context-shadow-runtime
node scripts/harness-replay.mjs new-run --case context-shadow-runtime --variant native --model openai/gpt-5 --pair trial-1 --output D:\replays\context-native
node scripts/harness-replay.mjs record --run D:\replays\context-native\run.json --success pass --input-tokens 12000 --output-tokens 8000 --cache-read-tokens 108000 --interventions 1
node scripts/harness-replay.mjs summary --results D:\replays
```

`new-run` only writes a run record and prints the base commit, prompt and acceptance criteria.
Preparing a checkout and starting a paid model remain explicit operator actions. The recorder does
not change runtime, memory, delegation or compaction settings. Use the configuration APIs available
at the selected source revision rather than treating old replay labels as current product controls.
