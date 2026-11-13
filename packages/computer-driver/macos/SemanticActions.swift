import ApplicationServices
import Foundation

// A toggle may implement a target state only when its current state is known.
// No fallback is attempted after either callback has entered native dispatch.
func setDesiredState(current: Any?, desired: Bool, write: (() throws -> Void)?, toggle: (() throws -> Void)?) throws {
    if let current, semanticEqual(current, desired) { return }
    if let write { try write(); return }
    guard current is Bool, let toggle else {
        throw DriverFailure(code: "unsupported", message: "This control does not expose a readable and settable target state")
    }
    try toggle()
}

private func accepted(_ status: AXError, context: RequestContext) throws {
    guard status == .success else {
        throw DriverFailure(code: "input-rejected", message: "The accessibility provider did not confirm the action; observe before retrying", uncertain: true)
    }
    context.events += 1
}

private func setAttribute(_ node: AXUIElement, _ name: String, _ value: CFTypeRef, context: RequestContext) throws {
    try context.check()
    try accepted(AXUIElementSetAttributeValue(node, name as CFString, value), context: context)
}

private func performAction(_ node: AXUIElement, _ name: String, context: RequestContext) throws {
    try context.check()
    try accepted(AXUIElementPerformAction(node, name as CFString), context: context)
}

private func readback(_ node: AXUIElement, property: String, desired: Any, context: RequestContext) {
    // A provider that accepted input but cannot immediately confirm it still
    // reports dispatched, never rejected and never an automatic second input.
    if let properties = try? axProperties(node, requested: [property]), let value = properties[property] {
        context.observedState[property] = value
        context.verified = context.events > 0 && semanticEqual(value, desired)
    }
}

func performSemantic(_ kind: String, node: AXUIElement, context: RequestContext) throws {
    let op = context.operation
    if try axRead(node, kAXEnabledAttribute) as? Bool == false {
        throw DriverFailure(code: "input-rejected", message: "The selected control is disabled")
    }
    switch kind {
    case "set_value":
        let desired = op["value"] as? String ?? ""
        let current = try axProperties(node, requested: ["value"])
        if let value = current["value"], semanticEqual(value, desired) { context.observedState = current; return }
        guard axSettable(node, kAXValueAttribute) else { throw DriverFailure(code: "unsupported", message: "The control does not expose a settable value") }
        try setAttribute(node, kAXValueAttribute, desired as CFString, context: context)
        readback(node, property: "value", desired: desired, context: context)
    case "set_checked", "set_expanded":
        let property = kind == "set_checked" ? "checked" : "expanded"
        guard let desired = op[property] as? Bool else { throw DriverFailure(code: "unsupported", message: "A boolean target state is required") }
        let role = try axRead(node, kAXRoleAttribute) as? String ?? ""
        if kind == "set_checked", !["AXCheckBox", "AXRadioButton"].contains(role) {
            throw DriverFailure(code: "unsupported", message: "The selected control does not expose checkbox or radio state")
        }
        let attribute = kind == "set_checked" ? kAXValueAttribute : kAXExpandedAttribute
        let current = try axProperties(node, requested: [property])[property]
        if let current { context.observedState[property] = current }
        let write: (() throws -> Void)? = axSettable(node, attribute) ? {
            try setAttribute(node, attribute, desired ? kCFBooleanTrue : kCFBooleanFalse, context: context)
        } : nil
        // Press is a real toggle only on the corresponding native roles. A
        // radio button's primary action selects, so it cannot clear selection.
        let canToggle = role == "AXCheckBox" || role == "AXDisclosureTriangle" || role == "AXRadioButton" && desired
        let toggle: (() throws -> Void)? = canToggle && axActions(node).contains(kAXPressAction) ? {
            try performAction(node, kAXPressAction, context: context)
        } : nil
        try setDesiredState(current: current, desired: desired, write: write, toggle: toggle)
        if context.events > 0 { readback(node, property: property, desired: desired, context: context) }
    case "select":
        let mode = op["selection"] as? String ?? "replace"
        guard ["replace", "add", "remove"].contains(mode) else { throw DriverFailure(code: "unsupported", message: "The selection mode is unsupported") }
        let desired = mode != "remove"
        let properties = try axProperties(node, requested: ["selected"])
        context.observedState = properties
        if mode != "replace", let current = properties["selected"], semanticEqual(current, desired) { return }
        if mode != "replace", axSettable(node, kAXSelectedAttribute) {
            try setAttribute(node, kAXSelectedAttribute, desired ? kCFBooleanTrue : kCFBooleanFalse, context: context)
            readback(node, property: "selected", desired: desired, context: context)
            return
        }
        // Replace must replace the container's selection, not merely select one
        // child and quietly retain other selected rows in a multi-select list.
        var container = node
        var ancestors: [AXUIElement] = []
        while let value = try axRead(container, kAXParentAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
            container = value as! AXUIElement
            if ancestors.contains(where: { CFEqual($0, container) }) { break }
            ancestors.append(container)
            guard axSettable(container, kAXSelectedChildrenAttribute) else { continue }
            let current = try axRead(container, kAXSelectedChildrenAttribute) as? [AXUIElement]
            if mode != "replace", current == nil { throw DriverFailure(code: "unsupported", message: "The container's current selection is unavailable") }
            var desiredNodes = mode == "replace" ? [node] : (current ?? []).filter { !CFEqual($0, node) }
            if mode == "add" { desiredNodes.append(node) }
            func sameSelection(_ nodes: [AXUIElement]?) -> Bool {
                guard let nodes, nodes.count == desiredNodes.count else { return false }
                return desiredNodes.allSatisfy { desired in nodes.contains(where: { CFEqual($0, desired) }) }
            }
            if sameSelection(current) { context.observedState["selected"] = desired; return }
            try setAttribute(container, kAXSelectedChildrenAttribute, desiredNodes as CFArray, context: context)
            let actual = (try? axRead(container, kAXSelectedChildrenAttribute)) as? [AXUIElement]
            context.verified = sameSelection(actual)
            if let actual { context.observedState["selected"] = actual.contains(where: { CFEqual($0, node) }) }
            return
        }
        throw DriverFailure(code: "unsupported", message: "The control does not expose the requested selection operation")
    case "scroll_into_view", "secondary", "click":
        let action = kind == "scroll_into_view" ? "AXScrollToVisible" : kind == "secondary" ? op["action"] as? String ?? "" : kAXPressAction
        guard axActions(node).contains(action) else { throw DriverFailure(code: "unsupported", message: "The selected control does not expose that action") }
        try performAction(node, action, context: context)
    default: throw DriverFailure(code: "unsupported", message: "This semantic action is unsupported")
    }
}
