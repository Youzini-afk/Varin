#!/usr/bin/env node
/**
 * Publish-time grammar pack manifest (D-125).
 *
 * Packs each candidate from npm, extracts the published wasm and its
 * `queries/tags.scm`, hashes both ourselves, records ABI via web-tree-sitter,
 * and compiles the query against the grammar so an advertised pack is one that
 * actually produces an outline. The committed JSON is the authority — runtime
 * does not trust a network-supplied digest.
 *
 * By default every candidate is fetched at the version already recorded in the
 * committed manifest, so a re-run reproduces the same versions and digests.
 * Pass `--latest` to move packs forward to the newest published version.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const webRoot = path.join(repoRoot, "packages", "web");
const require = createRequire(path.join(webRoot, "package.json"));
const destPath = path.join(
  webRoot,
  "application-host",
  "lib",
  "structure",
  "grammar-packs.json",
);

/** Plan 3.11 coverage targets, keyed by protocol language ids (D-127). */
const CANDIDATES = [
  { languageId: "python", packages: ["tree-sitter-python"] },
  { languageId: "go", packages: ["tree-sitter-go"] },
  { languageId: "rust", packages: ["tree-sitter-rust"] },
  { languageId: "java", packages: ["tree-sitter-java"] },
  { languageId: "c", packages: ["tree-sitter-c"] },
  { languageId: "cpp", packages: ["tree-sitter-cpp"] },
  { languageId: "csharp", packages: ["tree-sitter-c-sharp"] },
  { languageId: "kotlin", packages: ["tree-sitter-kotlin", "@tree-sitter-grammars/tree-sitter-kotlin"] },
  { languageId: "swift", packages: ["tree-sitter-swift"] },
  { languageId: "ruby", packages: ["tree-sitter-ruby"] },
  { languageId: "php", packages: ["tree-sitter-php"] },
  { languageId: "shellscript", packages: ["tree-sitter-bash"] },
  { languageId: "css", packages: ["tree-sitter-css"] },
  { languageId: "html", packages: ["tree-sitter-html"] },
  { languageId: "yaml", packages: ["tree-sitter-yaml", "@tree-sitter-grammars/tree-sitter-yaml"] },
  { languageId: "toml", packages: ["tree-sitter-toml", "@tree-sitter-grammars/tree-sitter-toml"] },
  { languageId: "markdown", packages: ["tree-sitter-markdown", "@tree-sitter-grammars/tree-sitter-markdown"] },
  { languageId: "xml", packages: ["tree-sitter-xml", "@tree-sitter-grammars/tree-sitter-xml"] },
];

const log = (message) => process.stdout.write(`[refresh-grammar-manifest] ${message}\n`);

const integrityOf = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

const registryUrl = (packageName) => (
  `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`
);

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
};

const downloadTo = async (url, dest) => {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(dest));
};

const preferredWasm = (languageId, files) => {
  const names = files.filter((file) => file.endsWith(".wasm"));
  if (names.length === 0) return null;
  const exact = names.find((file) => file.endsWith(`tree-sitter-${languageId}.wasm`))
    ?? names.find((file) => /tree-sitter-[^/]+\.wasm$/.test(file) && !file.includes("_"));
  return exact ?? names[0];
};

const licenseFile = (files) => (
  files.find((file) => /(?:^|\/)(?:license|copying|licence)(?:\.[^/]+)?$/i.test(file)) ?? null
);

const TAGS_ENTRY = /(?:^|\/)queries\/tags\.scm$/;

// Several common grammars publish a wasm parser without an upstream tags.scm.
// Their checked-in runtime query is compiled here as a release check; it is
// intentionally not written into `tagsPath`, because that field names a file
// inside the npm tarball used by the on-demand installer. The bundled Host
// wires these queries directly from runtime/.
const BUNDLED_QUERY_FILES = {
  shellscript: "tree-sitter-bash.tags.scm",
  csharp: "tree-sitter-csharp.tags.scm",
  css: "tree-sitter-css.tags.scm",
  html: "tree-sitter-html.tags.scm",
  kotlin: "tree-sitter-kotlin.tags.scm",
  yaml: "tree-sitter-yaml.tags.scm",
  toml: "tree-sitter-toml.tags.scm",
};

