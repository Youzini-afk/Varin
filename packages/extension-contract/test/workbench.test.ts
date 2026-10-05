import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultVarinWorkbenchProfileDocument,
  inspectVarinWorkbenchShell,
  migrateVarinWorkbenchProfileDocument,
  parseVarinWorkbenchLayoutLayer,
  parseVarinWorkbenchProfileApplyRequest,
  parseVarinWorkbenchProfileDocument,
  parseVarinWorkbenchShellContributionData,
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_SURFACES,
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL,
  VARIN_WORKBENCH_IDE_PROFILE_ID,
  VARIN_WORKBENCH_IDE_PROFILE_LABEL,
  VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
  VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL,
  VARIN_WORKBENCH_CONTEXT_KEYS,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
  VARIN_WORKBENCH_SLOTS,
  resolveVarinWorkbenchLayout,
  resolveVarinWorkbenchLayoutForProfile,
  resolveVarinWorkbenchProfile,
  resolveVarinWorkbenchShellSurfaceSeams,
} from "../src/index.js";

test("workbench profile resolution layers distribution, user, and workspace without dropping missing references", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.layouts = [
    {
      profileId: "default",
      references: [{ contributionId: "dev.example.missing", region: "right", visible: true }],
      replacementSelections: { "workbench.shell": "dev.example.shell.base" },
      scope: "distribution",
      scopeId: "default",
      surface: "web",
    },
    {
      profileId: "default",
      references: [{ contributionId: "dev.example.missing", order: 20, visible: false }],
      replacementSelections: { "chat.composer": "dev.example.composer" },
      scope: "user",
      scopeId: "default",
      surface: "web",
    },
    {
      profileId: "default",
      references: [{ contributionId: "dev.example.panel", size: 360 }],
      replacementSelections: { "workbench.shell": "dev.example.shell.workspace" },
      scope: "workspace",
      scopeId: "/workspace",
      surface: "web",
    },
  ];
  const resolved = resolveVarinWorkbenchLayout(parseVarinWorkbenchProfileDocument(document), {
    surface: "web",
    userId: "default",
    workspaceId: "/workspace",
  });
  assert.deepEqual(resolved.replacementSelections, {
    "chat.composer": "dev.example.composer",
    "workbench.shell": "dev.example.shell.workspace",
  });
  assert.deepEqual(resolved.references, [
    { contributionId: "dev.example.missing", order: 20, region: "right", visible: false },
    { contributionId: "dev.example.panel", size: 360 },
  ]);
});

test("workbench profile selection is user-scoped while workspace layers remain project-scoped", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.profileSelections.users.default = VARIN_WORKBENCH_IDE_PROFILE_ID;
  const resolved = resolveVarinWorkbenchLayout(document, {
    surface: "web",
    userId: "default",
    workspaceId: "/workspace",
  });
  assert.equal(resolved.profileId, VARIN_WORKBENCH_IDE_PROFILE_ID);

  const candidate = resolveVarinWorkbenchLayoutForProfile(document, {
    surface: "web",
    userId: "default",
    workspaceId: "/workspace",
  }, VARIN_WORKBENCH_RESEARCH_PROFILE_ID);
  assert.equal(candidate.profileId, VARIN_WORKBENCH_RESEARCH_PROFILE_ID);
  assert.equal(document.profileSelections.users.default, VARIN_WORKBENCH_IDE_PROFILE_ID);
});

test("legacy workspace profile selections are discarded during document parsing", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  const parsed = parseVarinWorkbenchProfileDocument({
    ...document,
    profileSelections: {
      users: {},
      workspaces: { "/legacy": VARIN_WORKBENCH_IDE_PROFILE_ID },
    },
  });
  assert.deepEqual(parsed.profileSelections, { users: {} });
});

test("workbench profile documents reject duplicate layer and contribution identities", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  const layer = {
    profileId: "default",
    references: [
      { contributionId: "dev.example.panel" },
      { contributionId: "dev.example.panel" },
    ],
    replacementSelections: {},
    scope: "distribution",
    scopeId: "default",
    surface: "web",
  };
  document.layouts = [layer as never];
  assert.throws(() => parseVarinWorkbenchProfileDocument(document), /duplicate contribution IDs/);
});

