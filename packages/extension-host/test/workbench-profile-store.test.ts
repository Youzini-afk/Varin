import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExtensionStorageRevisionConflictError,
  ExtensionStorageStore,
  WorkbenchProfileStore,
} from "../src/index.js";
import {
  VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  VARIN_WORKBENCH_BOT_PROFILE_ID,
  defaultVarinWorkbenchProfileDocument,
  resolveVarinWorkbenchLayout,
} from "@varin/extension-contract";

const directories: string[] = [];
test.after(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

test("workbench layouts persist replacement choices and retain missing contribution references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-workbench-profile-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const missing = await store.read();
  assert.equal(missing.storageState, "missing");
  const written = await store.updateLayout({
    expectedRevision: 0,
    layer: {
      profileId: "default",
      references: [{ contributionId: "dev.example.not-installed", region: "right" }],
      replacementSelections: { "workbench.shell": "dev.example.alternative-shell" },
      scope: "workspace",
      scopeId: "/workspace",
      surface: "web",
    },
  });
  assert.equal(written.document.revision, 1);
  const restarted = new WorkbenchProfileStore({ hostId: written.hostId, storage: new ExtensionStorageStore(dataDir) });
  assert.deepEqual((await restarted.read()).document.layouts, written.document.layouts);
  await assert.rejects(
    store.updateLayout({ expectedRevision: 0, layer: written.document.layouts[0] as never }),
    ExtensionStorageRevisionConflictError,
  );
});

test("migrates raw filesystem workspace layout ids while rejecting workspace profile selection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-workbench-workspace-id-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const canonicalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await store.updateLayout({
    expectedRevision: 0,
    layer: {
      profileId: "default",
      references: [],
      replacementSelections: {},
      scope: "workspace",
      scopeId: "/workspace/demo",
      surface: "web",
    },
  });
  store.setWorkspaceScopeResolver(async (scopeId) => (
    scopeId === "/workspace/demo" || scopeId === canonicalId ? canonicalId : null
  ));
  const migrated = await store.read();
  assert.equal(migrated.document.layouts.find((layer) => layer.scope === "workspace")?.scopeId, canonicalId);
  assert.throws(
    () => store.selectProfile({
        expectedRevision: migrated.document.revision,
        profileId: "default",
        scope: "workspace",
        scopeId: "/workspace/demo",
      }),
    /Profile selection scope is unsupported/,
  );
});

