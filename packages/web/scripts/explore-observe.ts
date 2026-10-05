/**
 * Observation run for `explore.search`. Not a benchmark and not a test.
 *
 * plan 0.7 says the next retrieval decision (lexical index / bridging /
 * embedding) follows from *observed* "cannot find the entry point" failures,
 * but nothing produced that observation: every claim so far came from unit
 * tests and comparison numbers. This script asks real questions about this
 * repository and prints what the agent would actually receive, verbatim, for a
 * human to read.
 *
 * Run with:
 *
 *   bun run --cwd packages/web explore:observe
 *   bun run --cwd packages/web explore:observe -- --only 3 --full
 *
 * Do not redirect stdout into this repository. rg would then read the file
 * being written and can fail with exit 2 (D-142). Keep expected answers in
 * this script and compare after the run.
 *
 * Shape discipline (D-140): this goes through the real
 * `createHarnessServiceHost` / `createExploreSearchService` / rg / structure
 * source / knowledge store. It does not reimplement retrieval, because the
 * three previous measurement mistakes all came from a script measuring a shape
 * the product does not run.
 *
 * What is simulated, and why that is faithful: there is no editor here, so no
 * dirty buffers exist and `agentInputDraftPaths` is empty. That is exactly the
 * production path when nothing is unsaved (D-082: no dirty capture → disk), so
 * the fixed-draft branches are simply not exercised.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocumentAuthority } from "../application-host/lib/documents/authority.js";
import { createHarnessPathAuthority } from "../application-host/lib/harness/path-authority.js";
import { createExploreFileReader } from "../application-host/lib/harness/explore-file-reader.js";
import { createHarnessServiceHost } from "../application-host/lib/harness/service-host.js";
import { createExploreSearchService } from "../application-host/lib/harness/explore-service.js";
import { createWorkspaceContentSearch } from "../application-host/lib/search/content.js";
import { createStructureSource } from "../application-host/lib/structure/source.js";
import { createTreeSitterStructureProvider } from "../application-host/lib/structure/tree-sitter-provider.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../application-host/lib/knowledge/store.js";
import { createSymbolGraphRuntime } from "../application-host/lib/knowledge/symbol-runtime.js";
import { createFsSearchRuntime } from "../application-host/lib/fs/search.js";
import { createLocalSemanticEmbedder } from "../application-host/lib/knowledge/semantic/local-embedder.js";
import { workspaceScope } from "../application-host/lib/knowledge/semantic/identity.js";
import { createSemanticIndexRuntime } from "../application-host/lib/knowledge/semantic/runtime.js";
import {
  formatSemanticLine,
  stageForTarget,
  type ObserveStageNeed,
  type ObserveStagePayload,
} from "./explore-observe-stage.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * What the visible body must actually contain for the target to count. Mandatory:
 * without it the script can only observe "some window of this file is visible",
 * and must not report that as verified evidence (D-151).
 */
type TargetNeed = ObserveStageNeed;

type ObserveQuestion = {
  ask: string;
  wants: string;
  anchors?: string[];
  targets: Array<{
    id: string;
    pathIncludes: string;
    need: TargetNeed;
  }>;
};