test("workbench profiles retain explicit extension sets and validate apply revisions", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.profiles[0] = {
    ...document.profiles[0]!,
    extensionIds: ["dev.example.alpha", "dev.example.beta"],
  };
  const parsed = parseVarinWorkbenchProfileDocument(document);
  assert.deepEqual(parsed.profiles[0]?.extensionIds, ["dev.example.alpha", "dev.example.beta"]);
  assert.deepEqual(parseVarinWorkbenchProfileApplyRequest({
    expectedCatalogRevision: 7,
    profileId: "default",
  }), {
    expectedCatalogRevision: 7,
    profileId: "default",
  });
  assert.throws(
    () => parseVarinWorkbenchProfileDocument({
      ...document,
      profiles: [{ ...document.profiles[0], extensionIds: ["dev.example.alpha", "dev.example.alpha"] }],
    }),
    /duplicates/,
  );
});

const catalogEntry = (options: {
  enabled: boolean;
  failed?: boolean;
  contributionId: string;
  extensionId: string;
  supports?: Array<"desktop" | "mobile" | "web">;
}) => ({
  actual: options.failed
    ? [{
      desiredRevision: 1,
      diagnostics: [],
      entrypointId: "main",
      generation: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmId: "surface",
      realmKind: "surface" as const,
      status: "failed" as const,
      updatedAt: "2026-08-20T00:00:00.000Z",
    }]
    : [],
  capabilityGrants: [],
  desired: { enabled: options.enabled, revision: 1, updatedAt: "2026-08-20T00:00:00.000Z" },
  installedAt: "2026-08-20T00:00:00.000Z",
  manifest: {
    engines: { varin: "*" },
    id: options.extensionId,
    schemaVersion: 1 as const,
    version: "1.0.0",
    contributions: [{
      contractVersion: 1,
      data: {},
      id: options.contributionId,
      kind: "shell" as const,
      supports: options.supports ?? ["web", "desktop"],
    }],
  },
  resolvedVersion: "1.0.0",
  selectedVersion: "1.0.0",
  source: { display: options.extensionId, kind: "local" as const },
  updatedAt: "2026-08-20T00:00:00.000Z",
});

test("workbench slot and replacement target constants are valid contribution IDs", () => {
  for (const id of [...Object.values(VARIN_WORKBENCH_REPLACEMENT_TARGETS), ...Object.values(VARIN_WORKBENCH_SLOTS)]) {
    parseVarinWorkbenchLayoutLayer({
      profileId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
      references: [{ contributionId: id }],
      replacementSelections: { [id]: id },
      scope: "distribution",
      scopeId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
      surface: "web",
    });
  }
});

test("workbench profile resolution inspects shell availability without mutating enablement", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.profiles.push({ id: "studio", label: "Studio" });
  document.layouts = [{
    profileId: "studio",
    references: [],
    replacementSelections: { [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: "dev.example.shell" },
    scope: "distribution",
    scopeId: "studio",
    surface: "web",
  }];
  const context = { surface: "web" as const, userId: "default" };
  const original = structuredClone(document);
  const builtin = resolveVarinWorkbenchProfile(document, [], context);
  assert.equal(builtin.status, "builtin");
  assert.equal(builtin.profileId, VARIN_WORKBENCH_DEFAULT_PROFILE_ID);

  const candidate = resolveVarinWorkbenchLayoutForProfile(document, context, "studio");
  assert.equal(candidate.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell], "dev.example.shell");
  assert.deepEqual(document, original);

  const extensions = [catalogEntry({
    enabled: false,
    contributionId: "dev.example.shell",
    extensionId: "dev.example.workbench",
  })];
  assert.equal(inspectVarinWorkbenchShell(candidate.replacementSelections, extensions, "web").status, "disabled");
  assert.equal(extensions[0]?.desired.enabled, false);

  document.profileSelections.users.default = "studio";
  const disabled = resolveVarinWorkbenchProfile(document, extensions, context);
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.shellExtensionId, "dev.example.workbench");

  extensions[0]!.desired.enabled = true;
  assert.equal(resolveVarinWorkbenchProfile(document, extensions, context).status, "ready");
  extensions[0]!.actual = catalogEntry({
    enabled: true,
    failed: true,
    contributionId: "dev.example.shell",
    extensionId: "dev.example.workbench",
  }).actual;
  assert.equal(resolveVarinWorkbenchProfile(document, extensions, context).status, "failed");
  assert.equal(inspectVarinWorkbenchShell(
    candidate.replacementSelections,
    extensions,
    "web",
    {
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmIds: ["another-surface"],
    },
  ).status, "ready");
  assert.equal(inspectVarinWorkbenchShell(
    candidate.replacementSelections,
    extensions,
    "web",
    {
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmIds: ["surface"],
    },
  ).status, "failed");
  assert.equal(resolveVarinWorkbenchProfile(document, [], context).status, "missing");
});

