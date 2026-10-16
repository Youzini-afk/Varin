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
    ["containers/Dockerfile", "dockerfile", "dockerfile"],
  ]) {
    assert.equal(languageIdForPath(path!), host);
    assert.equal(editorLanguageIdForLanguage(host!), editor);
  }
  for (const path of ["", "/workspace/", "README", "notes.unknown", "folder.rs/README"]) {
    assert.equal(languageIdForPath(path), null, path);
  }
});