const inspectPackage = async (languageId, packageName, workDir, runtime, pinnedVersion, committed) => {
  let metadata;
  try {
    metadata = await fetchJson(registryUrl(packageName));
  } catch (error) {
    return { skip: `${packageName}: registry lookup failed (${error instanceof Error ? error.message : error})` };
  }
  const version = pinnedVersion ?? metadata["dist-tags"]?.latest;
  const versionMeta = version ? metadata.versions?.[version] : null;
  if (!version || !versionMeta?.dist?.tarball) {
    return {
      skip: pinnedVersion
        ? `${packageName}: pinned version ${pinnedVersion} is not on npm`
        : `${packageName}: no latest tarball on npm`,
    };
  }
  const tarballPath = path.join(workDir, `${packageName.replace(/[\\/@]/g, "_")}-${version}.tgz`);
  await downloadTo(versionMeta.dist.tarball, tarballPath);
  const extractDir = path.join(workDir, `${packageName.replace(/[\\/@]/g, "_")}-${version}`);
  await fs.mkdir(extractDir, { recursive: true });
  const { extract } = require("tar");
  await extract({ file: tarballPath, cwd: extractDir });
  const files = [];
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  await walk(extractDir);
  // Collections contain several parsers. Keep the exact admitted artifact path.
  const wasmRelative = committed?.wasmPath ?? preferredWasm(languageId, files);
  if (!wasmRelative) {
    return { skip: `${packageName}@${version}: tarball has no .wasm` };
  }
  const wasmBytes = await fs.readFile(path.join(extractDir, wasmRelative));
  const language = await runtime.loadGrammar(path.join(extractDir, wasmRelative));

  // A grammar with no usable tags query installs but cannot answer anything, so
  // the query is verified here rather than discovered by a user (D-128).
  let tagsPath = null;
  let tagsIntegrity = null;
  let tagsNote = null;
  let bundledQueryValidated = false;
  const tagsRelative = files.find((file) => TAGS_ENTRY.test(file.replace(/\\/g, "/")));
  if (!tagsRelative) {
    tagsNote = "no queries/tags.scm";
  } else {
    const tagsBytes = await fs.readFile(path.join(extractDir, tagsRelative));
    try {
      runtime.compileQuery(language, tagsBytes.toString("utf8"));
      tagsPath = tagsRelative.replace(/\\/g, "/");
      tagsIntegrity = integrityOf(tagsBytes);
    } catch (error) {
      tagsNote = `tags.scm did not compile (${error instanceof Error ? error.message.split("\n")[0] : error})`;
    }
  }
  const bundledQueryFile = committed?.bundledQueryFile ?? BUNDLED_QUERY_FILES[languageId];
  let bundledQueryIntegrity;
  if (bundledQueryFile) {
    const bundledQueryPath = path.join(
      webRoot,
      "application-host",
      "lib",
      "structure",
      "runtime",
      bundledQueryFile,
    );
    try {
      const bundledQuery = await fs.readFile(bundledQueryPath, "utf8");
      runtime.compileQuery(language, bundledQuery);
      bundledQueryIntegrity = integrityOf(Buffer.from(bundledQuery));
      bundledQueryValidated = true;
      tagsNote = `${tagsNote ? `${tagsNote}; ` : ""}bundled ${bundledQueryFile} compiled`;
    } catch (error) {
      tagsNote = `${tagsNote ? `${tagsNote}; ` : ""}bundled query did not compile (${error instanceof Error ? error.message.split("\n")[0] : error})`;
    }
  }

  return {
    pack: {
      languageId,
      packageName,
      version,
      tarballUrl: versionMeta.dist.tarball,
      wasmPath: wasmRelative.replace(/\\/g, "/"),
      grammarFile: path.posix.basename(wasmRelative.replace(/\\/g, "/")),
      integrity: integrityOf(wasmBytes),
      bytes: wasmBytes.byteLength,
      abi: language.abiVersion,
      licensePath: licenseFile(files)?.replace(/\\/g, "/") ?? null,
      tagsPath,
      tagsIntegrity,
      ...(bundledQueryFile && bundledQueryValidated ? { bundledQueryFile, bundledQueryIntegrity } : {}),
    },
    tagsNote,
    bundledQueryValidated,
  };
};