test("default Agent profile seeds the official shell on web, desktop, and mobile", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  assert.equal(document.activeProfileId, VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  assert.equal(document.profiles[0]?.label, VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL);
  assert.equal(document.revision, 0);
  const agentLayouts = document.layouts.filter((layer) => layer.profileId === VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  assert.deepEqual(
    agentLayouts.map((layer) => layer.surface).sort(),
    [...VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES].sort(),
  );
  for (const surface of VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES) {
    const resolved = resolveVarinWorkbenchLayout(document, { surface, userId: "default" });
    assert.equal(
      resolved.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell],
      VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
    );
  }
  assert.equal(migrateVarinWorkbenchProfileDocument(document), false);
});

test("distribution includes an optional IDE profile without making it active", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  assert.equal(document.activeProfileId, VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  assert.ok(document.profiles.some((profile) => (
    profile.id === VARIN_WORKBENCH_IDE_PROFILE_ID && profile.label === VARIN_WORKBENCH_IDE_PROFILE_LABEL
  )));
  for (const surface of VARIN_BUILTIN_IDE_WORKBENCH_SURFACES) {
    const resolved = resolveVarinWorkbenchLayoutForProfile(document, { surface, userId: "default" }, VARIN_WORKBENCH_IDE_PROFILE_ID);
    assert.equal(
      resolved.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell],
      VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
    );
  }
  const mobileIde = resolveVarinWorkbenchLayoutForProfile(
    document,
    { surface: "mobile", userId: "default" },
    VARIN_WORKBENCH_IDE_PROFILE_ID,
  );
  assert.equal(mobileIde.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell], undefined);
});

test("distribution includes the Research profile and shell on every supported surface", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  assert.ok(document.profiles.some((profile) => (
    profile.id === VARIN_WORKBENCH_RESEARCH_PROFILE_ID
    && profile.label === VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL
  )));
  const researchLayouts = document.layouts.filter((layer) => layer.profileId === VARIN_WORKBENCH_RESEARCH_PROFILE_ID);
  assert.deepEqual(
    researchLayouts.map((layer) => layer.surface).sort(),
    ["desktop", "mobile", "web"],
  );
});

test("migrates missing IDE profiles without changing the active Agent selection", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.profiles = document.profiles.filter((profile) => profile.id !== VARIN_WORKBENCH_IDE_PROFILE_ID);
  document.layouts = document.layouts.filter((layer) => layer.profileId !== VARIN_WORKBENCH_IDE_PROFILE_ID);
  assert.equal(migrateVarinWorkbenchProfileDocument(document), true);
  assert.equal(document.activeProfileId, VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  assert.ok(document.profiles.some((profile) => profile.id === VARIN_WORKBENCH_IDE_PROFILE_ID));
  const web = document.layouts.find((layer) => (
    layer.profileId === VARIN_WORKBENCH_IDE_PROFILE_ID && layer.surface === "web"
  ));
  assert.equal(web?.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell], VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(migrateVarinWorkbenchProfileDocument(document), false);
});

