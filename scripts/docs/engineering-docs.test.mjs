import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkEngineeringDocs, engineeringDocPaths } from "./check-engineering-docs.mjs"

import {
  collectLocalLinkTargets,
  findOrphanDocs,
  readStatusHeader,
} from "./engineering-docs.mjs"

test("collectLocalLinkTargets returns inline local targets", () => {
  const targets = collectLocalLinkTargets("See [arch](architecture.md) and [rm](../README.md).")
  assert.deepEqual(targets, ["architecture.md", "../README.md"])
})

test("collectLocalLinkTargets skips external schemes and pure anchors", () => {
  const markdown = [
    "[site](https://example.com/a.md)",
    "[insecure](http://example.com)",
    "[mail](mailto:someone@example.com)",
    "[section](#heading)",
    "[real](docs/security.md)",
  ].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), ["docs/security.md"])
})

test("collectLocalLinkTargets strips fragments and decodes escapes", () => {
  const targets = collectLocalLinkTargets("[a](packages/electron/README.md#packaging) [b](a%20b.md)")
  assert.deepEqual(targets, ["packages/electron/README.md", "a b.md"])
})

test("collectLocalLinkTargets reads reference definitions", () => {
  assert.deepEqual(collectLocalLinkTargets("[ref]: docs/recovery.md\n"), ["docs/recovery.md"])
})

test("collectLocalLinkTargets ignores fenced code blocks", () => {
  const markdown = ["```md", "[fake](does-not-exist.md)", "```", "[real](exists.md)"].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), ["exists.md"])
})

test("readStatusHeader extracts delivery status", () => {
  assert.equal(readStatusHeader("# Title\n\nStatus: shipped\n"), "shipped")
})

test("readStatusHeader reports missing headers as null", () => {
  assert.equal(readStatusHeader("# Title\n\nBody.\n"), null)
})

test("findOrphanDocs flags documents nothing references", () => {
  const orphans = findOrphanDocs({
    candidates: ["docs/architecture.md", "docs/orphan-plan.md"],
    referencedPaths: new Set(["docs/architecture.md"]),
  })
  assert.deepEqual(orphans, ["docs/orphan-plan.md"])
})

test("findOrphanDocs honors an explicit allowlist", () => {
  const orphans = findOrphanDocs({
    candidates: ["docs/orphan-plan.md"],
    referencedPaths: new Set(),
    allowlist: { "docs/orphan-plan.md": "intentionally unindexed" },
  })
  assert.deepEqual(orphans, [])
})

const withDocumentation = (extraFiles, run) => {
  const root = mkdtempSync(path.join(tmpdir(), "varin-docs-check-"))
  const files = {
    "docs/README.md": "[Architecture](architecture.md) [Roadmap](roadmap.md)\n",
    "docs/architecture.md": "# Architecture\nStatus: current overview\n",
    "docs/roadmap.md": "# Roadmap\nStatus: future work\n",
    ...extraFiles,
  }
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      writeFileSync(path.join(root, name), text)
    }
    run(root, Object.keys(files))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("repository check follows directory indexes and detects a moved target until its incoming link is repaired", () => {
  withDocumentation({
    "docs/README.md": "[Architecture](architecture.md) [Roadmap](roadmap.md) [Design](design/)\n",
    "docs/design/README.md": "[Topic](topic.md)\n",
    "docs/design/topic.md": "# Topic\n",
  }, (root, paths) => {
    assert.deepEqual(checkEngineeringDocs({ root, paths }).brokenLinks, [])
    assert.deepEqual(checkEngineeringDocs({ root, paths }).unreachableDocs, [])
    renameSync(path.join(root, "docs/design/topic.md"), path.join(root, "docs/design/renamed.md"))
    const moved = paths.map(name => name === "docs/design/topic.md" ? "docs/design/renamed.md" : name)
    const broken = checkEngineeringDocs({ root, paths: moved })
    assert.deepEqual(broken.brokenLinks, [{ source: "docs/design/README.md", target: "topic.md", reason: "missing target" }])
    assert.deepEqual(broken.unreachableDocs, ["docs/design/renamed.md"])
    writeFileSync(path.join(root, "docs/design/README.md"), "[Topic](renamed.md)\n")
    const repaired = checkEngineeringDocs({ root, paths: moved })
    assert.deepEqual(repaired.brokenLinks, [])
    assert.deepEqual(repaired.unreachableDocs, [])
  })
})

test("mutually linked documents are still orphaned when no entrance reaches them", () => {
  withDocumentation({
    "docs/a.md": "[B](b.md)\n",
    "docs/b.md": "[A](a.md)\n",
  }, (root, paths) => {
    const result = checkEngineeringDocs({ root, paths })
    assert.deepEqual(result.brokenLinks, [])
    assert.deepEqual(result.unreachableDocs, ["docs/a.md", "docs/b.md"])
  })
})

test("repository check reports a missing entrance and required overview status", () => {
  withDocumentation({ "docs/architecture.md": "# Architecture\n" }, (root, paths) => {
    rmSync(path.join(root, "docs/README.md"))
    const result = checkEngineeringDocs({ root, paths })
    assert.deepEqual(result.missingStatuses, ["docs/architecture.md"])
    assert.ok(result.brokenLinks.some(link => link.reason === "missing documentation entrance"))
  })
})

test("link discovery ignores inline examples and tilde fences but retains links with code in their labels", () => {
  const markdown = [
    "`[example](missing.md)`",
    "~~~md", "[example](also-missing.md)", "~~~",
    "[The `real` document](present.md)",
  ].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), ["present.md"])
})

test("Git discovery checks new documents and unstaged moves without reading deleted index paths", () => {
  withDocumentation({
    "docs/README.md": "[Architecture](architecture.md) [Roadmap](roadmap.md) [Topic](topic.md)\n",
    "docs/topic.md": "# Topic\n",
  }, (root) => {
    execFileSync("git", ["init", "--quiet", root])
    execFileSync("git", ["-C", root, "add", "."])
    renameSync(path.join(root, "docs/topic.md"), path.join(root, "docs/moved.md"))
    writeFileSync(path.join(root, "docs/README.md"), "[Architecture](architecture.md) [Roadmap](roadmap.md) [Topic](moved.md)\n")
    const discovered = engineeringDocPaths(root)
    assert.ok(discovered.includes("docs/moved.md"))
    const result = checkEngineeringDocs({ root, paths: discovered })
    assert.deepEqual(result.brokenLinks, [])
    assert.deepEqual(result.unreachableDocs, [])
  })
})
