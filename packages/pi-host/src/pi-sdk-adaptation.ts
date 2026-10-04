import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PiSdkPackageName } from "./pi-sdk-packages.js";

interface Hunk {
  before: string;
  after: string;
}
const patches = new Map<PiSdkPackageName, Map<string, Hunk[]>>();

function readPatch(name: PiSdkPackageName): Map<string, Hunk[]> {
  const cached = patches.get(name);
  if (cached) return cached;
  const result = new Map<string, Hunk[]>();
  const patchDirectory = fileURLToPath(new URL("../patches/", import.meta.url));
  const patch = readFileSync(join(patchDirectory, `${name.replace("/", "%2F")}@1.0.0.patch`), "utf8");
  let path = "";
  let hunk: Hunk | undefined;
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("--- a/")) {
      path = line.slice(6);
      hunk = undefined;
    } else if (line.startsWith("+++ b/")) continue;
    else if (line.startsWith("@@ ")) {
      hunk = { before: "", after: "" };
      const file = result.get(path) ?? [];
      file.push(hunk);
      result.set(path, file);
    } else if (hunk && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) {
      if (line[0] !== "+") hunk.before += `${line.slice(1)}\n`;
      if (line[0] !== "-") hunk.after += `${line.slice(1)}\n`;
    }
  }
  patches.set(name, result);
  return result;
}

/** Apply the shipped SDK seams in memory; external Pi installations remain user-owned. */
export function adaptPiSdkSource(name: PiSdkPackageName, path: string, source: string): string {
  const hunks = readPatch(name).get(path);
  if (!hunks) return source;
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  let adapted = source.replaceAll("\r\n", "\n");
  for (const hunk of hunks) {
    if (adapted.includes(hunk.after)) continue;
    const index = adapted.indexOf(hunk.before);
    if (index >= 0) {
      if (adapted.indexOf(hunk.before, index + hunk.before.length) >= 0) {
        throw new Error(`Pi SDK seam is ambiguous: ${name}/${path}`);
      }
      adapted = adapted.slice(0, index) + hunk.after + adapted.slice(index + hunk.before.length);
    } else {
      throw new Error(`Selected Pi SDK does not support Varin's required seam: ${name}/${path}. Use the bundled Pi runtime or a compatible SDK build.`);
    }
  }
  return lineEnding === "\r\n" ? adapted.replaceAll("\n", "\r\n") : adapted;
}
