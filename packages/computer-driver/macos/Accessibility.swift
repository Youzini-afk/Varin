import AppKit
import ApplicationServices
import Foundation

// AX objects, not child indexes, are the native identity. Multiple observations
// share these handles; the Host releases a token when its last observation ends.
private struct AXIdentity: Hashable {
    let node: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.node, rhs.node) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(node)) }
}

private final class AXWindowState {
    let token = UUID().uuidString
    let pid: pid_t
    let launchDate: Date?
    let root: AXUIElement
    var elements: [String: AXUIElement] = [:]
    var identities: [AXIdentity: String] = [:]
    init(_ target: WindowTarget, root: AXUIElement) {
        pid = target.pid; launchDate = NSRunningApplication(processIdentifier: pid)?.launchDate; self.root = root
    }
    func retain(_ node: AXUIElement) -> String {
        let identity = AXIdentity(node: node)
        if let token = identities[identity] { return token }
        let token = UUID().uuidString
        identities[identity] = token; elements[token] = node
        return token
    }
    func release(_ token: String) {
        if let node = elements.removeValue(forKey: token) { identities.removeValue(forKey: AXIdentity(node: node)) }
    }
}

func semanticRole(_ platformRole: String) -> String {
    let roles = ["AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio",
        "AXTextField": "textbox", "AXTextArea": "textbox", "AXStaticText": "text", "AXLink": "link",
        "AXPopUpButton": "combobox", "AXComboBox": "combobox", "AXMenu": "menu", "AXMenuItem": "menuitem",
        "AXMenuBar": "menubar", "AXTabGroup": "tablist", "AXTab": "tab", "AXTable": "table",
        "AXRow": "row", "AXCell": "cell", "AXColumn": "column", "AXOutline": "tree",
        "AXList": "list", "AXGroup": "group", "AXScrollArea": "group", "AXWindow": "window",
        "AXSlider": "slider", "AXProgressIndicator": "progressbar", "AXImage": "image",
        "AXScrollBar": "scrollbar", "AXDisclosureTriangle": "button"]
    return roles[platformRole] ?? platformRole.replacingOccurrences(of: "AX", with: "", options: .anchored).lowercased()
}

func semanticMatches(_ properties: JSONObject, _ match: JSONObject) -> Bool {
    for (key, expected) in match where key != "nameMatch" {
        guard let actual = properties[key] else { return false }
        if key == "name", match["nameMatch"] as? String == "contains", let name = actual as? String, let fragment = expected as? String {
            if !name.contains(fragment) { return false }
        } else if !semanticEqual(actual, expected) { return false }
    }
    return true
}

func semanticMatchUnavailable(_ properties: JSONObject, _ match: JSONObject) -> Bool {
    var missing = false
    for (key, expected) in match where key != "nameMatch" {
        guard properties[key] != nil else { missing = true; continue }
        var condition: JSONObject = [key: expected]
        if key == "name" { condition["nameMatch"] = match["nameMatch"] }
        if !semanticMatches(properties, condition) { return false }
    }
    return missing
}

func semanticEqual(_ actual: Any, _ expected: Any) -> Bool {
    guard let actual = actual as? NSObject, let expected = expected as? NSObject else { return false }
    return actual == expected
}

func axSettable(_ node: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(node, attribute as CFString, &settable) == .success && settable.boolValue
}

func axRead(_ node: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
    switch status {
    case .success: return value
    case .attributeUnsupported, .noValue: return nil
    case .invalidUIElement: throw DriverFailure(code: "target_lost", message: "The original accessibility element is no longer available")
    default: throw DriverFailure(code: "unavailable", message: "The accessibility provider could not read the requested property")
    }
}

