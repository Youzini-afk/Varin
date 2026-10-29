// varin-main-20261028/packages/ui/src/components/companion/sceneCues.ts
function sceneCue(value) {
  if (!value) return "transition";
  const v = value.toUpperCase();
  if (v === "PAGE_TURN") return "page-turn";
  if (v === "READ_SETTLE") return "read";
  if (v.startsWith("REVISE") && !v.includes("PREPARE")) return "revise";
  if (["TYPE_BURST", "TYPE_ALTERNATE"].includes(v)) return "type";
  if (v === "REVIEW") return "review";
  if (v === "FAN_OUT" || v === "PAGE_PRESENT") return "present";
  if (v.startsWith("SCAN_SIDE_A")) return "scan-left";
  if (v.startsWith("SCAN_SIDE_B") || v === "GAZE_A") return "scan-right";
  if (v === "SELECT") return "select";
  if (v === "SPLIT") return "split";
  if (v === "DISPATCH_A") return "dispatch-right";
  if (v === "DISPATCH_B") return "dispatch-left";
  if (v.includes("GAZE_B")) return "scan-left";
  if (v.startsWith("WATCH")) return "watch";
  if (v === "ASK") return "ask";
  if (v === "OFFER") return "offer";
  if (["ATTEND", "UNRESOLVED"].includes(v)) return "attend";
  if (["ANSWER_RECEIVED", "ALLOW_RECEIVED"].includes(v)) return "acknowledge";
  return "transition";
}
function cueMatchesScene(kind, drawnAction) {
  if (!kind) return false;
  const action = { reading: "reading", editing: "editing", searching: "browsing", dispatch: "dispatch", question: "query", permission: "permission" };
  return drawnAction === action[kind];
}
export {
  cueMatchesScene,
  sceneCue
};
