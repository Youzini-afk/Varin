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
  VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID,
  VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
  VARIN_WORKBENCH_BOT_PROFILE_ID,
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

test("missing storage seeds Agent, IDE, Research, and Bot bindings without persisting a migration", async () => {
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
    VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
    VARIN_WORKBENCH_BOT_PROFILE_ID,
  ]);
  const shellByProfileSurface = Object.fromEntries(missing.document.layouts.map((layer) => (
    [`${layer.profileId}:${layer.surface}`, layer.replacementSelections["workbench.shell"]]
  )));
  assert.equal(shellByProfileSurface["default:web"], VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface["varin.ide:web"], VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_RESEARCH_PROFILE_ID}:web`], VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID);
  assert.equal(shellByProfileSurface[`${VARIN_WORKBENCH_BOT_PROFILE_ID}:web`], VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID);
  const again = await store.read();
  assert.equal(again.storageState, "missing");
  assert.equal(again.document.revision, 0);
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