test("migrates the legacy Default profile onto Agent Workspace without clobbering a chosen shell", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.profiles[0] = { id: VARIN_WORKBENCH_DEFAULT_PROFILE_ID, label: "Default" };
  document.layouts = [{
    profileId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
    references: [],
    replacementSelections: { [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: "dev.example.community.shell" },
    scope: "distribution",
    scopeId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
    surface: "web",
  }];
  assert.equal(migrateVarinWorkbenchProfileDocument(document), true);
  assert.equal(document.profiles[0]?.label, VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL);
  const shellByProfileSurface = Object.fromEntries(document.layouts.map((layer) => (
    [`${layer.profileId}:${layer.surface}`, layer.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]]
  )));
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_DEFAULT_PROFILE_ID}:web`], "dev.example.community.shell");
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_DEFAULT_PROFILE_ID}:desktop`], VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_DEFAULT_PROFILE_ID}:mobile`], VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_IDE_PROFILE_ID}:web`], VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_IDE_PROFILE_ID}:desktop`], VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(migrateVarinWorkbenchProfileDocument(document), false);
});

test("migrates missing Agent shells without replacing a chosen IDE shell", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.layouts = [{
    profileId: VARIN_WORKBENCH_IDE_PROFILE_ID,
    references: [],
    replacementSelections: { [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: "dev.example.community.ide" },
    scope: "distribution",
    scopeId: VARIN_WORKBENCH_IDE_PROFILE_ID,
    surface: "web",
  }];
  assert.equal(migrateVarinWorkbenchProfileDocument(document), true);
  const webIde = document.layouts.find((layer) => (
    layer.profileId === VARIN_WORKBENCH_IDE_PROFILE_ID && layer.surface === "web"
  ));
  assert.equal(webIde?.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell], "dev.example.community.ide");
  const desktopIde = document.layouts.find((layer) => (
    layer.profileId === VARIN_WORKBENCH_IDE_PROFILE_ID && layer.surface === "desktop"
  ));
  assert.equal(desktopIde?.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell], VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(document.activeProfileId, VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
});

test("resolves the official Agent Workspace shell without mutating enablement", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  const extensions = [catalogEntry({
    enabled: false,
    contributionId: VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
    extensionId: VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
    supports: ["web", "desktop", "mobile"],
  })];
  const context = { surface: "web" as const, userId: "default" };
  const disabled = resolveVarinWorkbenchProfile(document, extensions, context);
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.shellExtensionId, VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID);
  assert.equal(extensions[0]?.desired.enabled, false);

  extensions[0]!.desired.enabled = true;
  const ready = resolveVarinWorkbenchProfile(document, extensions, context);
  assert.equal(ready.status, "ready");
  assert.equal(ready.shellContributionId, VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
});

test("resolves the official IDE Workbench on web and desktop without forcing mobile", () => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.activeProfileId = VARIN_WORKBENCH_IDE_PROFILE_ID;
  const extensions = [catalogEntry({
    enabled: false,
    contributionId: VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
    extensionId: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
    supports: ["web", "desktop"],
  })];
  const web = resolveVarinWorkbenchProfile(document, extensions, { surface: "web", userId: "default" });
  assert.equal(web.status, "disabled");
  assert.equal(web.shellContributionId, VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(extensions[0]?.desired.enabled, false);
  extensions[0]!.desired.enabled = true;
  assert.equal(resolveVarinWorkbenchProfile(document, extensions, { surface: "web", userId: "default" }).status, "ready");
  assert.equal(resolveVarinWorkbenchProfile(document, extensions, { surface: "desktop", userId: "default" }).status, "ready");
  assert.equal(resolveVarinWorkbenchProfile(document, extensions, { surface: "mobile", userId: "default" }).status, "builtin");
});

// ---------------------------------------------------------------------------
// Shell seam contract tests
// ---------------------------------------------------------------------------

const agentSeams = {
  contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
  seams: {
    web: {
      replacementTargets: [
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
      ],
      slots: [],
    },
    desktop: {
      replacementTargets: [
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
      ],
      slots: [],
    },
    mobile: {
      replacementTargets: [
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
        VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
      ],
      slots: [],
    },
  },
};

test("parses a complete Agent shell seam declaration", () => {
  const parsed = parseVarinWorkbenchShellContributionData(agentSeams, ["web", "desktop", "mobile"]);
  assert.equal(parsed.contract, VARIN_WORKBENCH_SHELL_DATA_CONTRACT);
  const webSeams = resolveVarinWorkbenchShellSurfaceSeams(parsed, "web");
  assert.deepEqual(webSeams, agentSeams.seams.web);
  const mobileSeams = resolveVarinWorkbenchShellSurfaceSeams(parsed, "mobile");
  assert.ok(!mobileSeams.replacementTargets.includes(VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer));
});

test("rejects a supported surface missing from seams", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      { contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT, seams: { web: { replacementTargets: [], slots: [] } } },
      ["web", "desktop"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("missing")) === true,
  );
});

test("rejects a seam for an unsupported surface", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: { replacementTargets: [], slots: [] },
          mobile: { replacementTargets: [], slots: [] },
        },
      },
      ["web"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("not in contribution supports")) === true,
  );
});

test("rejects duplicate replacement targets within a surface", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: ["sessions.navigator", "sessions.navigator"],
            slots: [],
          },
        },
      },
      ["web"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("duplicate")) === true,
  );
});

test("rejects workbench.shell as a nested target", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell],
            slots: [],
          },
        },
      },
      ["web"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("recursive")) === true,
  );
});

test("rejects workbench.transition as a nested target", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition],
            slots: [],
          },
        },
      },
      ["web"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("recursive")) === true,
  );
});

test("rejects a malformed contract string", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      { contract: "wrong", seams: { web: { replacementTargets: [], slots: [] } } },
      ["web"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("contract")) === true,
  );
});

test("rejects the same identifier in both replacementTargets and slots", () => {
  assert.throws(
    () => parseVarinWorkbenchShellContributionData(
      {
        contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: ["workbench.panel"],
            slots: ["workbench.panel"],
          },
        },
      },
      ["web"],
    ),
    (err: Error & { issues?: string[] }) => err.issues?.some((i) => i.includes("both")) === true,
  );
});

test("resolves empty seams for an undeclared surface", () => {
  const parsed = parseVarinWorkbenchShellContributionData(
    { contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT, seams: { web: { replacementTargets: [], slots: [] } } },
    ["web"],
  );
  const desktop = resolveVarinWorkbenchShellSurfaceSeams(parsed, "desktop");
  assert.deepEqual(desktop, { replacementTargets: [], slots: [] });
});

test("allows unknown third-party targets in seams", () => {
  const parsed = parseVarinWorkbenchShellContributionData(
    {
      contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
      seams: {
        web: {
          replacementTargets: ["my.custom.target"],
          slots: ["my.custom.slot"],
        },
      },
    },
    ["web"],
  );
  const webSeams = resolveVarinWorkbenchShellSurfaceSeams(parsed, "web");
  assert.ok(webSeams.replacementTargets.includes("my.custom.target"));
  assert.ok(webSeams.slots.includes("my.custom.slot"));
});

test("public workbench context keys stay stable identifiers", () => {
  assert.equal(VARIN_WORKBENCH_CONTEXT_KEYS.editorIsOpen, "editorIsOpen");
  assert.equal(VARIN_WORKBENCH_CONTEXT_KEYS.editorIsDirty, "editorIsDirty");
  assert.equal(VARIN_WORKBENCH_CONTEXT_KEYS.editorHasSelection, "editorHasSelection");
  assert.equal(VARIN_WORKBENCH_SLOTS.primarySidebarViews, "workbench.primary-sidebar.views");
  assert.equal(VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell, "workbench.shell");
  assert.equal(VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor, "workbench.editor");
});
