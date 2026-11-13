import Foundation
import ApplicationServices

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

expect(semanticRole("AXCheckBox") == "checkbox", "checkbox role")
expect(semanticMatches(["name": "Save", "checked": false], ["name": "Save", "checked": false]), "exact name and false state match")
expect(!semanticMatches(["name": "Save"], ["checked": false]), "unknown state is not false")
expect(!semanticMatches(["name": "Save as"], ["name": "Save"]), "names default to exact")
expect(semanticMatches(["name": "Save as"], ["name": "Save", "nameMatch": "contains"]), "explicit substring")
expect(!semanticMatches(["checked": "mixed"], ["checked": true]), "mixed is distinct")
expect(semanticMatchUnavailable(["role": "checkbox"], ["role": "checkbox", "checked": false]), "unknown matched property cannot prove absence")
expect(!semanticMatchUnavailable(["role": "button"], ["role": "checkbox", "checked": false]), "a known role mismatch is conclusive")

let placeholder = AXUIElementCreateSystemWide()
var attributeReads: [String] = []
let protectedProperties = try axProperties(placeholder, requested: ["name", "value"], protectedContent: true, readAttribute: { attribute in
    attributeReads.append(attribute)
    return "secret" as CFString
})
expect(protectedProperties.isEmpty && attributeReads.isEmpty, "protected contents are never fetched")
let enabled = try axProperties(placeholder, requested: ["enabled"], protectedContent: false, readAttribute: { attribute in
    attributeReads.append(attribute)
    return kCFBooleanFalse
})
expect(enabled["enabled"] as? Bool == false && attributeReads == [kAXEnabledAttribute], "property reads request only the selected attribute")
let mixed = try axProperties(placeholder, requested: ["checked"], protectedContent: false, readAttribute: { attribute in
    if attribute == kAXRoleAttribute { return "AXCheckBox" as CFString }
    return NSNumber(value: 2)
})
expect(mixed["checked"] as? String == "mixed", "AX mixed state is preserved")

var writes = 0
var toggles = 0
try setDesiredState(current: true, desired: true, write: { writes += 1 }, toggle: { toggles += 1 })
expect(writes == 0 && toggles == 0, "satisfied state sends no input")
try setDesiredState(current: false, desired: true, write: { writes += 1 }, toggle: { toggles += 1 })
expect(writes == 1 && toggles == 0, "settable state uses one setter")
try setDesiredState(current: false, desired: true, write: nil, toggle: { toggles += 1 })
expect(toggles == 1, "known toggle dispatches once")
do {
    try setDesiredState(current: nil, desired: true, write: nil, toggle: { toggles += 1 })
    fatalError("unknown state must not toggle")
} catch let error as DriverFailure { expect(error.code == "unsupported", "unknown toggle support") }
expect(toggles == 1, "unreadable checkbox did not toggle")
do {
    try setDesiredState(current: "mixed", desired: false, write: nil, toggle: { toggles += 1 })
    fatalError("mixed state needs an actual setter")
} catch let error as DriverFailure { expect(error.code == "unsupported", "mixed toggle support") }
expect(toggles == 1, "mixed state does not assume a toggle cycle")
do {
    try setDesiredState(current: false, desired: true, write: {
        writes += 1
        throw DriverFailure(code: "unavailable", message: "provider timeout", uncertain: true)
    }, toggle: { toggles += 1 })
    fatalError("failed dispatch must surface")
} catch { }
expect(writes == 2 && toggles == 1, "a failed setter is never retried as a toggle")

let noOp = RequestContext(["tool": "set_checked"])
noOp.mechanism = "accessibility"; noOp.observedState = ["checked": true]
expect(noOp.receipt()["effect"] as? String == "none", "idempotent state has no effect")
noOp.events = 1
expect(noOp.receipt()["effect"] as? String == "dispatched", "accepted is not verified")
noOp.verified = true
expect(noOp.receipt()["effect"] as? String == "verified", "direct readback evidence")
let unknown = noOp.failure(DriverFailure(code: "unavailable", message: "timeout", uncertain: true))
expect((unknown["receipt"] as? JSONObject)?["effect"] as? String == "unknown", "uncertain native call stays unknown")
let read = RequestContext(["tool": "query_elements"])
expect(read.readOnly, "queries never release session input")
expect(RequestContext(["tool": "get_app_state"]).readOnly, "observations never release session input")
expect(!RequestContext(["tool": "click"]).readOnly, "actions retain cleanup")
let cancelled = read.failure(DriverFailure(code: "cancelled", message: "cancelled"))
expect(cancelled["cancelled"] as? Bool == true, "read cancellation is explicit")
expect(!DriverLifecycle.shared.stopping, "one read cancellation does not retire the helper")
print("macOS semantic state tests passed")
