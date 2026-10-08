# Shell output organization

Deterministic default display for public `bash` and incremental `get_output` (plan 3.17 / D-197).
Host-only. Does not execute the command, call a model, or change OutputStore bytes.

- Identify `vitest`, `tsc`, `eslint`, and `git` from command tokens (including `bunx` / `npx` / `bun run`) or a narrow output shape. Unknown commands use the generic display.
- Git is split by subcommand: `status` keeps file states; `diff`/`show` keep hunks and requested commit text; `log` keeps commit blocks. Other git subcommands stay generic.
- Full UTF-8 output is stored first. Organization only changes `display`. Explicit `offset`/`length` still reads raw bytes. Summary length never advances the observation cursor.
- A confirmed command exit marks the complete observation final, including output without a trailing newline. Incremental reads remain partial.
- The 32 KiB figure is the existing visible budget, not a new parser cap. Overflow states an omission and points at the retained full text.