const NEED_REGISTER: TargetNeed = {
  label: "register(\"explore.search\")",
  match: /register\s*\(\s*["'`]explore\.search|verified register\("explore\.search"\)/,
};
const NEED_REQUEST: TargetNeed = {
  label: "request(\"explore.search\")",
  match: /request\s*\(\s*["'`]explore\.search|verified request\("explore\.search"\)/,
};

/**
 * Real questions. `wants` is the minimum evidence a maintainer would accept;
 * written before this run, not widened after seeing output (D-149).
 */
const QUESTIONS: ObserveQuestion[] = [
  {
    ask: "where is the explore.search service registered on the host router",
    wants: "visible snippet shows the current register(...) call with the full explore.search connection value. A doc or fixture that only mentions the name does not count.",
    targets: [{ id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER }],
  },
  {
    ask: "how does explore decide which files to read after ripgrep returns hits",
    wants: "visible snippet from explore.ts that implements ranking or on-demand materialize (schedule/rank/materialize). A design paragraph that only names those functions does not count.",
    targets: [{
      id: "materialize",
      pathIncludes: "explore.ts",
      need: {
        label: "rank/schedule/materialize body",
        match: /(?:const|function)\s+(?:rankCandidates|scheduleReads|materializeScheduled|materializeBatch)\b|(?:rankCandidates|scheduleReads|materializeScheduled)\s*\(/,
      },
    }],
  },
  {
    ask: "what stops the agent from reading a stale captured draft after it writes a file",
    wants: "visible snippet of the invalidate/supersede or observeWrite path that drops a captured draft after an agent write. Naming D-088 is not enough.",
    targets: [
      {
        id: "supersede",
        pathIncludes: "surface-snapshot-store",
        need: { label: "supersede/observeWrite body", match: /supersede|observeWrite/ },
      },
      {
        id: "observe-write",
        pathIncludes: "authority",
        need: { label: "observeWrite call", match: /observeWrite\s*\(/ },
      },
    ],
  },
  {
    ask: "where do we decide a tree-sitter grammar can produce an outline",
    wants: "visible snippet that decides outline capability from a grammar spec or tagsPath. A string constant listing language ids does not count.",
    targets: [{
      id: "outline-capability",
      pathIncludes: "languages.ts",
      need: { label: "capability decision from spec/tagsPath", match: /capabilitiesFromSpec|tagsPath/ },
    }],
  },
  {
    ask: "which code writes connects and associates edges into the knowledge graph",
    wants: "visible classify or write-path operation that assigns connects vs associates. A definition of the string constants alone does not count.",
    targets: [
      {
        id: "classify",
        pathIncludes: "connections.ts",
        need: { label: "connects/associates classification", match: /classifyLiteralCall/ },
      },
      {
        id: "write",
        pathIncludes: "symbol-runtime.ts",
        need: { label: "link write with the classified kind", match: /links\.push|kind:\s*classified/ },
      },
    ],
  },
  {
    ask: "how is the parse budget for tree-sitter enforced and what happens when it runs out",
    wants: "visible snippet of the parse progress/budget check and the exhausted outcome. Naming STRUCTURE_PARSE_BUDGET_MS is not enough.",
    targets: [{
      id: "parse-budget",
      pathIncludes: "tree-sitter-provider.ts",
      need: { label: "progress check and exhausted outcome", match: /progressCallback|stopReason|Parse budget exhausted/ },
    }],
  },
  {
    ask: "where is the write guard that refuses to overwrite unsaved user changes",
    wants: "visible inspect/write-guard decision that refuses a write over unsaved user changes, or the document.writeGuard registration of that function.",
    targets: [
      {
        id: "inspect",
        pathIncludes: "authority",
        need: { label: "unsaved-changes refusal", match: /unsaved editor changes|writeGuard/ },
      },
      {
        id: "register-guard",
        pathIncludes: "harness-services.ts",
        need: { label: "register(\"document.writeGuard\")", match: /register\s*\(\s*["'`]document\.writeGuard/ },
      },
    ],
  },
  {
    ask: "how does a thread get its own working directory and when is it reclaimed",
    wants: "visible materialize and reclaim (or reclaim-guard) operations. A comment that only mentions worktrees does not count.",
    targets: [{
      id: "worktree",
      pathIncludes: "thread-worktree.ts",
      need: { label: "reclaim body", match: /reclaim(?:ed)?\s*[=:(]/ },
    }],
  },
  {
    ask: "explore.search",
    wants: "both the register end and the request end of that connection are visible. One end must be reported as missing the other.",
    targets: [
      { id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER },
      { id: "request-end", pathIncludes: "explore-tool.ts", need: NEED_REQUEST },
    ],
  },
  {
    ask: "what limits how many bytes explore returns to the model",
    wants: "visible packExploreVisible / DEFAULT_BYTE_BUDGET (or the OutputStore handle reservation). A docs sentence that only names the budget does not count.",
    targets: [{
      id: "byte-budget",
      pathIncludes: "explore.ts",
      need: { label: "packExploreVisible / DEFAULT_BYTE_BUDGET", match: /packExploreVisible|DEFAULT_BYTE_BUDGET/ },
    }],
  },
];

/** Same entry, five surface forms. Full object + direct clue must survive all of them. */
const VARIANTS: ObserveQuestion[] = [
  {
    ask: "explore.search",
    wants: "same minimum as question 9: register end and request end visible.",
    targets: [
      { id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER },
      { id: "request-end", pathIncludes: "explore-tool.ts", need: NEED_REQUEST },
    ],
  },
  {
    ask: "`explore.search`",
    wants: "backticks must not drop the object; register or request call still visible.",
    targets: [
      { id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER },
      { id: "request-end", pathIncludes: "explore-tool.ts", need: NEED_REQUEST },
    ],
  },
  {
    ask: "where is explore.search registered on the host router",
    wants: "polite English locating form still shows the current register(...) call.",
    targets: [{ id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER }],
  },
  {
    ask: "请找一下 explore.search 的注册位置",
    wants: "Chinese locating form still shows the current register(...) call.",
    targets: [{ id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER }],
  },
  {
    ask: "where is this registered",
    wants: "explicit anchors must drive the same object; current register(...) call visible.",
    anchors: ["explore.search"],
    targets: [{ id: "register-end", pathIncludes: "harness-services.ts", need: NEED_REGISTER }],
  },
];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const only = flag("only") ? Number(flag("only")) : null;
const full = args.includes("--full");
const skipScan = args.includes("--skip-scan");
/**
 * Reuse a catalog across runs. Building it takes minutes, and the point of this
 * script is to ask many questions, so pass the same directory to keep it:
 *
 *   bun run --cwd packages/web explore:observe -- --data-dir .observe
 *   bun run --cwd packages/web explore:observe -- --data-dir .observe --skip-scan --only 3
 */
const dataDirArg = flag("data-dir");

const line = (char = "─"): string => char.repeat(78);

/** Lines of the workspace file that satisfy the requirement. */
const needLinesIn = (relativePath: string, need: TargetNeed): number[] => {
  try {
    const lines = readFileSync(path.join(repoRoot, relativePath), "utf8").split(/\r\n|\n|\r/);
    return lines.flatMap((line, index) => need.match.test(line) ? [index + 1] : []);
  } catch {
    return [];
  }
};

type ObservePayload = ObserveStagePayload;

const printDiagnostic = (question: ObserveQuestion, payload: ObservePayload): void => {
  const query = payload.details?.query;
  const graph = payload.details?.graph;
  process.stdout.write(
    `query:   object=${(query?.objects ?? []).join(",") || "—"}  relation=${query?.relation ?? "—"}  domain=${query?.domain ?? "—"}\n`,
  );
  process.stdout.write(
    `direct:  connects=${graph?.connections ?? 0} paths  associates=${graph?.associates ?? 0} paths  definitions=${graph?.definitions ?? 0} files  graph=${graph?.status ?? "—"}\n`,
  );
  process.stdout.write(`${formatSemanticLine(payload.details?.semantic)}\n`);
  // This file holds the question text, so it is a trivially strong lexical
  // candidate for every question. Measure that instead of hiding it (D-152).
  const selfPacked = (payload.snippets ?? []).filter((snippet) => snippet.path.includes("explore-observe.ts")).length;
  const selfUnread = (payload.notRequested?.paths ?? []).filter((path) => path.includes("explore-observe.ts")).length;
  if (selfPacked > 0 || selfUnread > 0) {
    process.stdout.write(`self:    question text in this script took ${selfPacked} visible slot(s), ${selfUnread} unread candidate(s)\n`);
  }
  for (const target of question.targets) {
    process.stdout.write(`target:  ${stageForTarget(target, payload, { needLinesIn })}\n`);
  }
  if (payload.details?.skippedQueries) {
    process.stdout.write(
      `skipped: ${payload.details.skippedQueries.reason} ${JSON.stringify(payload.details.skippedQueries.patterns)}\n`,
    );
  }
  const distinct = payload.details?.distinctiveness;
  if (distinct?.terms?.length) {
    process.stdout.write(
      `weights:  scope=${distinct.scope ?? "—"} pool=${distinct.poolFiles ?? "—"} `
      + distinct.terms
        .map((term) => `${term.term}:${term.weight.toFixed(3)}/${term.coverage}/df=${term.uniqueFiles}`)
        .join(" ")
      + "\n",
    );
  }
};

const main = async (): Promise<void> => {
  const dataDir = dataDirArg
    ? path.resolve(repoRoot, dataDirArg)
    : await fsPromises.mkdtemp(path.join(os.tmpdir(), "varin-explore-observe-"));
  if (dataDirArg) await fsPromises.mkdir(dataDir, { recursive: true });
  let store: KnowledgeStore | null = null;

  const documents = createDocumentAuthority({
    hostId: "explore-observe",
    dataDir,
    maxReadBytes: 2 * 1024 * 1024,
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const identity = await documents.resolveWorkspace({ path: repoRoot });
  const workspaceId = identity.workspaceId;
  process.stderr.write(`workspace ${workspaceId} → ${repoRoot}\n`);

  const paths = createHarnessPathAuthority({
    authorityId: "explore-observe",
    documents,
    fsPromises,
    pathModule: path,
  });
  const contentSearch = createWorkspaceContentSearch({
    documents,
    spawn,
    pathModule: path,
    env: process.env,
  });
  const structureSource = createStructureSource([createTreeSitterStructureProvider()]);
  const fileSearch = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn: () => "git",
  });

  // The catalog the graph readers depend on. Built through the production
  // collector, not a parallel one.
  store = await openWorkspaceKnowledge({
    dataDir,
    hostId: "explore-observe",
    workspaceId,
    embedding: null,
  });
  const openStore = store;
  if (!skipScan) {
    const scanStarted = performance.now();
    const symbolGraph = createSymbolGraphRuntime({
      getStore: async () => openStore,
      documents,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "observation run does not start a language server" }),
      } as never,
      structureSource,
      searchFilesystemFiles: fileSearch.searchFilesystemFiles,
      onError: (error) => process.stderr.write(`catalog: ${String(error)}\n`),
    });
    process.stderr.write("building catalog (this is the D-140 path; expect minutes)…\n");
    await symbolGraph.scanWorkspace(workspaceId);
    const stats = await openStore.catalogStats();
    process.stderr.write(
      `catalog ready in ${Math.round(performance.now() - scanStarted)} ms: `
      + `${stats.fileCount} files / ${stats.symbolCount} symbols / ${stats.linkCount} links\n`,
    );
    await symbolGraph.dispose();
  }

  const semanticRuntime = createSemanticIndexRuntime({
    dataDir,
    hostId: "explore-observe",
    documents,
    structureSource,
    searchFilesystemFiles: fileSearch.searchFilesystemFiles,
    embedder: createLocalSemanticEmbedder({ dataDir }),
    onError: (error) => process.stderr.write(`semantic: ${String(error)}\n`),
  });
  // The semantic index is a separate generation store from the catalog, so it
  // needs its own scan. Without one the questions run against an `empty` index
  // and the semantic source is measured as absent rather than as unhelpful
  // (D-173). Reuse across runs with the same `--data-dir`.
  if (!skipScan) {
    const semanticStarted = performance.now();
    process.stderr.write("building semantic index (local MiniLM; expect minutes)…\n");
    await semanticRuntime.scanScope(workspaceScope(workspaceId));
    const status = semanticRuntime.statusFor(workspaceScope(workspaceId));
    process.stderr.write(
      `semantic cold scan wall-clock=${Math.round(performance.now() - semanticStarted)} ms: `
      + `status=${status.status} coverage=${status.coverage} lifecycle=${status.lifecycle} `
      + `generation=${status.generation ?? "—"} spaceId=${status.spaceId ?? "—"}\n`,
    );
  }

  const host = createHarnessServiceHost({
    resolveWorkspaceRoot: async () => repoRoot,
    discoveredShells: {},
    readExploreFile: createExploreFileReader(documents, paths),
    // No editor in this process, so nothing is unsaved (D-082).
    agentInputDraftPaths: () => [],
    search: async (request, options) => {
      const started = performance.now();
      // This script stores the ten questions, so it is a trivially strong
      // lexical candidate. Excluding it changes slot occupancy vs the
      // 6f92b49c baseline (Q4 and Q6 each lose one polluted visible slot)
      // but not the wants or target files (D-153).
      const observeScriptId = path.relative(repoRoot, fileURLToPath(import.meta.url)).split(path.sep).join("/");
      const isObserveScript = (resourceId: string): boolean => (
        resourceId.replace(/\\/g, "/").toLowerCase().endsWith("explore-observe.ts")
      );
      const outcome = await contentSearch.searchContent({
        query: request.query,
        workspaceId: request.workspaceId,
        maxResults: request.maxResults,
        ...(request.paths === undefined ? {} : { paths: request.paths }),
        ...(request.glob === undefined ? {} : { glob: request.glob }),
        excludeResourceIds: [
          observeScriptId,
          ...(request.excludeResourceIds ?? []),
        ],
        ...(request.ignoreCase === undefined ? {} : { ignoreCase: request.ignoreCase }),
        ...(request.fixedStrings === undefined ? {} : { fixedStrings: request.fixedStrings }),
      }, options);
      const filtered = outcome.status === "ready"
        ? outcome.hits.filter((hit) => !isObserveScript(hit.resource.resourceId))
        : [];
      const droppedSelf = outcome.status === "ready" ? outcome.hits.length - filtered.length : 0;
      const resolved = outcome.status === "ready" && droppedSelf > 0 ? { ...outcome, hits: filtered } : outcome;
      // The harness search service reports any failure as a bare "unavailable",
      // so the pattern, elapsed time and raw status are logged here.
      const hits = resolved.status === "ready" ? resolved.hits.length : 0;
      process.stderr.write(
        `  rg ${JSON.stringify(request.query)} max=${request.maxResults ?? "none"} `
        + `→ ${resolved.status} hits=${hits} ${Math.round(performance.now() - started)} ms`
        + `${droppedSelf > 0 ? ` self-filter=-${droppedSelf}` : ""}`
        + `${resolved.status === "failure" ? ` :: ${resolved.message}` : ""}\n`,
      );
      return resolved;
    },
    structureSource,
    graphRecall: () => openStore,
    semanticRecall: async (workspaceId, question, limit) => {
      const result = await semanticRuntime.search(workspaceScope(workspaceId), question, limit);
      return {
        status: result.status.status,
        coverage: result.status.coverage,
        ...(result.status.generation ? { generation: result.status.generation } : {}),
        ...(result.status.spaceId ? { spaceId: result.status.spaceId } : {}),
        scope: result.status.scope,
        lifecycle: result.status.lifecycle,
        hits: result.hits,
      };
    },
    // Same shape as index.ts. The first version of this callback omitted
    // `associations` and crashed `relationLines` — on exactly the two
    // questions whose excerpts were source files with graph edges.
    fileRelations: async (_workspaceId, resourceId) => {
      const relations = await openStore.getFileRelations(resourceId);
      if (!relations) return null;
      if (relations.imports.length === 0 && relations.connections.length === 0 && relations.associations.length === 0) {
        return null;
      }
      return {
        path: relations.path,
        documentRevision: relations.documentRevision,
        incomplete: relations.linksIncomplete,
        imports: relations.imports.map(({ specifier, line }) => ({ specifier, line })),
        connections: relations.connections.map(({ callee, literal, line }) => ({ callee, literal, line })),
        associations: relations.associations.map(({ callee, literal, line }) => ({ callee, literal, line })),
      };
    },
  });

  // Sanity check before asking anything: explore reports a search failure as a
  // generic "unavailable", so the raw status is printed here instead.
  const probe = await contentSearch.searchContent({ query: "createExploreSearchService", workspaceId, maxResults: 3 });
  process.stderr.write(`search probe: ${JSON.stringify({ status: probe.status, message: (probe as { message?: string }).message })}\n`);
  try {
    const inspected = await documents.inspectWorkspace(workspaceId);
    process.stderr.write(`inspectWorkspace ok: ${inspected.root}\n`);
  } catch (error) {
    process.stderr.write(`inspectWorkspace THREW: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const explore = createExploreSearchService(host, { traceWindows: true });
  const ctx = {
    actor: { hostId: "explore-observe", sessionId: "observe", workspaceId },
    sessionId: "observe",
    signal: new AbortController().signal,
  } as never;

  const runQuestion = async (
    question: ObserveQuestion,
    label: string,
  ): Promise<void> => {
    process.stdout.write(`\n${line("═")}\n[${label}] ${question.ask}\n`);
    if (question.anchors) process.stdout.write(`anchors: ${question.anchors.join(", ")}\n`);
    process.stdout.write(`looking for: ${question.wants}\n${line()}\n`);

    const started = performance.now();
    let result: Awaited<ReturnType<typeof explore.handle>> | null = null;
    try {
      result = await explore.handle(
        { question: question.ask, ...(question.anchors ? { anchors: question.anchors } : {}) } as never,
        ctx,
      );
    } catch (error) {
      process.stdout.write(`THREW: ${error instanceof Error ? error.message : String(error)}\n`);
      // A throw here is a product defect, not a retrieval outcome; the frame is
      // the only thing that locates it.
      if (error instanceof Error && error.stack) {
        const frames = error.stack.split("\n").slice(1, 5).map((frame) => frame.trim());
        process.stdout.write(`  ${frames.join("\n  ")}\n`);
      }
      return;
    }
    const elapsed = Math.round(performance.now() - started);

    const payload = result as unknown as ObservePayload & {
      text?: string;
      snippets?: Array<{ path: string; startLine: number; endLine: number; why: string; text?: string; unit?: { name: string; kind: string } }>;
      searched?: unknown;
      issues?: unknown[];
      notRequested?: { count: number; paths: string[] };
      details?: ObservePayload["details"] & {
        structure?: unknown;
        relations?: unknown;
      };
    };

    process.stdout.write(`took ${elapsed} ms\n\n`);
    printDiagnostic(question, payload);
    process.stdout.write("\n");
    if (full) {
      process.stdout.write(`${payload.text ?? "(no text)"}\n`);
    } else {
      for (const snippet of payload.snippets ?? []) {
        const unit = snippet.unit ? ` ${snippet.unit.kind} ${snippet.unit.name}` : "";
        process.stdout.write(`  ${snippet.path}:${snippet.startLine}-${snippet.endLine}${unit}\n      why: ${snippet.why}\n`);
      }
      if ((payload.snippets ?? []).length === 0) process.stdout.write("  (no snippets)\n");
    }
    process.stdout.write(`\nsearched: ${JSON.stringify(payload.searched)}\n`);
    if (payload.details?.query) process.stdout.write(`query:    ${JSON.stringify(payload.details.query)}\n`);
    if (payload.details?.distinctiveness) process.stdout.write(`weights:  ${JSON.stringify(payload.details.distinctiveness)}\n`);
    if (payload.details?.graph) process.stdout.write(`graph:    ${JSON.stringify(payload.details.graph)}\n`);
    if (payload.details?.semantic) process.stdout.write(`semantic: ${JSON.stringify(payload.details.semantic)}\n`);
    if (payload.details?.skippedQueries) process.stdout.write(`skipped:  ${JSON.stringify(payload.details.skippedQueries)}\n`);
    if (payload.details?.structure) process.stdout.write(`structure:${JSON.stringify(payload.details.structure)}\n`);
    if (payload.details?.relations) process.stdout.write(`relations:${JSON.stringify(payload.details.relations)}\n`);
    if ((payload.issues ?? []).length > 0) process.stdout.write(`issues:   ${JSON.stringify(payload.issues)}\n`);
  };

  const selected = only === null ? QUESTIONS : QUESTIONS.slice(only - 1, only);
  for (const [index, question] of selected.entries()) {
    const number = only === null ? index + 1 : only;
    await runQuestion(question, String(number));
  }
  if (only === null) {
    process.stdout.write(`\n${line("═")}\nvariants of the explore.search entry\n`);
    for (const [index, question] of VARIANTS.entries()) {
      await runQuestion(question, `V${index + 1}`);
    }
  }

  await host.dispose();
  await semanticRuntime.dispose();
  await store?.close();
  process.stdout.write(`\n${line("═")}\ndata dir kept for inspection: ${dataDir}\n`);
};

await main();
