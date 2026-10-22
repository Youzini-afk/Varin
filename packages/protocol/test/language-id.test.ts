import assert from "node:assert/strict";
import { test } from "node:test";
import { editorLanguageIdForLanguage, languageIdForPath } from "../src/index.js";

test("language identity is independent of path format and keeps Host/editor aliases distinct", () => {
  for (const [path, host, editor] of [
    ["/workspace/scripts/setup.SH", "shellscript", "shell"],
    ["C:\\workspace\\App.TSX", "typescriptreact", "typescript"],
    ["views/App.jsx", "javascriptreact", "javascript"],
    ["src/main.rs", "rust", "rust"],
    ["src/model.py", "python", "python"],
    ["src/model.pyi", "python", "python"],
    ["scripts/setup.PS1", "powershell", "powershell"],
    ["scripts/setup.psm1", "powershell", "powershell"],
    ["views/App.vue", "vue", "vue"],
    ["views/App.svelte", "svelte", "svelte"],
    ["lib/main.dart", "dart", "dart"],
    ["infra/main.tf", "terraform", "terraform"],
    ["modules/box.ex", "elixir", "elixir"],
    ["scripts/init.fish", "fish", "fish"],
    ["scripts/init.zsh", "zsh", "zsh"],
    ["containers/Dockerfile", "dockerfile", "dockerfile"],
  ]) {
    assert.equal(languageIdForPath(path!), host);
    assert.equal(editorLanguageIdForLanguage(host!), editor);
  }
  for (const path of ["", "/workspace/", "README", "notes.unknown", "folder.rs/README"]) {
    assert.equal(languageIdForPath(path), null, path);
  }
});
