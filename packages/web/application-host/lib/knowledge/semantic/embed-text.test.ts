import { describe, expect, it } from "vitest";
import { buildEmbedText } from "./embed-text.js";

describe("buildEmbedText", () => {
  it("keeps the body when a long path and signature would overflow", async () => {
    const body = "return reclaimLease(handle);";
    const text = await buildEmbedText({
      documentId: "packages/web/application-host/lib/harness/very-long-path-that-would-eat-the-window.ts",
      parentName: "reclaimLease",
      parentSignature: "export function reclaimLease(handle: Handle): void {".repeat(8),
      docComments: "/** forget unused resources after the owner goes away */",
      body,
    }, body.length + 4, (value) => value.length);
    expect(text).toContain(body);
    expect(text.startsWith(body) || text.endsWith(body)).toBe(true);
    expect(text).not.toContain("very-long-path-that-would-eat-the-window");
  });

  it("adds decoration only while the tokenizer still accepts it", async () => {
    const text = await buildEmbedText({
      documentId: "src/a.ts",
      parentName: "run",
      parentSignature: "function run()",
      docComments: "",
      body: "return 1;",
    }, 20, (value) => value.split(/\s+/u).filter(Boolean).length);
    expect(text).toContain("return 1;");
    expect(text).toContain("function run()");
    expect(text).toContain("src/a.ts");
  });
});
