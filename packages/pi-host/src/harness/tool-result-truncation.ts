import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { sliceUtf8ByBytes, type OutputRef } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

const DEFAULT_VISIBLE_BYTES = 32768;
const DEFAULT_HEAD_RATIO = 0.5;
const MAX_NEWLINE_BACKTRACK = 512;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function hasHostOrganizedDisplay(value: unknown): boolean {
  const details = asRecord(value);
  const organized = asRecord(details?.organized);
  return typeof details?.display === "string" && typeof organized?.kind === "string";
}

function findNearestNewlineBefore(text: string, position: number): number {
  for (let i = position; i > Math.max(0, position - MAX_NEWLINE_BACKTRACK); i--) {
    if (text[i] === "\n") return i;
  }
  return position;
}

export interface ToolResultTruncationOptions {
  bridge: HostServicesBridge;
  visibleBytes?: number;
  sessionId: string;
}

export function createToolResultTruncationExtension(options: ToolResultTruncationOptions): ExtensionFactory {
  const visibleBytes = options.visibleBytes ?? DEFAULT_VISIBLE_BYTES;
  const bridge = options.bridge;
  const _sessionId = options.sessionId;

  return (pi) => {
    pi.on("tool_result", async (event) => {
      const content = event.content;
      if (!content) return undefined;

      const toolName = event.toolName;
      const input = asRecord(event.input);
      const explicitOutputRead = toolName === "get_output" && (
        input?.offset !== undefined
        || input?.length !== undefined
        || (typeof input?.handle === "string" && input.handle.startsWith("out_"))
      );
      const organizedShellResult = (toolName === "bash" || toolName === "get_output")
        && hasHostOrganizedDisplay(event.details);
      // The file tool owns its native range/continuation contract. Never turn
      // an explicitly read page, a failure, or an ordered attachment comparison
      // into a generic preview backed only by an ephemeral text handle.
      if (toolName === "read" || event.isError || content.some((part) => part.type !== "text")
        || explicitOutputRead || organizedShellResult) return undefined;
      const headRatio = DEFAULT_HEAD_RATIO;

      // Concatenate all TextContent
      const textParts: string[] = [];
      for (const part of content) {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      const fullText = textParts.join("");
      const byteLength = Buffer.byteLength(fullText, "utf8");

      if (byteLength <= visibleBytes) return undefined;

      // Split into head and tail
      const headBytes = Math.floor(visibleBytes * headRatio);
      const tailBytes = visibleBytes - headBytes;

      const headCandidate = sliceUtf8ByBytes(fullText, 0, headBytes).text;
      const tailCandidate = sliceUtf8ByBytes(fullText, Math.max(0, byteLength - tailBytes), byteLength).text;
      const headCut = findNearestNewlineBefore(headCandidate, headCandidate.length);
      const tailCut = tailCandidate.indexOf("\n");
      const head = headCandidate.slice(0, headCut);
      const tail = tailCut === -1 ? tailCandidate : tailCandidate.slice(tailCut + 1);
      const shownHeadBytes = Buffer.byteLength(head, "utf8");
      const shownTailBytes = Buffer.byteLength(tail, "utf8");

      // Store full text via output.store
      let ref: OutputRef;
      let total: number;
      try {
        const stored = await bridge.request("output.store", { text: fullText, label: toolName });
        ref = stored.ref;
        total = stored.total;
      } catch {
        // If output.store fails, leave the result untruncated
        return undefined;
      }

      const truncatedText = `${head}\n…\n${tail}\n[output: ${total} bytes; showing first ${shownHeadBytes} and last ${shownTailBytes} — get_output({handle:"${ref.handle}",offset:${shownHeadBytes},length:${visibleBytes}}) for more (ephemeral, generation ${ref.generation})]`;

      // Only replace the text projection. Images are first-class input, not
      // text-store contents: dropping them here silently destroys comparison
      // and vision tasks. Preserve their bytes and relative order.
      let replacedText = false;
      const newContent = content.flatMap<(typeof content)[number]>((part) => {
        if (part.type !== "text") return [part];
        if (replacedText) return [];
        replacedText = true;
        return [{ type: "text" as const, text: truncatedText }];
      });
      const newDetails = {
        ...(event.details ?? {}),
        truncated: { ref, total, head: shownHeadBytes, tail: shownTailBytes },
      };

      return {
        content: newContent,
        details: newDetails,
      };
    });
  };
}
