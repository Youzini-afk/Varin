export interface ManifestFixture {
  readonly label: string;
  readonly manifest: unknown;
  readonly schemaValid: boolean;
  readonly runtimeValid: boolean;
}

const baseManifest = () => ({
  schemaVersion: 1,
  id: "dev.example.fixtures",
  version: "1.0.0",
  engines: { varin: ">=0.2.0" },
});

const baseContribution = () => ({
  id: "dev.example.fixtures.view",
  kind: "view" as const,
  contractVersion: 1,
  data: {},
  supports: ["web" as const],
});

const baseSurfaceEntrypoint = () => ({
  id: "main",
  mode: "managed" as const,
  file: "dist/main.js",
  supports: ["web" as const],
});

const shellManifest = (seams: Record<string, { replacementTargets: string[]; slots: string[] }>) => ({
  ...baseManifest(),
  contributions: [{
    id: 'dev.example.fixtures.shell',
    kind: 'shell',
    contractVersion: 1,
    supports: ['web'],
    replacement: { target: 'workbench.shell' },
    data: { contract: 'varin-workbench-shell/v1', seams },
  }],
});

const tool = {
  name: "search", description: "Search a scoped source", inputSchema: { type: "object" },
  outputSchema: true, completion: "result", operation: "read", examples: [null, {}],
};
const toolFixtures: readonly ManifestFixture[] = ([
  ["tool contract", tool, true],
  ["null input schema", { ...tool, inputSchema: null }, false],
  ["missing output schema", { ...tool, outputSchema: undefined }, false],
  ["unsupported job completion", { ...tool, completion: "job" }, false],
  ["unknown tool authority claim", { ...tool, executor_stopped: true }, false],
  ["invalid source location", { ...tool, source: { path: "host.ts", line: 0 } }, false],
] as const).map(([label, value, valid]) => ({
  label,
  manifest: {
    ...baseManifest(),
    entrypoints: { host: { file: "host.cjs", mode: "brokered" } },
    provides: { services: [{ id: "dev.example.search", version: 1, tool: value }] },
  },
  schemaValid: valid,
  runtimeValid: valid,
}));

