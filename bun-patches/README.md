# Dependency repairs

`package.json` pins patches to the exact installed package versions. When upgrading a
patched dependency, check whether its upstream release includes the change; otherwise
port the patch and remove the obsolete version's entry and file.

- `@legendapp/list`: preserve same-frame shrinking for chat rows marked
  `data-legend-immediate-shrink` so animated collapse does not leave the following rows behind.
- `app-builder-lib`: preserve Varin's NSIS extraction, old-version uninstall, assisted
  pages and app-data removal hooks.
- `minimatch` 9.0.9 and 10.2.4–10.2.6: backport the preprocessing changes from
  [11.0.1](https://github.com/isaacs/minimatch/compare/v11.0.0...v11.0.1)
  for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
  Keep each consumer's existing major and exports. Versions 3 and 5 predate the
  affected optimization; the regression test verifies that distinction too.
- `glob` 11.1.0 and 13.0.6: backport cancellation returns and resume handling from
  [14.0.2](https://github.com/isaacs/node-glob/compare/v14.0.1...v14.0.2)
  for [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
  Version 13's default exports normally use bundled copies of the walker. Its patch
  routes all entrypoints to the equivalent unbundled implementation so the fix
  applies to both `import` and `require`.

`bun run audit:dependencies` verifies the installed security repairs before excluding
their version-only advisory reports. `scripts/glob-security.test.mjs` exercises CJS and
ESM entrypoints through the real consumers and checks coverage of every locked glob
and minimatch version. New advisories still fail the audit.
