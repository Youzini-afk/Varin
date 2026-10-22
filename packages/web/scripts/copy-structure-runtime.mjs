#!/usr/bin/env node
/**
 * Place the pinned tree-sitter runtime and grammar wasm next to the Host
 * structure module. Grammars come from the pinned npm packages (ABI-compatible
 * with web-tree-sitter 0.27). Do not pull the tree-sitter-wasms 0.1.13 pack —
 * those artifacts lack dylink.0.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(webRoot, "application-host", "lib", "structure", "runtime");
const force = process.argv.includes("--force");
// Checked-in wasm in destDir is the source of truth (D-101). This script
// skips existing files larger than 1 KiB; pass --force to refresh from npm.

const log = (message) => process.stdout.write(`[copy-structure-runtime] ${message}\n`);

fs.mkdirSync(destDir, { recursive: true });

const copyIfNeeded = (source, destName) => {
  const dest = path.join(destDir, destName);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    log(`keep ${destName}`);
    return;
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Missing structure runtime source: ${source}`);
  }
  fs.copyFileSync(source, dest);
  log(`copied ${destName} from ${source} (${fs.statSync(dest).size} bytes)`);
};

const packageRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));

const webTreeSitterWasm = fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
copyIfNeeded(webTreeSitterWasm, "web-tree-sitter.wasm");

const typescriptRoot = packageRoot("tree-sitter-typescript");
copyIfNeeded(path.join(typescriptRoot, "tree-sitter-typescript.wasm"), "tree-sitter-typescript.wasm");
copyIfNeeded(path.join(typescriptRoot, "tree-sitter-tsx.wasm"), "tree-sitter-tsx.wasm");

const javascriptRoot = packageRoot("tree-sitter-javascript");
copyIfNeeded(path.join(javascriptRoot, "tree-sitter-javascript.wasm"), "tree-sitter-javascript.wasm");

const jsonRoot = packageRoot("tree-sitter-json");
copyIfNeeded(path.join(jsonRoot, "tree-sitter-json.wasm"), "tree-sitter-json.wasm");

// The common-language grammars are checked into runtime/ so production, Web,
// and Electron builds stay offline and reproducible. The committed manifest is
// the sole list and digest authority: a missing, changed, or query-less pack
// must fail the build instead of silently turning a language into parser-only
// support.
const manifestPath = path.join(webRoot, "application-host", "lib", "structure", "grammar-packs.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const customQueryAliases = { shellscript: "tree-sitter-bash.tags.scm", csharp: "tree-sitter-csharp.tags.scm" };
const queryFileFor = (languageId, grammarFile) => {
  return customQueryAliases[languageId] ?? grammarFile.replace(/\.wasm$/i, ".tags.scm");
};
const sha256 = (file) => `sha256-${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;

const validateBundledGrammars = async () => {
  const { Parser, Language, Query } = await import("web-tree-sitter");
  const runtimeWasm = fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
  await Parser.init({ locateFile: () => runtimeWasm });
  let checked = 0;
  for (const [languageId, pack] of Object.entries(manifest.packs ?? {})) {
    const grammarPath = path.join(destDir, pack.grammarFile);
    if (!fs.existsSync(grammarPath)) throw new Error(`Missing bundled grammar for ${languageId}: ${grammarPath}`);
    const bytes = fs.statSync(grammarPath).size;
    if (bytes !== pack.bytes || sha256(grammarPath) !== pack.integrity) {
      throw new Error(`Bundled grammar digest/size does not match grammar-packs.json for ${languageId}`);
    }
    const queryPath = path.join(destDir, pack.bundledQueryFile ?? queryFileFor(languageId, pack.grammarFile));
    if (!fs.existsSync(queryPath) || fs.statSync(queryPath).size === 0) {
      throw new Error(`Missing bundled structure query for ${languageId}: ${queryPath}`);
    }
    const queryIntegrity = pack.bundledQueryIntegrity ?? (customQueryAliases[languageId] ? null : pack.tagsIntegrity);
    if (queryIntegrity && sha256(queryPath) !== queryIntegrity) {
      throw new Error(`Bundled upstream structure query digest does not match grammar-packs.json for ${languageId}`);
    }
    const language = await Language.load(grammarPath);
    const query = new Query(language, fs.readFileSync(queryPath, "utf8"));
    query.delete();
    language.delete?.();
    checked += 1;
  }
  return checked;
};

const bundledGrammarCount = await validateBundledGrammars();
log(`runtime assets ready in ${destDir} (${bundledGrammarCount} manifest grammars, wasm digests and queries compiled)`);
