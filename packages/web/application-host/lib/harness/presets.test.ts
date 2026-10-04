import { describe, it, expect } from "vitest";
import { resolvePresets, buildTeamPrompt, EXECUTION_PRESETS } from "./presets.js";
import type { ModelSelection } from "@varin/protocol";

const mainModel: ModelSelection = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const haiku: ModelSelection = { providerId: "anthropic", modelId: "claude-haiku" };

describe("resolvePresets", () => {
  it("returns all presets when all slots configured", () => {
    const presets = resolvePresets({
      quickImplement: haiku,
      hardImplement: mainModel,
      frontend: haiku,
      retrievalAgent: haiku,
      check: haiku,
      review: mainModel,
    }, mainModel);
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("quick-implement");
    expect(ids).toContain("hard-implement");
    expect(ids).toContain("frontend");
    expect(ids).toContain("review");
    expect(ids).toContain("check");
    expect(ids).toContain("retrieval");
  });

  it("hardImplement and frontend expose nest tools through the preset catalog", () => {
    expect(EXECUTION_PRESETS["hard-implement"].tools).toEqual(expect.arrayContaining([
      "dispatch", "threads", "wait", "send", "read_thread", "merge", "kill",
    ]));
    expect(EXECUTION_PRESETS.frontend.tools).toEqual(expect.arrayContaining([
      "dispatch", "threads", "wait",
    ]));
    expect(EXECUTION_PRESETS.review.tools).not.toContain("dispatch");
    expect(EXECUTION_PRESETS.retrieval.tools).not.toContain("dispatch");
    expect(EXECUTION_PRESETS.retrieval.tools).not.toEqual(expect.arrayContaining([
      "bash", "edit", "write", "apply_patch",
    ]));
    expect(EXECUTION_PRESETS.retrieval.tools).toEqual(expect.arrayContaining([
      "read", "grep", "find", "ls", "explore", "related", "recall", "submit_facts",
    ]));
  });

  it("hardImplement defaults to main when unset", () => {
    const presets = resolvePresets({}, mainModel);
    const hard = presets.find((p) => p.id === "hard-implement");
    expect(hard).toBeDefined();
    expect(hard?.model).toEqual(mainModel);
  });

  it("review defaults to main when unset", () => {
    const presets = resolvePresets({}, mainModel);
    const review = presets.find((p) => p.id === "review");
    expect(review).toBeDefined();
    expect(review?.model).toEqual(mainModel);
  });

  it("omits presets with unconfigured non-defaulting slots", () => {
    const presets = resolvePresets({}, mainModel);
    // Only the two slots that default to the main model remain (§9.2.2).
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("hard-implement");
    expect(ids).toContain("review");
    expect(ids).not.toContain("quick-implement");
    expect(ids).not.toContain("frontend");
    expect(ids).not.toContain("check");
    expect(ids).not.toContain("retrieval");
  });

  it("frontend uses its own slot and is omitted when that slot is unset", () => {
    const withoutFrontend = resolvePresets({ hardImplement: mainModel }, mainModel);
    expect(withoutFrontend.find((p) => p.id === "frontend")).toBeUndefined();

    const withFrontend = resolvePresets({ frontend: haiku }, mainModel);
    expect(withFrontend.find((p) => p.id === "frontend")?.model).toEqual(haiku);
  });

  it("omits every preset when there is no main model and no slots", () => {
    expect(resolvePresets({}, null)).toEqual([]);
  });
});

describe("buildTeamPrompt", () => {
  it("describes task-centered dispatch even with no presets", () => {
    const prompt = buildTeamPrompt([]);
    expect(prompt).toContain("dispatch(task)");
    expect(prompt).toContain("current model and tools");
    expect(prompt).not.toContain("Available presets:");
  });

  it("includes preset names and descriptions without fixed model labels", () => {
    const presets = resolvePresets({
      quickImplement: haiku,
      hardImplement: mainModel,
      check: haiku,
    }, mainModel);
    const prompt = buildTeamPrompt(presets);
    expect(prompt).toContain("dispatch(task)");
    expect(prompt).toContain("quick-implement (mechanical, well-specified changes)");
    expect(prompt).toContain("hard-implement (ambiguous or cross-cutting work)");
    expect(prompt).toContain("check (run tests/lint and report)");
    expect(prompt).not.toContain("cheap model");
    expect(prompt).not.toContain("strong model");
    expect(prompt).toContain("wait blocks until a teammate changes state");
  });

  it("omits unconfigured presets from the prompt", () => {
    const presets = resolvePresets({ check: haiku }, mainModel);
    const prompt = buildTeamPrompt(presets);
    expect(prompt).toContain("check");
    expect(prompt).not.toContain("quick-implement");
    expect(prompt).not.toContain("retrieval");
  });

  it("prompt is static for same preset set", () => {
    const presets = resolvePresets({ quickImplement: haiku, check: haiku }, mainModel);
    const prompt1 = buildTeamPrompt(presets);
    const prompt2 = buildTeamPrompt(presets);
    expect(prompt1).toBe(prompt2);
  });
});

describe("EXECUTION_PRESETS", () => {
  it("check has read-only + bash tools", () => {
    const tools = EXECUTION_PRESETS["check"].tools;
    expect(tools).toContain("bash");
    expect(tools).toContain("read");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  it("write-capable presets default to isolated WorkingState; none forces shared", () => {
    for (const preset of Object.values(EXECUTION_PRESETS)) {
      expect(preset.worktree === "isolated" || preset.worktree === "none").toBe(true);
    }
    expect(EXECUTION_PRESETS.retrieval.worktree).toBe("none");
    expect(EXECUTION_PRESETS.review.worktree).toBe("none");
    expect(EXECUTION_PRESETS["quick-implement"].worktree).toBe("isolated");
    expect(EXECUTION_PRESETS.check.worktree).toBe("isolated");
  });

  it("does not publish unenforced per-preset token or turn ceilings", () => {
    for (const preset of Object.values(EXECUTION_PRESETS)) {
      expect(preset).not.toHaveProperty("budget");
    }
  });
});
