import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { DEFAULT_HARNESS_SETTINGS, HARNESS_TOOL_META, type HarnessSettings } from "@varin/protocol";

function createBridge(): HostServicesBridge {
  return new HostServicesBridge({
    emit: () => {},
    sessionId: "test",
    defaultTimeoutMs: 5000,
  });
}

const baseDeps = {
  bridge: createBridge(),
  sessionId: "test",
  cwd: "/tmp",
  workspaceMutationJournal: undefined,
  isOpenAIFamily: false,
  webSearchAvailable: true,
  researchSearchAvailable: true,
};

const webSettings: HarnessSettings = {
  ...DEFAULT_HARNESS_SETTINGS,
  web: { search: { provider: "searxng", endpoint: "https://search.example.test" } },
};

it("recognizes every registered Harness tool in permission and mutation classification", () => {
  const tools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
    ...baseDeps, isOpenAIFamily: true, documentReadAvailable: true, documentPathOverlayAvailable: true,
    lspNavigationAvailable: true, threadRuntimeAvailable: true, experimentAvailable: true,
    settingsAvailable: true, materialsAvailable: true, followUpAvailable: true, scheduledTasksAvailable: true,
    sessionToolAllowlist: ["submit_facts"],
  });
  for (const tool of tools) assert.ok(HARNESS_TOOL_META[tool.name], `unclassified Harness tool: ${tool.name}`);
});

describe("selectHarnessTools web tool gating", () => {
  it("includes webfetch and Host-backed websearch when both are available", () => {
    const tools = selectHarnessTools(webSettings, baseDeps);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("webfetch"));
    assert.ok(names.includes("websearch"));
  });

  it("keeps native web tools even when pi-web-access is installed elsewhere", () => {
    const tools = selectHarnessTools(webSettings, baseDeps);
    const names = tools.map((t) => t.name);
    assert.equal(names.includes("webfetch"), true);
    assert.equal(names.includes("websearch"), true);
  });

  it("omits webfetch when disabled in settings", () => {
    const settings: HarnessSettings = {
      ...webSettings,
      tools: { webfetch: false },
    };
    const tools = selectHarnessTools(settings, baseDeps);
    const names = tools.map((t) => t.name);
    assert.equal(names.includes("webfetch"), false);
    assert.ok(names.includes("websearch"));
  });

  it("omits websearch when disabled in settings", () => {
    const settings: HarnessSettings = {
      ...webSettings,
      tools: { websearch: false },
    };
    const tools = selectHarnessTools(settings, baseDeps);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("webfetch"));
    assert.equal(names.includes("websearch"), false);
  });

  it("omits websearch when the Host has no real provider service", () => {
    const tools = selectHarnessTools(webSettings, {
      ...baseDeps,
      webSearchAvailable: false,
    });
    assert.equal(tools.some((tool) => tool.name === "websearch"), false);
  });

  it("includes default websearch without a search provider or model account", () => {
    const tools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, baseDeps);
    assert.equal(tools.some((tool) => tool.name === "websearch"), true);
    assert.equal(tools.some((tool) => tool.name === "webfetch"), true);
  });

  it("exposes research_decide for Web-only sessions", () => {
    const tools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      researchSearchAvailable: false,
    });
    assert.equal(tools.some((tool) => tool.name === "research_decide"), true);
  });

  it("includes scholarly discovery independently of a configured search provider", () => {
    const tools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      webSearchAvailable: false,
      researchSearchAvailable: true,
    });
    assert.equal(tools.some((tool) => tool.name === "research_search"), true);
    const disabled = selectHarnessTools({ ...DEFAULT_HARNESS_SETTINGS, tools: { research_search: false } }, {
      ...baseDeps,
      researchSearchAvailable: true,
    });
    assert.equal(disabled.some((tool) => tool.name === "research_search"), false);
  });
});

describe("selectHarnessTools document read gating", () => {
  it("registers the native read override only when the Host advertises its source service", () => {
    const unavailable = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, baseDeps);
    const available = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      documentReadAvailable: true,
    });

    assert.equal(unavailable.some((tool) => tool.name === "read"), false);
    assert.equal(available.filter((tool) => tool.name === "read").length, 1);
  });

  it("leaves Pi's built-in read in place when the override is disabled", () => {
    const settings: HarnessSettings = {
      ...DEFAULT_HARNESS_SETTINGS,
      tools: { read: false },
    };
    const tools = selectHarnessTools(settings, {
      ...baseDeps,
      documentReadAvailable: true,
    });

    assert.equal(tools.some((tool) => tool.name === "read"), false);
  });
});

describe("selectHarnessTools document path overlay gating", () => {
  it("registers same-name find and ls overrides only when the Host advertises the overlay", () => {
    const unavailable = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, baseDeps);
    const available = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      documentPathOverlayAvailable: true,
    });
    assert.equal(unavailable.some((tool) => tool.name === "find"), false);
    assert.equal(unavailable.some((tool) => tool.name === "ls"), false);
    assert.equal(available.filter((tool) => tool.name === "find").length, 1);
    assert.equal(available.filter((tool) => tool.name === "ls").length, 1);
  });

  it("keeps each built-in when the corresponding setting disables its override", () => {
    const settings: HarnessSettings = {
      ...DEFAULT_HARNESS_SETTINGS,
      tools: { find: false, ls: false },
    };
    const tools = selectHarnessTools(settings, {
      ...baseDeps,
      documentPathOverlayAvailable: true,
    });
    assert.equal(tools.some((tool) => tool.name === "find"), false);
    assert.equal(tools.some((tool) => tool.name === "ls"), false);
  });
});

describe("selectHarnessTools submit_facts gating", () => {
  it("registers submit_facts only on a frozen retrieval allowlist", () => {
    const root = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      threadRuntimeAvailable: true,
    }).map((tool) => tool.name);
    assert.equal(root.includes("submit_facts"), false);

    const child = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      threadRuntimeAvailable: false,
      sessionToolAllowlist: ["read", "explore", "related", "submit_facts"],
    }).map((tool) => tool.name);
    assert.equal(child.includes("submit_facts"), true);
    assert.equal(child.includes("dispatch"), false);
  });
});