// Protection is inherited by descendants. In particular, AXValue must never
// be fetched first and redacted afterwards: it may contain a secure field's
// plaintext even when the visible widget renders bullets.
func axNodeProtected(_ node: AXUIElement) throws -> Bool {
    if try axRead(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { return true }
    return try axRead(node, "AXContainsProtectedContent") as? Bool == true
}

func axProtected(_ node: AXUIElement) throws -> Bool {
    var current = node
    var seen = Set<AXIdentity>()
    while seen.insert(AXIdentity(node: current)).inserted {
        if try axNodeProtected(current) { return true }
        guard let parent = try axRead(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
        current = parent as! AXUIElement
    }
    // A malformed ancestry cannot establish that text is safe to expose.
    return true
}

let semanticPropertyNames = ["name", "role", "platformRole", "value", "enabled", "selected", "checked", "expanded", "focused", "actions"]

func axProperties(_ node: AXUIElement, requested: [String] = semanticPropertyNames, protectedContent: Bool? = nil, shortValue: Bool = false, readAttribute: ((String) throws -> CFTypeRef?)? = nil) throws -> JSONObject {
    let read: (String) throws -> CFTypeRef? = readAttribute ?? { try axRead(node, $0) }
    var result: JSONObject = [:]
    let protected = try protectedContent ?? (requested.contains("name") || requested.contains("value") ? axProtected(node) : false)
    var role: String?
    func platformRole() throws -> String {
        if let role { return role }
        guard let value = try read(kAXRoleAttribute) as? String, !value.isEmpty else {
            throw DriverFailure(code: "unavailable", message: "The accessibility provider did not expose the element role")
        }
        role = value; return value
    }
    for property in requested {
        switch property {
        case "name":
            if protected { continue }
            let title = try read(kAXTitleAttribute) as? String
            if let title, !title.isEmpty { result[property] = title }
            else { result[property] = try read(kAXDescriptionAttribute) as? String ?? "" }
        case "role": result[property] = semanticRole(try platformRole())
        case "platformRole": result[property] = try platformRole()
        case "value":
            if protected { continue }
            if shortValue, let count = try read(kAXNumberOfCharactersAttribute) as? NSNumber, count.intValue > 500 { continue }
            if let value = try read(kAXValueAttribute) {
                if let text = value as? String {
                    if !shortValue || text.utf16.count <= 500 { result[property] = text }
                }
                else if let number = value as? NSNumber { result[property] = number.stringValue }
            }
        case "checked":
            // AXValue has role-specific meaning. A slider's 0/1 is not checked.
            if ["AXCheckBox", "AXRadioButton"].contains(try platformRole()), let value = try read(kAXValueAttribute) as? NSNumber {
                if value.intValue == 0 { result[property] = false }
                else if value.intValue == 1 { result[property] = true }
                else if value.intValue == 2 { result[property] = "mixed" }
            }
        case "enabled", "selected", "expanded", "focused":
            let attribute = ["enabled": kAXEnabledAttribute, "selected": kAXSelectedAttribute,
                "expanded": kAXExpandedAttribute, "focused": kAXFocusedAttribute][property]!
            if let value = try read(attribute) as? NSNumber { result[property] = value.boolValue }
        case "actions":
            var names: CFArray?
            let status = AXUIElementCopyActionNames(node, &names)
            if status == .success { result[property] = names as? [String] ?? [] }
            else if status == .invalidUIElement { throw DriverFailure(code: "target_lost", message: "The original accessibility element is no longer available") }
            else if status != .notImplemented && status != .actionUnsupported { throw DriverFailure(code: "unavailable", message: "The accessibility provider could not read available actions") }
        default: break
        }
    }
    return result
}

final class AccessibilityOwner {
    private var windows: [CGWindowID: AXWindowState] = [:]

    // The opaque target also carries an optional raster generation. Semantic
    // references survive movement; the capture owner still fences old pixels.
    func captureIdentity(_ token: String?) -> String? {
        guard let token else { return nil }
        if !token.hasPrefix("ax:") { return token }
        let parts = token.split(separator: ":", omittingEmptySubsequences: false)
        return parts.count == 3 ? String(parts[2]) : nil
    }
    private func windowToken(_ token: String?) -> String? {
        guard let token, token.hasPrefix("ax:") else { return nil }
        return token.split(separator: ":").dropFirst().first.map(String.init)
    }
    func target(_ operation: JSONObject) throws -> WindowTarget {
        if let token = windowToken(operation["platform_target"] as? String) {
            guard let (id, state) = windows.first(where: { $0.value.token == token }) else {
                throw DriverFailure(code: "target_lost", message: "The original native observation has expired")
            }
            guard let target = allWindows().first(where: { $0.id == id && $0.pid == state.pid }) else {
                throw DriverFailure(code: "window_lost", message: "The original window has closed")
            }
            try validate(state, target: target)
            return target
        }
        return try resolveTarget(operation)
    }
    private func validate(_ state: AXWindowState, target: WindowTarget) throws {
        try requireAccessibility()
        guard state.pid == target.pid, let application = NSRunningApplication(processIdentifier: state.pid),
              application.launchDate == state.launchDate else {
            throw DriverFailure(code: "window_lost", message: "The original application instance is no longer available")
        }
        guard let currentWindows = try axRead(AXUIElementCreateApplication(state.pid), kAXWindowsAttribute) as? [AXUIElement] else {
            throw DriverFailure(code: "unavailable", message: "The provider did not expose its current windows")
        }
        guard currentWindows.contains(where: { CFEqual($0, state.root) }) else {
            throw DriverFailure(code: "window_lost", message: "The original accessibility window is no longer available")
        }
    }
    private func state(_ target: WindowTarget, renew: Bool = true) throws -> AXWindowState {
        if let state = windows[target.id] {
            do { try validate(state, target: target); return state }
            catch let failure as DriverFailure where failure.code == "window_lost" && renew { /* A new unbound observation may adopt the new window. */ }
        }
        let state = AXWindowState(target, root: try target.axWindow())
        windows[target.id] = state
        return state
    }
    func validateWindow(_ target: WindowTarget) throws {
        guard let state = windows[target.id] else { throw DriverFailure(code: "target_lost", message: "The original native observation has expired") }
        try validate(state, target: target)
    }
    func element(_ record: JSONObject, target: WindowTarget) throws -> AXUIElement {
        guard let state = windows[target.id], let token = record["automationId"] as? String, let original = state.elements[token] else {
            throw DriverFailure(code: "target_lost", message: "The original native element reference has expired")
        }
        try validate(state, target: target)
        var pid: pid_t = 0
        guard AXUIElementGetPid(original, &pid) == .success, pid == target.pid else {
            throw DriverFailure(code: "target_lost", message: "The original accessibility element is no longer available")
        }
        _ = try axRead(original, kAXRoleAttribute)
        if CFEqual(original, state.root) { return original }
        if let window = try axRead(original, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID(), CFEqual(window, state.root) { return original }
        // Some providers omit AXWindow. The parent chain confirms membership
        // without reading siblings or interpreting an obsolete child-index path.
        var current = original
        var seen = Set<AXIdentity>()
        while seen.insert(AXIdentity(node: current)).inserted {
            guard let parent = try axRead(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            current = parent as! AXUIElement
            if CFEqual(current, state.root) { return original }
        }
        throw DriverFailure(code: "target_lost", message: "The original element no longer belongs to its observed window")
    }
    func release(_ records: [JSONObject]) {
        for record in records {
            guard let token = record["automationId"] as? String else { continue }
            for state in windows.values { state.release(token) }
        }
    }
    func prune(_ live: [WindowTarget]) {
        let ids = Set(live.map { $0.id })
        // Keep window identity until references are released so a close remains
        // distinguishable from an expired element in an in-flight await.
        windows = windows.filter { ids.contains($0.key) || !$0.value.elements.isEmpty }
    }
    func nativeTarget(_ target: WindowTarget, capture: String? = nil) -> String? {
        guard let state = windows[target.id] else { return nil }
        return "ax:\(state.token)" + (capture.map { ":\($0)" } ?? "")
    }
    func windowSnapshot(_ target: WindowTarget, renew: Bool) throws -> JSONObject {
        let state = try state(target, renew: renew)
        return ["app": ["name": target.name, "pid": target.pid, "windowTitle": target.title],
            "windowTitle": target.title, "windowHandle": target.id, "windowBounds": rectJSON(target.bounds),
            "nativeTarget": "ax:\(state.token)", "elements": [], "treeLines": [], "complete": true]
    }
    func read(_ context: RequestContext, target: WindowTarget, query: Bool = false) throws -> JSONObject {
        let op = context.operation
        let state = try self.state(target, renew: op["platform_target"] == nil && op["within"] == nil)
        let root = try (op["within"] as? JSONObject).map { try element($0, target: target) } ?? state.root
        let maxNodes = (op["max_tree_nodes"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 1200
        let maxDepth = (op["max_tree_depth"] as? Int).flatMap { $0 >= 0 ? $0 : nil } ?? 64
        let match = query ? op["match"] as? JSONObject ?? [:] : [:]
        let rootProtected = try axProtected(root)
        let discoveryProperties = ["name", "role", "platformRole"] + match.keys.filter { !["name", "role", "platformRole", "nameMatch"].contains($0) }
        let offset = max(0, op["offset"] as? Int ?? 0)
        let limit = (op["limit"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? maxNodes
        var records: [JSONObject] = [], retainedNodes: [AXUIElement] = []
        var visited = 0, matches = 0, truncated: String?
        var seen = Set<AXIdentity>()
        func visit(_ node: AXUIElement, path: [Int], parent: Int?, ancestors: [String], protectedAncestor: Bool) throws {
            try context.check()
            guard visited < maxNodes else { truncated = "node_limit"; return }
            guard seen.insert(AXIdentity(node: node)).inserted else { truncated = "provider_cycle"; return }
            visited += 1
            let protected = try protectedAncestor || axNodeProtected(node)
            var properties = try axProperties(node, requested: query ? discoveryProperties : semanticPropertyNames, protectedContent: protected, shortValue: query)
            let index = visited - 1
            properties["index"] = index; properties["path"] = path; properties["depth"] = path.count
            if !ancestors.isEmpty { properties["ancestorLabels"] = ancestors }
            properties["controlType"] = (properties["platformRole"] as? String ?? "").replacingOccurrences(of: "AX", with: "", options: .anchored)
            if let parent { properties["parentIndex"] = parent }
            let children = try axRead(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
            let depthLimited = path.count >= maxDepth && !children.isEmpty
            if depthLimited { truncated = truncated ?? "depth_limit" }
            properties["hasMoreChildren"] = depthLimited || (!children.isEmpty && visited >= maxNodes)
            if semanticMatchUnavailable(properties, match) { truncated = truncated ?? "property_unavailable" }
            var recordPosition: Int?
            if semanticMatches(properties, match) {
                if matches >= offset && records.count < limit {
                    if query {
                        let additional = semanticPropertyNames.filter { !discoveryProperties.contains($0) }
                        properties.merge(try axProperties(node, requested: additional, protectedContent: protected, shortValue: true)) { _, value in value }
                    }
                    if let frame = axFrame(node) { properties["frame"] = rectJSON(frame.offsetBy(dx: -target.bounds.minX, dy: -target.bounds.minY)) }
                    recordPosition = records.count
                    records.append(properties); retainedNodes.append(node)
                }
                matches += 1
            }
            if !depthLimited {
                for (indexInParent, child) in children.enumerated() {
                    if visited >= maxNodes {
                        truncated = "node_limit"
                        if let recordPosition { records[recordPosition]["hasMoreChildren"] = true }
                        break
                    }
                    let name = properties["name"] as? String ?? ""
                    try visit(child, path: path + [indexInParent], parent: index, ancestors: name.isEmpty ? ancestors : ancestors + [name], protectedAncestor: protected)
                }
            }
        }
        try visit(root, path: [], parent: nil, ancestors: [], protectedAncestor: rootProtected)
        try validate(state, target: target)
        try context.check()
        // Publish native handles only after the whole read succeeds. Cancelling
        // a partial traversal must not leave unpublished element references.
        for index in records.indices { records[index]["automationId"] = state.retain(retainedNodes[index]) }
        let all = allWindows()
        prune(all)
        var snapshot: JSONObject = ["app": ["name": target.name, "pid": target.pid, "windowTitle": target.title],
            "windowTitle": target.title, "windowHandle": target.id, "windowBounds": rectJSON(target.bounds), "dpiScale": target.scale,
            "windows": all.filter { $0.pid == target.pid }.map { $0.descriptor }, "elements": records,
            "treeLines": records.map { "\($0["index"] ?? 0) \($0["role"] ?? "") \($0["name"] ?? "")" },
            "complete": truncated == nil, "view": op["view"] as? String ?? "tree", "nativeTarget": "ax:\(state.token)"]
        if let truncated { snapshot["truncatedReason"] = truncated }
        if offset + records.count < matches { snapshot["nextOffset"] = offset + records.count }
        return snapshot
    }
}
