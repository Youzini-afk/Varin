import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeHarnessSettings,
  resolveHarnessContextSettings,
  resolveHarnessReviewSettings,
  resolveHarnessNextStepSettings,
  resolveHarnessDocumentReadingSettings,
  resolveHarnessCodeRetrievalSettings,
  HarnessSettingsValidationError,
  HarnessInferenceSettingsValidationError,
  parseHarnessEmbeddingSettings,
  parseHarnessRerankSettings,
} from "../src/index.js";

describe("harness settings", () => {
  it("workspace overrides user for top-level keys", () => {
    const merged = mergeHarnessSettings(
      { shell: "powershell" },
      { shell: "wsl" },
    );
    assert.equal(merged.shell, "wsl");
  });

  it("keeps the code retrieval judgment choice user-owned", () => {
    assert.equal(mergeHarnessSettings({}, {}).codeRetrieval.decision, "auto");
    assert.equal(mergeHarnessSettings(
      { codeRetrieval: { decision: "llm" } },
      { codeRetrieval: { decision: "rerank" } },
    ).codeRetrieval.decision, "llm");
    assert.equal(mergeHarnessSettings({ codeRetrieval: { decision: "unknown" as never } }, {}).codeRetrieval.decision,
      "source");
    assert.throws(() => resolveHarnessCodeRetrievalSettings({ decision: "unknown" }), HarnessSettingsValidationError);
  });

  it("deep-merges nested objects (depth 1)", () => {
    const merged = mergeHarnessSettings(
      { output: { visibleBytes: 16384 } },
      { bash: { waitMs: 120000 } },
    );
    assert.equal(merged.output.visibleBytes, 16384);
    assert.equal(merged.bash.waitMs, 120000);
    // Non-overridden defaults preserved
    assert.equal(merged.dispatch.concurrency, 12);
  });

  it("lets a workspace add dispatch prompts but not remove a user prompt", () => {
    const merged = mergeHarnessSettings(
      { dispatch: { concurrency: 12, askBefore: { edit: true } } },
      { dispatch: { concurrency: 12, askBefore: { edit: false, write: true } } },
    );
    assert.equal(merged.dispatch.askBefore.edit, true);
    assert.equal(merged.dispatch.askBefore.write, true);
  });

  it("keeps user-memory auto-accept user-owned while workspace memory remains overridable", () => {
    const merged = mergeHarnessSettings(
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: true, user: false } } },
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: false, user: true } } },
    );
    // A workspace must be able to turn off auto-accept that the user enabled globally.
    assert.equal(merged.knowledge.autoAcceptSuggestions.workspace, false);
    assert.equal(merged.knowledge.autoAcceptSuggestions.user, false);
  });

  it("keeps user autoAcceptSuggestions when the workspace does not set them", () => {
    const merged = mergeHarnessSettings(
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: true, user: false } } },
      {},
    );
    assert.equal(merged.knowledge.autoAcceptSuggestions.workspace, true);
    assert.equal(merged.knowledge.autoAcceptSuggestions.user, false);
  });

  it("workspace tools override user tools", () => {
    const merged = mergeHarnessSettings(
      { tools: { bash: true, grep: false } },
      { tools: { grep: true } },
    );
    assert.equal(merged.tools.bash, true);
    assert.equal(merged.tools.grep, true);
  });

  it("keeps embedding and rerank bindings user-owned and ignores chat model slots", () => {
    const merged = mergeHarnessSettings({
      models: { explore: { providerId: "openai", modelId: "gpt-4o" } },
      embedding: { protocol: "openai-compatible", providerId: "openai", modelId: "text-embedding-3-small", dimensions: 1024 },
      rerank: { protocol: "http-rerank", providerId: "cohere", modelId: "rerank-v3.5" },
    }, {
      embedding: { protocol: "openai-compatible", providerId: "workspace", modelId: "redirected" },
      rerank: { protocol: "http-rerank", providerId: "workspace", modelId: "redirected" },
    });
    assert.deepEqual(merged.embedding, {
      protocol: "openai-compatible",
      providerId: "openai",
      modelId: "text-embedding-3-small",
      dimensions: 1024,
    });
    assert.deepEqual(merged.rerank, {
      protocol: "http-rerank",
      providerId: "cohere",
      modelId: "rerank-v3.5",
    });
    assert.equal(merged.models.explore?.modelId, "gpt-4o");
    assert.equal(mergeHarnessSettings({
      models: { explore: { providerId: "openai", modelId: "gpt-4o" } },
    }, {}).embedding, undefined);
    assert.equal(mergeHarnessSettings({}, {
      embedding: { protocol: "openai-compatible", providerId: "workspace", modelId: "redirected" },
      rerank: { protocol: "http-rerank", providerId: "workspace", modelId: "redirected" },
    }).embedding, undefined);
    assert.equal(mergeHarnessSettings({}, {
      embedding: { protocol: "openai-compatible", providerId: "workspace", modelId: "redirected" },
      rerank: { protocol: "http-rerank", providerId: "workspace", modelId: "redirected" },
    }).rerank, undefined);
  });

  it("distinguishes missing inference settings from malformed bindings", () => {
    assert.equal(parseHarnessEmbeddingSettings(undefined), undefined);
    assert.equal(parseHarnessRerankSettings(undefined), undefined);
    for (const value of [null, false, {}, { protocol: "other", providerId: "p", modelId: "m" }]) {
      assert.throws(() => parseHarnessEmbeddingSettings(value), HarnessInferenceSettingsValidationError);
    }
    assert.throws(() => parseHarnessEmbeddingSettings({
      protocol: "openai-compatible", providerId: "p", modelId: "m", dimensions: 0,
    }), /dimensions/);
    assert.throws(() => parseHarnessEmbeddingSettings({
      protocol: "openai-compatible", providerId: "p", modelId: "m", maxTokens: 1.5,
    }), /maxTokens/);
    assert.throws(() => parseHarnessRerankSettings({
      protocol: "http-rerank", providerId: "p", modelId: "m", endpoint: "https://project.invalid",
    }), /provider-relative/);
    assert.throws(() => parseHarnessRerankSettings({
      protocol: "http-rerank", providerId: "p", modelId: "m", maxDocumentTokens: -1,
    }), /maxDocumentTokens/);
    assert.equal(mergeHarnessSettings({
      embedding: { protocol: "openai-compatible", providerId: "p", modelId: "m", dimensions: 0 },
    } as never, {}).embedding, undefined, "a malformed optional binding must not prevent ordinary session settings from resolving");
  });

  it("does not let workspace settings redirect model slots", () => {
    const merged = mergeHarnessSettings(
      { models: { check: { providerId: "trusted", modelId: "user-model" } } },
      { models: { check: { providerId: "workspace", modelId: "redirected" } } },
    );
    assert.deepEqual(merged.models.check, { providerId: "trusted", modelId: "user-model" });
  });

  it("defaults background preparation on and maps the legacy memory opt-out", () => {
    assert.deepEqual(mergeHarnessSettings({}, {}).context, {
      backgroundPreparation: true,
      preparationWaterline: 0.75,
    });
    assert.deepEqual(resolveHarnessContextSettings(undefined, { mode: "off" }), {
      backgroundPreparation: false,
      preparationWaterline: 0.75,
    });
    assert.deepEqual(resolveHarnessContextSettings(undefined, { shadowMode: false }), {
      backgroundPreparation: false,
      preparationWaterline: 0.75,
    });
    // A retired mode that kept background work on does not disable preparation.
    assert.equal(
      resolveHarnessContextSettings(undefined, { mode: "takeover" }).backgroundPreparation,
      true,
    );
    // An explicit context setting wins over the legacy mapping.
    assert.equal(
      resolveHarnessContextSettings({ backgroundPreparation: true }, { mode: "off" }).backgroundPreparation,
      true,
    );
    assert.equal(
      mergeHarnessSettings({ context: { backgroundPreparation: false } }, {}).context.backgroundPreparation,
      false,
    );
  });

  it("keeps automatic review user-owned and defaults to disabled non-blocking", () => {
    assert.deepEqual(mergeHarnessSettings({}, {}).review, { enabled: false, gate: false });
    assert.deepEqual(mergeHarnessSettings(
      { review: { enabled: false, gate: true } },
      { review: { enabled: true, gate: false } },
    ).review, { enabled: false, gate: true });
    assert.deepEqual(mergeHarnessSettings(
      { review: { enabled: false } },
      {},
    ).review, { enabled: false, gate: false });
  });

  it("keeps next-step selection user-owned, disabled by default, and separate from knowledge suggestions", () => {
    assert.deepEqual(mergeHarnessSettings({}, {}).nextStep, { enabled: false });
    assert.equal(mergeHarnessSettings({}, { nextStep: { enabled: true } }).nextStep.enabled, false);
    assert.equal(mergeHarnessSettings({ nextStep: { enabled: true } }, {}).nextStep.enabled, true);
    assert.equal(mergeHarnessSettings({ models: { knowledgeSuggestions: { providerId: "p", modelId: "knowledge" } } }, {}).models.knowledgeSuggestions?.modelId, "knowledge");
  });

  it("rejects malformed next-step settings", () => {
    assert.throws(() => resolveHarnessNextStepSettings(false), HarnessSettingsValidationError);
    assert.throws(() => resolveHarnessNextStepSettings({ enabled: "yes" }), HarnessSettingsValidationError);
  });

  it("defaults optional document parsers, restores defaults for blank values, and keeps them user-owned", () => {
    assert.deepEqual(resolveHarnessDocumentReadingSettings(undefined), {
      doclingCommand: "docling",
      tesseractCommand: "tesseract",
      ocrLanguage: "eng",
    });
    assert.deepEqual(resolveHarnessDocumentReadingSettings({
      doclingCommand: "  C:\\Tools\\docling.exe  ",
      ocrLanguage: "fra+eng",
    }), {
      doclingCommand: "C:\\Tools\\docling.exe",
      tesseractCommand: "tesseract",
      ocrLanguage: "fra+eng",
    });
    assert.deepEqual(resolveHarnessDocumentReadingSettings({
      doclingCommand: " ",
      tesseractCommand: "",
      ocrLanguage: "  ",
    }), {
      doclingCommand: "docling",
      tesseractCommand: "tesseract",
      ocrLanguage: "eng",
    });
    assert.deepEqual(mergeHarnessSettings(
      { documentReading: { doclingCommand: "user-docling", ocrLanguage: "deu" } },
      { documentReading: { doclingCommand: "project-docling", tesseractCommand: "project-tesseract" } },
    ).documentReading, {
      doclingCommand: "user-docling",
      tesseractCommand: "tesseract",
      ocrLanguage: "deu",
    });
    assert.throws(() => resolveHarnessDocumentReadingSettings(false), /must be an object/);
    assert.throws(() => resolveHarnessDocumentReadingSettings({ tesseractCommand: 5 }), /must be a string/);
  });

  it("keeps ordinary harness merging available for malformed optional parser settings", () => {
    const malformed = { doclingCommand: 7 };
    assert.deepEqual(mergeHarnessSettings({ documentReading: malformed }, {}).documentReading, {
      doclingCommand: "docling",
      tesseractCommand: "tesseract",
      ocrLanguage: "eng",
    });
    assert.throws(
      () => resolveHarnessDocumentReadingSettings(malformed),
      HarnessSettingsValidationError,
    );
  });

  it("rejects malformed review settings", () => {
    assert.throws(() => resolveHarnessReviewSettings({ enabled: "yes" }), HarnessSettingsValidationError);
    assert.throws(() => resolveHarnessReviewSettings(false), /must be an object/);
  });

  it("does not let a workspace change the user-owned background preparation setting", () => {
    assert.equal(mergeHarnessSettings(
      {},
      { context: { backgroundPreparation: false } },
    ).context.backgroundPreparation, true);
    assert.equal(mergeHarnessSettings(
      { context: { backgroundPreparation: false } },
      { context: { backgroundPreparation: true } },
    ).context.backgroundPreparation, false);
  });

  it("rejects malformed context settings", () => {
    assert.throws(
      () => resolveHarnessContextSettings({ backgroundPreparation: "yes" }, undefined),
      HarnessSettingsValidationError,
    );
    assert.throws(
      () => resolveHarnessContextSettings({ preparationWaterline: 1.5 }, undefined),
      /between 0 and 1/,
    );
    assert.throws(() => resolveHarnessContextSettings(false, undefined), /must be an object/);
  });

  it("keeps web search provider, credential, and renderer selection user-owned", () => {
    const merged = mergeHarnessSettings({
      web: {
        search: { provider: "brave", credentialRef: "brave-search" },
        render: false,
        domains: { allow: ["example.com"], block: ["blocked.example.com"] },
      },
    }, {
      web: {
        search: { provider: "searxng", endpoint: "http://workspace.invalid" },
        render: true,
        domains: { allow: ["docs.example.com", "outside.test"], block: ["ads.example.com"] },
      },
    });
    assert.deepEqual(merged.web?.search, { provider: "brave", credentialRef: "brave-search" });
    assert.equal(merged.web?.render, false);
    assert.deepEqual(merged.web?.domains, {
      allow: ["docs.example.com"],
      block: ["blocked.example.com", "ads.example.com"],
    });
  });

  it("preserves an explicit empty web allow intersection as deny-all", () => {
    const merged = mergeHarnessSettings(
      { web: { domains: { allow: ["example.com"] } } },
      { web: { domains: { allow: ["other.test"] } } },
    );
    assert.deepEqual(merged.web?.domains, { allow: [], block: [] });
  });

  it("only accepts stricter workspace permission modes and ask/deny rules", () => {
    const tightened = mergeHarnessSettings(
      { permissions: { mode: "accept-edits", rules: [{ tool: "bash", decision: "allow" }] } },
      { permissions: {
        mode: "normal",
        rules: [
          { tool: "bash", decision: "allow" },
          { tool: "bash", match: { param: "command", pattern: "^deploy" }, decision: "deny" },
        ],
      } },
    );
    assert.equal(tightened.permissions?.mode, "normal");
    assert.deepEqual(tightened.permissions?.rules?.map((rule) => rule.decision), ["deny", "allow"]);

    const notLoosened = mergeHarnessSettings(
      { permissions: { mode: "normal", rules: [] } },
      { permissions: { mode: "bypass", rules: [] } },
    );
    assert.equal(notLoosened.permissions?.mode, "normal");
  });

  it("requires Smart mode to be explicitly enabled by the user", () => {
    assert.equal(mergeHarnessSettings(
      { permissions: { mode: "normal", rules: [] } },
      { permissions: { mode: "smart", rules: [] } },
    ).permissions?.mode, "normal");
    assert.equal(mergeHarnessSettings(
      { permissions: { mode: "smart", rules: [] } },
      {},
    ).permissions?.mode, "smart");
  });
});
