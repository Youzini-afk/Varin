import { languageIdForPath } from "@varin/protocol";
import { structureContainerPredicate } from "./kinds.js";
import { outlineCoversHitLines } from "./slice.js";
import type {
  StructureCapabilities,
  StructureClassifyRequest,
  StructureClassifyResult,
  StructureFileRequest,
  StructureFixedFileRequest,
  StructureImportsResult,
  StructureLiteralCallsResult,
  StructureOutlineRequest,
  StructureOutlineResult,
  StructureProvider,
  StructureSource,
  StructureStatus,
} from "./types.js";

const STATUS_PRIORITY: Record<StructureStatus, number> = {
  ready: 0,
  empty: 1,
  stale: 2,
  cancelled: 3,
  unsupported: 4,
  failed: 5,
  unavailable: 6,
};

const better = <Result extends { status: StructureStatus }>(current: Result | undefined, next: Result): Result => (
  !current || STATUS_PRIORITY[next.status] < STATUS_PRIORITY[current.status] ? next : current
);

/**
 * First `ready` wins. `empty` does not hide a later provider; that later call
 * is `warmOnly`. `unavailable` still allows a cold start. `cancelled` returns
 * immediately. Missing capability is `unsupported`, not `failed` (D-097 / D-099 / D-106).
 */
async function fanOutReadyFirst<Result extends { status: StructureStatus }>(
  providers: readonly StructureProvider[],
  languageId: string | null,
  capability: keyof StructureCapabilities,
  invoke: (provider: StructureProvider, request: StructureOutlineRequest) => Promise<Result>,
  request: StructureOutlineRequest,
  none: Result,
): Promise<Result> {
  const nextRequest = { ...request, languageId: languageId ?? request.languageId };
  let fallback: Result | undefined;
  let priorAnswered = false;
  for (const provider of providers) {
    if (!provider.capabilities(languageId)[capability]) continue;
    const result = await invoke(provider, { ...nextRequest, warmOnly: request.warmOnly === true || priorAnswered });
    if (result.status === "cancelled") return result;
    if (result.status === "ready") return result;
    if (result.status === "empty") priorAnswered = true;
    fallback = better(fallback, result);
  }
  return fallback ?? none;
}

/**
 * Fan-out across structure providers.
 *
 * The first `ready` outline that covers every supplied hit line wins. `empty`
 * and a `ready` outline that misses a hit do not hide a later provider, but
 * that later call is `warmOnly` so a cold language server is not started
 * (D-097 / D-099). `unavailable` from an earlier provider still allows a
 * cold start on the next one. `literalCalls` / `imports` use the same
 * cancelled / empty / warmOnly / unavailable rules without hit-line coverage
 * (D-106).
 */
export function createStructureSource(providers: readonly StructureProvider[]): StructureSource {
  const native = providers.find((provider) => provider.analyze && provider.units);
  return {
    ...(native?.analyze ? { analyze: (request: StructureClassifyRequest) => native.analyze!(request) } : {}),
    ...(native?.analyzeFile ? { analyzeFile: (request: StructureFileRequest) => native.analyzeFile!(request) } : {}),
    ...(native?.units ? { units: (request: StructureOutlineRequest) => native.units!(request) } : {}),
    ...(native?.unitsFile ? { unitsFile: (request: StructureFileRequest) => native.unitsFile!(request) } : {}),
    ...(native?.unitsFixed ? { unitsFixed: (request: StructureFixedFileRequest) => native.unitsFixed!(request) } : {}),
    async outline(request: StructureOutlineRequest): Promise<StructureOutlineResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      const nextRequest = { ...request, languageId };
      const hitLines = (request.hitLines ?? []).filter((line) => Number.isSafeInteger(line) && line >= 1);
      let fallback: StructureOutlineResult | undefined;
      let firstReady: StructureOutlineResult | undefined;
      let priorAnswered = false;
      for (const provider of providers) {
        if (!provider.capabilities(languageId).outline) continue;
        const result = await provider.outline({ ...nextRequest, warmOnly: request.warmOnly === true || priorAnswered });
        if (result.status === "cancelled") return result;
        if (result.status === "ready") {
          const covered = hitLines.length === 0 || outlineCoversHitLines(
            result.symbols,
            hitLines,
            structureContainerPredicate(languageId),
          );
          if (covered) return result;
          firstReady = result;
          priorAnswered = true;
          fallback = better(fallback, result);
          continue;
        }
        if (result.status === "empty") {
          priorAnswered = true;
          fallback = better(fallback, result);
          continue;
        }
        fallback = better(fallback, result);
      }
      return firstReady ?? fallback ?? {
        status: languageId ? "unavailable" : "unsupported",
        provider: null,
        revision: request.revision,
        symbols: [],
        message: languageId ? "No structure provider produced an outline." : "No language identity for this path.",
      };
    },
    async classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      const nextRequest = { ...request, languageId };
      let fallback: StructureClassifyResult | undefined;
      let priorAnswered = false;
      for (const provider of providers) {
        if (!provider.capabilities(languageId).classifyHits) continue;
        const result = await provider.classifyHits({ ...nextRequest, warmOnly: request.warmOnly === true || priorAnswered });
        if (result.status === "ready") return result;
        if (result.status === "cancelled") return result;
        if (result.status === "empty") priorAnswered = true;
        fallback = better(fallback, result);
      }
      return fallback ?? {
        status: "unsupported",
        provider: null,
        revision: request.revision,
        hits: [],
        message: "Hit classification is not available from the configured structure providers.",
      };
    },
    async literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      return fanOutReadyFirst(
        providers,
        languageId,
        "literalCalls",
        (provider, next) => provider.literalCalls(next),
        { ...request, languageId },
        {
          status: "unsupported",
          provider: null,
          revision: request.revision,
          calls: [],
          message: "Literal-call extraction is not available from the configured structure providers.",
        },
      );
    },
    async imports(request: StructureOutlineRequest): Promise<StructureImportsResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      return fanOutReadyFirst(
        providers,
        languageId,
        "imports",
        (provider, next) => provider.imports(next),
        { ...request, languageId },
        {
          status: "unsupported",
          provider: null,
          revision: request.revision,
          imports: [],
          message: "Import extraction is not available from the configured structure providers.",
        },
      );
    },
  };
}
