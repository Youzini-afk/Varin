import assert from "node:assert/strict";
import { test } from "node:test";
import { readHistoryPage } from "../src/harness-history.js";
import type { PiSessionEntry } from "../src/session.js";

test("conversation ranges and stable continuation expose actual records as new activity is appended", () => {
  const records: PiSessionEntry[] = ["initial goal", "tool observation", "result"].map((text, index) => ({
    type: "custom_message", id: `record-${index}`, parentId: index ? `record-${index - 1}` : null,
    timestamp: new Date(0).toISOString(), customType: "note", content: text, display: true,
  }));
  const range = readHistoryPage(records, { start: 2, end: 2 });
  assert.equal(range.content[0]?.type, "text");
  assert.match(JSON.stringify(range.content), /tool observation/);
  assert.doesNotMatch(JSON.stringify(range.content), /initial goal|result/);
  assert.equal(range.details.afterEntry, "record-1");
  const continued = readHistoryPage(records, { afterEntry: String(range.details.afterEntry) });
  assert.match(JSON.stringify(continued.content), /result/);
  assert.doesNotMatch(JSON.stringify(continued.content), /tool observation/);
  assert.match(JSON.stringify(readHistoryPage(records, { tail: true, limit: 1 }).content), /result/);
});