export const manifestFixtures: readonly ManifestFixture[] = [
  {
    label: "valid declarative entrypoint without file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "declarative",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "valid managed entrypoint with file",
    manifest: {
      ...baseManifest(),
      entrypoints: { surfaces: [baseSurfaceEntrypoint()] },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "valid isolated entrypoint with file and isolation",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "isolated",
          file: "dist/main.js",
          isolation: "iframe",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "valid native entrypoint with file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "native",
          file: "dist/main.js",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "valid brokered host entrypoint with file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        host: { file: "dist/host.js", mode: "brokered" },
      },
      contributions: [baseContribution()],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "managed entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "managed",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "isolated entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "isolated",
          isolation: "iframe",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "native entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        surfaces: [{
          id: "main",
          mode: "native",
          supports: ["web"],
        }],
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "host entrypoint missing file",
    manifest: {
      ...baseManifest(),
      entrypoints: {
        host: { mode: "brokered" },
      },
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "invalid SemVer version",
    manifest: {
      ...baseManifest(),
      version: "not-a-version",
      contributions: [baseContribution()],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "invalid engine range",
    manifest: {
      ...baseManifest(),
      engines: { varin: "not-a-range" },
      contributions: [baseContribution()],
    },
    schemaValid: false, // semver-range format now uses real semver.validRange
    runtimeValid: false,
  },
  {
    label: "contribution ID not qualified by extension ID",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        id: "unqualified.view",
      }],
    },
    schemaValid: true, // schema cannot express cross-field prefix rules
    runtimeValid: false,
  },
  {
    label: "contribution references unknown entrypoint",
    manifest: {
      ...baseManifest(),
      entrypoints: { surfaces: [baseSurfaceEntrypoint()] },
      contributions: [{
        ...baseContribution(),
        entrypoint: "nonexistent",
      }],
    },
    schemaValid: true, // schema cannot express cross-field reference rules
    runtimeValid: false,
  },
  {
    label: "contribution supports surface not in entrypoint supports",
    manifest: {
      ...baseManifest(),
      entrypoints: { surfaces: [{ ...baseSurfaceEntrypoint(), supports: ["web"] }] },
      contributions: [{
        ...baseContribution(),
        entrypoint: "main",
        supports: ["desktop"],
      }],
    },
    schemaValid: true, // schema cannot express cross-field support rules
    runtimeValid: false,
  },
  {
    label: "contribution requires undeclared capability",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        requiresCapabilities: ["workspace.documents"],
      }],
    },
    schemaValid: true, // schema cannot express cross-field capability rules
    runtimeValid: false,
  },
  {
    label: "unknown contract version (parsed but not compatible)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        contractVersion: 99,
      }],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "shell with valid seam data",
    manifest: shellManifest({ web: { replacementTargets: ['workbench.editor'], slots: [] } }),
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "shell with invalid seam data (missing required surface)",
    manifest: shellManifest({}),
    schemaValid: false,
    runtimeValid: false,
  },
  ...[
    { label: 'shell declares an unsupported surface', seams: {
      web: { replacementTargets: [], slots: [] }, mobile: { replacementTargets: [], slots: [] },
    } },
    { label: 'shell recursively replaces itself', seams: {
      web: { replacementTargets: ['workbench.shell'], slots: [] },
    } },
    { label: 'shell duplicates a replacement target', seams: {
      web: { replacementTargets: ['workbench.editor', 'workbench.editor'], slots: [] },
    } },
  ].map(({ label, seams }) => ({ label, manifest: shellManifest(seams), schemaValid: false, runtimeValid: false })),
  {
    label: "versioned shell data with extra field",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "varin-workbench-shell/v1",
          seams: {
            web: { replacementTargets: [], slots: [], extraField: true },
          },
          extraTopLevel: true,
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
      }],
    },
    schemaValid: false, // schema enforces additionalProperties: false on shell data
    runtimeValid: false, // runtime now also rejects unknown fields in shell data
  },
  {
    label: "transition-scene contribution with valid data",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.transition",
        kind: "transition-scene",
        contractVersion: 1,
        data: {
          contract: "varin-transition-scene/v1",
          scenes: ["workbench-profile"],
          durations: {
            "workbench-profile": {
              covering: { quick: 100, reduced: 200, standard: 300 },
              revealing: { quick: 100, reduced: 200, standard: 300 },
            },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.transition" },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "editor contribution with valid languageIds",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.editor",
        kind: "editor",
        contractVersion: 1,
        data: { languageIds: ["markdown"] },
        supports: ["web"],
      }],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "editor contribution missing both languageIds and filenames",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.editor",
        kind: "editor",
        contractVersion: 1,
        data: {},
        supports: ["web"],
      }],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "view contribution with valid structured when expression",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        when: { op: "defined", key: "editorIsOpen" },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "view contribution with nested when expression (all/any)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        when: {
          op: "all",
          expressions: [
            { op: "defined", key: "editorIsOpen" },
            { op: "any", expressions: [
              { op: "equals", key: "language", value: "markdown" },
              { op: "equals", key: "language", value: "typescript" },
            ]},
          ],
        },
      }],
    },
    schemaValid: true,
    runtimeValid: true,
  },
  {
    label: "view contribution with invalid when operator",
    manifest: {
      ...baseManifest(),
      contributions: [{
        ...baseContribution(),
        when: { op: "invalid-op", key: "editorIsOpen" },
      }],
    },
    schemaValid: false,
    runtimeValid: false,
  },
  {
    label: "shell contribution with when (disallowed)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "varin-workbench-shell/v1",
          seams: {
            web: { replacementTargets: ["workbench.editor"], slots: [] },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
        when: { op: "defined", key: "editorIsOpen" },
      }],
    },
    schemaValid: false, // schema now rejects when on shell contributions
    runtimeValid: false, // runtime rejects when on shell contributions
  },
  {
    label: "transition-scene contribution with when (disallowed)",
    manifest: {
      ...baseManifest(),
      contributions: [{
        id: "dev.example.fixtures.transition",
        kind: "transition-scene",
        contractVersion: 1,
        data: {
          contract: "varin-transition-scene/v1",
          scenes: ["workbench-profile"],
          durations: {
            "workbench-profile": {
              covering: { quick: 100, reduced: 200, standard: 300 },
              revealing: { quick: 100, reduced: 200, standard: 300 },
            },
          },
        },
        supports: ["web"],
        replacement: { target: "workbench.transition" },
        when: { op: "defined", key: "editorIsOpen" },
      }],
    },
    schemaValid: false, // schema now rejects when on transition-scene contributions
    runtimeValid: false, // runtime rejects when on transition-scene contributions
  },
  ...toolFixtures,
];
