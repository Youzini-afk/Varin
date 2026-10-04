import { open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createReadToolDefinition, getDocsPath, VERSION, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adaptPiSdkAsset } from "../pi-sdk-adaptation.js";

export const PI_CODEMODE_REFERENCE = 'the SDK reference using text(await tools.pi_docs({ document: "codemode.md" })) in codemode';

/** SDK references belong to the selected runtime, independently of the workspace machine/scope. */
export function createPiDocsTool(docsDirectory = getDocsPath()): ToolDefinition {
  const resolveDocument = async (document: string): Promise<string> => {
    const root = await realpath(docsDirectory);
    const target = await realpath(path.resolve(root, document));
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("pi_docs reads references inside the selected Pi SDK docs directory only");
    }
    return target;
  };
  const native = createReadToolDefinition(docsDirectory, {
    operations: {
      access: async target => { await resolveDocument(target); },
      readFile: async target => {
        const canonical = await resolveDocument(target);
        const handle = await open(canonical, "r");
        try {
          const bytes = await handle.readFile();
          if (await resolveDocument(target) !== canonical) throw new Error("SDK reference changed while reading");
          const relative = path.relative(await realpath(docsDirectory), canonical).replaceAll("\\", "/");
          return adaptPiSdkAsset("@earendil-works/pi-coding-agent", `docs/${relative}`, bytes);
        } finally { await handle.close(); }
      },
    },
  });
  const parameters = Type.Object({
    document: Type.Optional(Type.String()),
    offset: native.parameters.properties.offset,
    limit: native.parameters.properties.limit,
  });
  const tool: ToolDefinition<typeof parameters> = {
    name: "pi_docs",
    label: "Pi SDK reference",
    description: "Read reference material shipped with the selected Pi runtime. Use document: \"codemode.md\" for classifiers, image generation and script globals. Omit document to list references. Accepts SDK-relative names or absolute SDK reference paths; workspace files use read. Supports native read offset/limit paging.",
    parameters,
    // Runtime references remain callable from scripts when an old transcript
    // restores a loadout recorded before this tool existed.
    exposure: "codemode",
    executionMode: "parallel",
    prepareExecution: () => ({ resources: [] }),
    execute: async (id, params, signal, onUpdate, ctx) => {
      signal?.throwIfAborted();
      if (params.document === undefined) {
        const entries = await readdir(docsDirectory, { recursive: true, withFileTypes: true });
        signal?.throwIfAborted();
        const documents = entries.filter(entry => entry.isFile()).map(entry => (
          path.relative(docsDirectory, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")
        )).sort();
        return { content: [{ type: "text", text: `Pi ${VERSION} SDK references:\n${documents.join("\n")}` }],
          details: { piVersion: VERSION, documents } };
      }
      const target = await resolveDocument(params.document);
      signal?.throwIfAborted();
      const result = await native.execute(id, { path: target,
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }, signal, onUpdate, ctx);
      return { ...result, details: { ...result.details, piVersion: VERSION,
        document: path.relative(await realpath(docsDirectory), target).replaceAll("\\", "/") } };
    },
  };
  return tool;
}