const loadWebTreeSitter = async () => {
  const { Parser, Language, Query, MIN_COMPATIBLE_VERSION, LANGUAGE_VERSION } = await import(
    pathToFileURL(require.resolve("web-tree-sitter")).href
  );
  const wasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => wasm });
  return {
    // web-tree-sitter 0.27 window. Named exports are missing from some builds.
    min: typeof MIN_COMPATIBLE_VERSION === "number" ? MIN_COMPATIBLE_VERSION : 13,
    max: typeof LANGUAGE_VERSION === "number" ? LANGUAGE_VERSION : 15,
    loadGrammar: (grammarPath) => Language.load(grammarPath),
    compileQuery: (language, source) => {
      const query = new Query(language, source);
      query.delete();
    },
  };
};

const readCommittedVersions = async () => {
  try {
    const committed = JSON.parse(await fs.readFile(destPath, "utf8"));
    const byLanguage = new Map();
    for (const [languageId, pack] of Object.entries(committed.packs ?? {})) {
      if (pack?.packageName && pack?.version) byLanguage.set(languageId, pack);
    }
    return byLanguage;
  } catch {
    return new Map();
  }
};

const main = async () => {
  const useLatest = process.argv.includes("--latest");
  const committed = await readCommittedVersions();
  const pinned = useLatest ? new Map() : committed;
  const candidates = new Map(CANDIDATES.map(candidate => [candidate.languageId, candidate]));
  for (const [languageId, pack] of committed) {
    // Reviewed bundled additions survive a manifest refresh. Their source package
    // and exact wasm path remain authoritative, including multi-grammar archives.
    candidates.set(languageId, { languageId, packages: [pack.packageName] });
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "varin-grammar-manifest-"));
  const runtime = await loadWebTreeSitter();
  const packs = {};
  const skipped = {};
  log(useLatest ? "resolving latest published versions" : `reusing ${pinned.size} committed pack version(s)`);
  try {
    for (const candidate of candidates.values()) {
      const release = committed.get(candidate.languageId);
      if (release?.downloadFormat === "wasm") {
        const dest = path.join(workDir, release.grammarFile);
        await downloadTo(release.tarballUrl, dest);
        const bytes = await fs.readFile(dest);
        if (integrityOf(bytes) !== release.integrity) throw new Error(`Pinned release changed: ${candidate.languageId}`);
        const language = await runtime.loadGrammar(dest);
        const query = await fs.readFile(path.join(webRoot, "application-host/lib/structure/runtime", release.bundledQueryFile), "utf8");
        runtime.compileQuery(language, query);
        packs[candidate.languageId] = { ...release, bundledQueryIntegrity: integrityOf(Buffer.from(query)) };
        log(`${candidate.languageId}: verified pinned upstream release ${release.version}`);
        continue;
      }
      let recorded = false;
      const reasons = [];
      const pin = pinned.get(candidate.languageId);
      for (const packageName of candidate.packages) {
        try {
          const pinnedVersion = pin?.packageName === packageName ? pin.version : undefined;
          const result = await inspectPackage(candidate.languageId, packageName, workDir, runtime, pinnedVersion, committed.get(candidate.languageId));
          if (result.skip) {
            reasons.push(result.skip);
            continue;
          }
          if (result.pack.abi < runtime.min || result.pack.abi > runtime.max) {
            reasons.push(
              `${packageName}@${result.pack.version}: wasm ABI ${result.pack.abi} outside ${runtime.min}-${runtime.max}`,
            );
            continue;
          }
          packs[candidate.languageId] = result.pack;
          recorded = true;
          const outline = result.pack.tagsPath || result.bundledQueryValidated
            ? "outline"
            : `no outline (${result.tagsNote})`;
          log(`${candidate.languageId}: ${packageName}@${result.pack.version} abi=${result.pack.abi} ${result.pack.bytes}B ${outline}`);
          break;
        } catch (error) {
          reasons.push(`${packageName}: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (!recorded) {
        skipped[candidate.languageId] = reasons.join("; ") || "no candidate package succeeded";
        log(`skip ${candidate.languageId}: ${skipped[candidate.languageId]}`);
      }
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const manifest = {
    generatedAt: new Date().toISOString().slice(0, 10),
    minCompatibleAbi: runtime.min,
    maxCompatibleAbi: runtime.max,
    packs,
    skipped,
  };
  await fs.writeFile(destPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`wrote ${destPath} (${Object.keys(packs).length} packs, ${Object.keys(skipped).length} skipped)`);
};

await main();
