import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkEngineeringDocs, engineeringDocErrors, engineeringDocPaths } from "./check-engineering-docs.mjs"
import { collectLocalLinkTargets } from "./engineering-docs.mjs"

test("collect local inline and reference links with URL suffixes and escaped paths", () => {
  const markdown = [
    "See [arch](architecture.md) and [root](../README.md).",
    "[package](packages/electron/README.md#packaging) [asset](a%20b.md?download=1#section)",
    "[reference]: docs/recovery.md",
  ].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), [
    "architecture.md", "../README.md", "packages/electron/README.md", "a b.md", "docs/recovery.md",
  ])
})

test("ignore external URLs, same-page links and code examples, retaining links with code labels", () => {
  const markdown = [
    "[site](https://example.com/a.md) [insecure](http://example.com)",
    "[cdn](//example.com/a.md) [mail](mailto:someone@example.com)",
    "[section](#heading) [query](?view=1#heading)",
    "`[example](missing.md)`",
    "```md", "[example](also-missing.md)", "```",
    "~~~md", "[example](still-missing.md)", "~~~",
    "[The `real` document](present.md)",
  ].join("\n")
  assert.deepEqual(collectLocalLinkTargets(markdown), ["present.md"])
})

const withDocumentation = (files, run) => {
  const root = mkdtempSync(path.join(tmpdir(), "varin-docs-check-"))
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

test("check existing files and directories, and report moved or outside-repository targets", () => {
  withDocumentation({
    "docs/README.md": "[Design](design/) [Asset](assets/note%20one.txt?download=1)\n",
    "docs/design/README.md": "[Topic](topic.md#details)\n",
    "docs/design/topic.md": "# Topic\n",
    "docs/assets/note one.txt": "Asset\n",
  }, (root, paths) => {
    assert.deepEqual(engineeringDocErrors(checkEngineeringDocs({ root, paths })), [])
    renameSync(path.join(root, "docs/design/topic.md"), path.join(root, "docs/design/renamed.md"))
    const moved = paths.map(name => name === "docs/design/topic.md" ? "docs/design/renamed.md" : name)
    const broken = checkEngineeringDocs({ root, paths: moved })
    assert.deepEqual(broken.brokenLinks, [{ source: "docs/design/README.md", target: "topic.md", reason: "missing target" }])
    writeFileSync(path.join(root, "docs/design/README.md"), "[Topic](renamed.md)\n")
    assert.deepEqual(engineeringDocErrors(checkEngineeringDocs({ root, paths: moved })), [])
    writeFileSync(path.join(root, "docs/design/README.md"), "[Outside](../../../outside.md)\n")
    assert.deepEqual(engineeringDocErrors(checkEngineeringDocs({ root, paths: moved })), [
      "docs/design/README.md: outside repository: ../../../outside.md",
    ])
  })
})

test("Git discovery checks new documents and unstaged moves without reading deleted index paths", () => {
  withDocumentation({
    "docs/README.md": "[Topic](topic.md)\n",
    "docs/topic.md": "# Topic\n",
  }, (root) => {
    execFileSync("git", ["init", "--quiet", root])
    execFileSync("git", ["-C", root, "add", "."])
    renameSync(path.join(root, "docs/topic.md"), path.join(root, "docs/moved.md"))
    writeFileSync(path.join(root, "docs/README.md"), "[Topic](moved.md)\n")
    const discovered = engineeringDocPaths(root)
    assert.ok(discovered.includes("docs/moved.md"))
    assert.deepEqual(engineeringDocErrors(checkEngineeringDocs({ root, paths: discovered })), [])
    writeFileSync(path.join(root, "docs/new.md"), "[Broken](missing.md)\n")
    assert.deepEqual(engineeringDocErrors(checkEngineeringDocs({ root, paths: engineeringDocPaths(root) })), [
      "docs/new.md: missing target: missing.md",
    ])
  })
})