test("missing storage seeds Agent, IDE, and Bot bindings without persisting a migration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-workbench-agent-default-"));
  directories.push(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage: new ExtensionStorageStore(dataDir),
  });
  const missing = await store.read();
  assert.equal(missing.storageState, "missing");
  assert.equal(missing.document.revision, 0);
  assert.equal(missing.document.profiles[0]?.label, "Agent");
  assert.deepEqual(missing.document.profiles.map((profile) => profile.id), [
    "default",
    "varin.ide",
    VARIN_WORKBENCH_BOT_PROFILE_ID,
  ]);
  const shellByProfileSurface = Object.fromEntries(missing.document.layouts.map((layer) => (
    [`${layer.profileId}:${layer.surface}`, layer.replacementSelections["workbench.shell"]]
  )));
  assert.equal(shellByProfileSurface["default:web"], VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface["varin.ide:web"], VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_BOT_PROFILE_ID}:web`], VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  const again = await store.read();
  assert.equal(again.storageState, "missing");
  assert.equal(again.document.revision, 0);
});

test("retires a persisted Research selection once and keeps other workspace choices", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-retired-research-profile-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const document = defaultVarinWorkbenchProfileDocument();
  document.profiles.push({ id: "varin.research", label: "Research" }, { id: "example.team", label: "Team",
    extensionIds: ["example.tools", "varin.builtin.research-workbench"] });
  document.activeProfileId = "varin.research";
  document.profileSelections.users = { default: "varin.research", editor: "varin.ide", team: "example.team" };
  document.layouts.push({ profileId: "varin.research", scope: "distribution", scopeId: "varin.research", surface: "desktop",
    replacementSelections: { "workbench.shell": "varin.builtin.research-workbench.shell" }, references: [] });
  document.layouts.push({ profileId: "example.team", scope: "distribution", scopeId: "example.team", surface: "desktop",
    replacementSelections: { "workbench.shell": "varin.builtin.research-workbench.shell", "chat.composer": "example.composer" },
    references: [{ contributionId: "example.panel", region: "right" }, { contributionId: "varin.builtin.research-workbench.shell" }] });
  await storage.update({ extensionId: "varin.core.workbench", key: "profiles", scope: "application" }, 0, 1,
    JSON.parse(JSON.stringify(document)));
  const store = new WorkbenchProfileStore({ hostId: "host", storage });
  const migrated = await store.read();
  assert.equal(migrated.authoritative, true);
  assert.equal(migrated.document.activeProfileId, "default");
  assert.deepEqual(migrated.document.profileSelections.users, { default: "default", editor: "varin.ide", team: "example.team" });
  assert.ok(!migrated.document.profiles.some(profile => profile.id === "varin.research"));
  assert.ok(!migrated.document.layouts.some(layer => layer.profileId === "varin.research"));
  const layout = resolveVarinWorkbenchLayout(migrated.document, { surface: "desktop", userId: "team" });
  assert.equal(layout.replacementSelections["workbench.shell"], VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  assert.equal(layout.replacementSelections["chat.composer"], "example.composer");
  assert.equal(layout.references[0]?.contributionId, "example.panel");
  assert.equal(layout.references.length, 1);
  assert.deepEqual(migrated.document.profiles.find(profile => profile.id === "example.team")?.extensionIds,
    ["example.tools", "varin.builtin.agent-workspace"]);
  assert.equal(migrated.document.revision, 2);
  const restarted = new WorkbenchProfileStore({ hostId: "host", storage: new ExtensionStorageStore(dataDir) });
  assert.equal((await restarted.read()).document.revision, migrated.document.revision);
});

test("migrates persisted Default profiles onto Agent Workspace without replacing a chosen shell", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-workbench-agent-migrate-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const address = {
    extensionId: "varin.core.workbench",
    key: "profiles",
    scope: "application",
  } as const;
  await storage.update(address, 0, 1, {
    activeProfileId: "default",
    layouts: [{
      profileId: "default",
      references: [],
      replacementSelections: { "workbench.shell": "dev.example.community.shell" },
      scope: "distribution",
      scopeId: "default",
      surface: "web",
    }],
    profileSelections: { users: {} },
    profiles: [{ id: "default", label: "Default" }],
  });
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const migrated = await store.read();
  assert.equal(migrated.storageState, "ready");
  assert.equal(migrated.document.revision, 2);
  assert.equal(migrated.document.profiles[0]?.label, "Agent");
  const shellByProfileSurface = Object.fromEntries(
    migrated.document.layouts.map((layer) => (
      [`${layer.profileId}:${layer.surface}`, layer.replacementSelections["workbench.shell"]]
    )),
  );
  assert.equal(shellByProfileSurface["default:web"], "dev.example.community.shell");
  assert.equal(shellByProfileSurface["default:desktop"], "varin.builtin.agent-workspace.shell");
  assert.equal(shellByProfileSurface["default:mobile"], "varin.builtin.agent-workspace.shell");
  assert.equal(shellByProfileSurface["varin.ide:web"], "varin.builtin.ide-workbench.shell");
  assert.equal(shellByProfileSurface["varin.ide:desktop"], "varin.builtin.ide-workbench.shell");
  const unchanged = await store.read();
  assert.equal(unchanged.document.revision, migrated.document.revision);
});

test("migrates Agent shells without replacing a chosen IDE shell", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-workbench-ide-migrate-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  await storage.update({
    extensionId: "varin.core.workbench",
    key: "profiles",
    scope: "application",
  }, 0, 1, {
    activeProfileId: "default",
    layouts: [{
      profileId: "varin.ide",
      references: [],
      replacementSelections: { "workbench.shell": "dev.example.community.ide" },
      scope: "distribution",
      scopeId: "varin.ide",
      surface: "web",
    }],
    profileSelections: { users: {} },
    profiles: [
      { id: "default", label: "Agent" },
      { id: "varin.ide", label: "IDE" },
    ],
  });
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const migrated = await store.read();
  const webIde = migrated.document.layouts.find((layer) => (
    layer.profileId === "varin.ide" && layer.surface === "web"
  ));
  assert.equal(webIde?.replacementSelections["workbench.shell"], "dev.example.community.ide");
  const desktopIde = migrated.document.layouts.find((layer) => (
    layer.profileId === "varin.ide" && layer.surface === "desktop"
  ));
  assert.equal(desktopIde?.replacementSelections["workbench.shell"], "varin.builtin.ide-workbench.shell");
  assert.equal(migrated.document.activeProfileId, "default");
});

test("a reviewed profile holds its original storage revision until the related Catalog decision finishes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-workbench-review-")); directories.push(dataDir);
  const store = new WorkbenchProfileStore({ hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a", storage: new ExtensionStorageStore(dataDir) });
  const original = await store.upsertProfile({ expectedRevision: 0,
    profile: { id: "reviewed", label: "Reviewed", extensionIds: ["dev.example.original"] } });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  const applying = store.withRevision(original.document.revision, async document => {
    assert.deepEqual(document.profiles.find(profile => profile.id === "reviewed")?.extensionIds, ["dev.example.original"]);
    entered(); await held; events.push("catalog-commit");
  });
  await ready;
  const update = store.upsertProfile({ expectedRevision: original.document.revision,
    profile: { id: "reviewed", label: "Changed", extensionIds: ["dev.example.other"] } }).then(() => { events.push("profile-commit"); });
  release(); await Promise.all([applying, update]);
  assert.deepEqual(events, ["catalog-commit", "profile-commit"]);
  await assert.rejects(store.withRevision(original.document.revision, async () => { throw new Error("must not run"); }), ExtensionStorageRevisionConflictError);
});
