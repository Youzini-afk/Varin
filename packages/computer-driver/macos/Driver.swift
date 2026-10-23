import AppKit
import ApplicationServices
import Foundation

struct TreeObservation {
    let target: WindowTarget
    let root: AXUIElement?
    let elements: [String: AXUIElement]
}

final class DesktopDriver {
    let capture = CaptureOwner()
    private var observations: [CGWindowID: TreeObservation] = [:]
    private var desktopObserved: CGRect?
    private var desktopSession: String?
    private var keys = Set<CGKeyCode>()
    private var buttons = Set<CGMouseButton.RawValue>()
    private var lastPoint = CGPoint.zero
    private var lastInput = Date.distantPast
    private let eventSource = CGEventSource(stateID: .privateState)

    private func settle(_ context: RequestContext) throws {
        let remaining = 0.12 - Date().timeIntervalSince(lastInput)
        if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
        try context.check()
    }

    func capabilities() -> JSONObject {
        let accessibility = AXIsProcessTrusted(), screen = CGPreflightScreenCaptureAccess()
        return ["platform": "macos", "driver": "macos-native", "driverVersion": "1", "sessionType": "aqua",
            "applicationTools": ["browser": false, "office": false],
            "observeTree": accessibility, "elementAction": accessibility, "screenshot": screen,
            "coordinateInput": accessibility, "textInput": accessibility, "drag": accessibility,
            "multiWindow": true, "interruptibleInput": true, "occludedCapture": true,
            "permissions": ["accessibility": accessibility ? "granted" : "not-granted", "screenCapture": screen ? "granted" : "not-granted"],
            "status": accessibility && screen ? "ready" : "unavailable",
            "detail": accessibility && screen ? "Native platform behavior requires macOS acceptance testing" : "Grant Varin Computer Accessibility and Screen Recording permissions separately in macOS settings"]
    }

    func listApps() -> [JSONObject] {
        let grouped = Dictionary(grouping: allWindows(), by: { $0.pid })
        return grouped.values.compactMap { windows in
            guard let first = windows.first else { return nil }
            return ["name": first.name, "pid": first.pid, "windowTitle": first.title, "windows": windows.map { $0.descriptor }]
        }
    }

    func observe(_ context: RequestContext) throws -> JSONObject {
        try settle(context)
        let op = context.operation
        let app = (op["app"] as? String ?? "").lowercased()
        if ["desktop", "screen", "shared desktop", "0"].contains(app) {
            let (frame, bounds) = try capture.desktop(renew: true, check: context.check)
            desktopObserved = bounds; desktopSession = frame.sessionID
            var snapshot: JSONObject = ["app": ["name": "Shared desktop", "pid": 0], "windowHandle": CGMainDisplayID(),
                "windowTitle": "Shared desktop", "windowBounds": rectJSON(bounds), "treeLines": [], "elements": [], "capturedAt": frame.at, "nativeTarget": frame.sessionID]
            if op["screenshot"] as? Bool == true { snapshot["screenshotPngBase64"] = frame.png.base64EncodedString(); snapshot["screenshotSource"] = "screen" }
            return snapshot
        }
        let target = try resolveTarget(op)
        var tree: [JSONObject] = [], lines: [String] = [], elements: [String: AXUIElement] = [:]
        let root = AXIsProcessTrusted() ? (try? target.axWindow()) : nil
        let maxNodes = (op["max_tree_nodes"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 1200
        let maxDepth = (op["max_tree_depth"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 64
        func visit(_ node: AXUIElement, path: [Int]) throws {
            try context.check()
            if tree.count >= maxNodes || path.count > maxDepth { return }
            let role = axString(node, kAXRoleAttribute).replacingOccurrences(of: "AX", with: "", options: .anchored)
            let title = axString(node, kAXTitleAttribute)
            let name = title.isEmpty ? axString(node, kAXDescriptionAttribute) : title
            let token = observations[target.id]?.elements.first(where: { CFEqual($0.value, node) })?.key ?? UUID().uuidString
            var record: JSONObject = ["index": tree.count, "automationId": token, "path": path, "controlType": role, "name": name, "actions": axActions(node)]
            let value = axString(node, kAXValueAttribute)
            if !value.isEmpty { record["value"] = value }
            if let rect = axFrame(node) { record["frame"] = rectJSON(rect.offsetBy(dx: -target.bounds.minX, dy: -target.bounds.minY)) }
            lines.append("\(tree.count) \(role) \(name)")
            tree.append(record); elements[token] = node
            for (index, child) in axChildren(node).enumerated() { try visit(child, path: path + [index]) }
        }
        if let root { try visit(root, path: []) }
        else { lines.append("Accessibility is unavailable or the window mapping is ambiguous; no unrelated tree was attached.") }
        var snapshot: JSONObject = ["app": ["name": target.name, "pid": target.pid, "windowTitle": target.title],
            "windowTitle": target.title, "windowHandle": target.id, "windowBounds": rectJSON(target.bounds), "dpiScale": target.scale,
            "windows": allWindows().filter { $0.pid == target.pid }.map { $0.descriptor }, "elements": tree, "treeLines": lines]
        if op["screenshot"] as? Bool == true {
            let frame = try capture.window(target, check: context.check)
            snapshot["screenshotPngBase64"] = frame.png.base64EncodedString(); snapshot["screenshotSource"] = "window"; snapshot["capturedAt"] = frame.at; snapshot["nativeTarget"] = frame.sessionID
        }
        try target.validate()
        let windows = allWindows()
        capture.retainWindows(windows)
        let live = Set(windows.map { $0.id })
        observations = observations.filter { live.contains($0.key) }
        observations[target.id] = TreeObservation(target: target, root: root, elements: elements)
        return snapshot
    }

    private func element(_ record: JSONObject, target: WindowTarget) throws -> AXUIElement {
        guard let path = record["path"] as? [Int], let observation = observations[target.id], observation.target.pid == target.pid,
              let token = record["automationId"] as? String, let original = observation.elements[token],
              let root = observation.root, CFEqual(root, try target.axWindow()) else {
            throw DriverFailure(code: "target-changed", message: "The element is not bound to the latest observation of this window")
        }
        var current = root
        for index in path {
            let children = axChildren(current)
            guard children.indices.contains(index) else { throw DriverFailure(code: "target-changed", message: "The observed element path changed") }
            current = children[index]
        }
        guard CFEqual(original, current) else { throw DriverFailure(code: "target-changed", message: "The observed element was replaced") }
        return current
    }

    private var flags: CGEventFlags {
        var result: CGEventFlags = []
        if keys.contains(55) { result.insert(.maskCommand) }
        if keys.contains(56) { result.insert(.maskShift) }
        if keys.contains(58) { result.insert(.maskAlternate) }
        if keys.contains(59) { result.insert(.maskControl) }
        return result
    }
    private func post(_ event: CGEvent?, context: RequestContext?, validate: () throws -> Void) throws {
        try context?.check(); try validate()
        guard let event else { throw DriverFailure(code: "input-rejected", message: "macOS could not create the input event") }
        event.flags = flags
        event.post(tap: .cghidEventTap)
        context?.events += 1; lastInput = Date()
    }
    private func key(_ code: CGKeyCode, down: Bool, context: RequestContext?, validate: () throws -> Void) throws {
        let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down)
        try context?.check(); try validate()
        let previous = keys
        if down { keys.insert(code) } else { keys.remove(code) }
        do { try post(event, context: context, validate: validate) }
        catch { keys = previous; throw error }
    }
    private func mouse(_ kind: String, _ point: CGPoint, _ button: CGMouseButton, count: Int64 = 1, context: RequestContext?, validate: () throws -> Void) throws {
        let type: CGEventType = kind == "move" ? (buttons.isEmpty ? .mouseMoved : buttons.contains(CGMouseButton.left.rawValue) ? .leftMouseDragged : buttons.contains(CGMouseButton.right.rawValue) ? .rightMouseDragged : .otherMouseDragged)
            : button == .left ? (kind == "down" ? .leftMouseDown : .leftMouseUp)
            : button == .right ? (kind == "down" ? .rightMouseDown : .rightMouseUp) : (kind == "down" ? .otherMouseDown : .otherMouseUp)
        let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: button)
        event?.setIntegerValueField(.mouseEventClickState, value: count)
        try post(event, context: context, validate: validate)
        lastPoint = point
        if kind == "down" { buttons.insert(button.rawValue) }
        if kind == "up" { buttons.remove(button.rawValue) }
    }
    func releaseInput() throws {
        // Only keys and buttons owned by this helper. No blanket keyboard reset.
        for raw in buttons {
            if let button = CGMouseButton(rawValue: raw) { try mouse("up", lastPoint, button, context: nil, validate: {}) }
        }
        for code in keys { try key(code, down: false, context: nil, validate: {}) }
    }

    func act(_ context: RequestContext) throws -> JSONObject {
        try requireAccessibility(); try context.check()
        let op = context.operation, human = op["tool"] as? String == "inject_input"
        let app = (op["app"] as? String ?? "").lowercased()
        let desktop = human || ["0", "desktop", "screen", "shared desktop"].contains(app)
        let target: WindowTarget? = desktop ? nil : (try resolveTarget(op))
        let captureIdentity = op["platform_target"] as? String
        if !human, op["expected_bounds"] != nil, captureIdentity == nil {
            throw DriverFailure(code: "target-changed", message: "Coordinate input requires the original native capture generation")
        }
        let bounds: CGRect
        if let target {
            if let expected = rectFromJSON(op["expected_bounds"]), expected != target.bounds {
                throw DriverFailure(code: "target-changed", message: "The window moved or resized; observe again")
            }
            if let dpi = op["expected_dpi"] as? Double, CGFloat(dpi) != target.scale {
                throw DriverFailure(code: "target-changed", message: "The window display scale changed; observe again")
            }
            if let captureIdentity { try capture.validateWindow(target, identity: captureIdentity, check: context.check) }
            bounds = target.bounds
        } else {
            if !human && desktopObserved == nil { throw DriverFailure(code: "target-changed", message: "Observe the desktop before sending input") }
            bounds = try capture.validateDesktop(human ? nil : desktopObserved, identity: human ? nil : captureIdentity ?? desktopSession, check: context.check)
        }
        let node = try (op["element"] as? JSONObject).map { record -> AXUIElement in
            guard let target else { throw DriverFailure(code: "unsupported", message: "The desktop image has no accessibility element mapping") }
            return try element(record, target: target)
        }
        let tool = op["tool"] as? String ?? ""
        let semantic = tool == "set_value" || tool == "perform_secondary_action" || op["click_method"] as? String == "accessibility"
        if op["input"] as? String == "app_post" || op["click_method"] as? String == "app_post" {
            throw DriverFailure(code: "unsupported", message: "Window message input is not supported on macOS")
        }
        if let target, !semantic { try target.activate() }
        func validate() throws {
            try requireAccessibility()
            if let target {
                if let captureIdentity { try capture.validateWindow(target, identity: captureIdentity, check: context.check) }
                if semantic { try target.validate() } else { try target.focusMatches() }
            }
            else { _ = try capture.validateDesktop(bounds, identity: human ? nil : captureIdentity ?? desktopSession, check: context.check) }
            if ["type_text", "press_key"].contains(tool), let node,
               axValue(node, kAXFocusedAttribute) as? Bool != true {
                throw DriverFailure(code: "focus-changed", message: "Focus left the selected control; the remaining input was stopped")
            }
        }
        func point(_ x: Any?, _ y: Any?) throws -> CGPoint {
            if x == nil, y == nil, let node, let frame = axFrame(node) { return CGPoint(x: frame.midX, y: frame.midY) }
            guard let x = x as? Double, let y = y as? Double, x.isFinite, y.isFinite else {
                throw DriverFailure(code: "input-rejected", message: "Pointer input needs finite coordinates or a current element")
            }
            let point = human ? CGPoint(x: x, y: y) : CGPoint(x: bounds.minX + x, y: bounds.minY + y)
            guard bounds.contains(point) else { throw DriverFailure(code: "input-rejected", message: "The input point is outside the observed target") }
            return point
        }
        let kind = human ? op["kind"] as? String ?? "" : ["click": "click", "type_text": "text", "press_key": "key", "scroll": "scroll", "drag": "drag", "set_value": "set_value", "perform_secondary_action": "secondary"][tool] ?? ""
        let buttonName = op[human ? "button" : "mouse_button"] as? String ?? "left"
        guard let button = ["left": CGMouseButton.left, "right": .right, "middle": .center][buttonName] else {
            throw DriverFailure(code: "input-rejected", message: "The requested pointer button is invalid")
        }
        if semantic {
            guard let node else { throw DriverFailure(code: "target-changed", message: "This semantic action requires a current observed element") }
            try validate(); context.progress("target", target: axFrame(node))
            if kind == "set_value" {
                let value = op["value"] as? String ?? ""
                let status = AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, value as CFString)
                guard status == .success else { throw DriverFailure(code: "input-rejected", message: "The selected control did not accept a value", uncertain: status == .cannotComplete) }
                context.events += 1
                guard axString(node, kAXValueAttribute) == value else { throw DriverFailure(code: "verification-failed", message: "The control did not confirm the requested value") }
                context.verified = true
            } else {
                let action = kind == "secondary" ? op["action"] as? String ?? "" : kAXPressAction
                guard axActions(node).contains(action) else { throw DriverFailure(code: "unsupported", message: "The selected control does not expose that action") }
                let status = AXUIElementPerformAction(node, action as CFString)
                guard status == .success else { throw DriverFailure(code: "input-rejected", message: "The accessibility action was not confirmed", uncertain: status == .cannotComplete) }
                context.events += 1
            }
        } else if ["click", "down", "up", "move"].contains(kind) {
            let location = try point(op["x"], op["y"])
            try target?.ownsPoint(location)
            context.progress("target", point: location, target: bounds)
            if kind == "click" {
                let count = op[human ? "count" : "click_count"] as? Int ?? 1
                guard count > 0 else { throw DriverFailure(code: "input-rejected", message: "Click count must be positive") }
                for index in 1...count {
                    try mouse("down", location, button, count: Int64(index), context: context, validate: { try validate(); try target?.ownsPoint(location) })
                    try mouse("up", location, button, count: Int64(index), context: context, validate: validate)
                }
            } else { try mouse(kind, location, button, context: context, validate: validate) }
        } else if kind == "drag" {
            let from = try point(op["from_x"], op["from_y"]), to = try point(op["to_x"], op["to_y"])
            try target?.ownsPoint(from)
            context.progress("target", point: from, to: to, target: bounds)
            try mouse("down", from, button, context: context, validate: validate)
            for step in 1...18 {
                let ratio = CGFloat(step) / 18
                try mouse("move", CGPoint(x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio), button, context: context, validate: validate)
                Thread.sleep(forTimeInterval: 1 / 60)
            }
            try mouse("up", to, button, context: context, validate: validate)
        } else if kind == "text" || kind == "key" {
            if let node {
                guard AXUIElementSetAttributeValue(node, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success,
                      axValue(node, kAXFocusedAttribute) as? Bool == true else {
                    throw DriverFailure(code: "focus-changed", message: "The selected control did not receive keyboard focus")
                }
            }
            context.progress("target", target: bounds)
            if kind == "text" {
                for scalar in (op["text"] as? String ?? "").unicodeScalars {
                    let text = Array(String(scalar).utf16)
                    for down in [true, false] {
                        let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down)
                        event?.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
                        try post(event, context: context, validate: validate)
                        if down { keys.insert(0) } else { keys.remove(0) }
                    }
                }
            } else {
                let codes = try (op["key"] as? String ?? "").components(separatedBy: "+").map { try keyCode($0.trimmingCharacters(in: .whitespaces)) }
                for code in codes { try key(code, down: true, context: context, validate: validate) }
                for code in codes.reversed() { try key(code, down: false, context: context, validate: validate) }
            }
        } else if kind == "scroll" {
            let direction = op["direction"] as? String ?? "down", pages = op["pages"] as? Double ?? 1
            guard ["up", "down", "left", "right"].contains(direction), pages.isFinite, pages > 0 else {
                throw DriverFailure(code: "input-rejected", message: "Scroll direction and distance are invalid")
            }
            let location = try point(op["x"] ?? bounds.width / 2, op["y"] ?? bounds.height / 2)
            try mouse("move", location, button, context: context, validate: validate)
            let horizontal = direction == "left" || direction == "right"
            let distance = pages * (horizontal ? bounds.width : bounds.height)
            guard distance.isFinite else { throw DriverFailure(code: "input-rejected", message: "Scroll distance exceeds the native numeric range") }
            var remaining = distance
            context.progress("target", point: location, target: bounds)
            while remaining > 0 {
                let amount = min(remaining, 100), signed = Int32(amount.rounded()) * (["up", "left"].contains(direction) ? 1 : -1)
                let event = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2,
                    wheel1: horizontal ? 0 : signed, wheel2: horizontal ? signed : 0, wheel3: 0)
                try post(event, context: context, validate: validate); remaining -= amount
            }
        } else { throw DriverFailure(code: "unsupported", message: "The requested native operation is not supported") }
        context.progress("dispatched")
        return ["ok": true, "receipt": ["effect": context.verified ? "verified" : "dispatched", "dispatchedEvents": context.events]]
    }

    func perform(_ context: RequestContext) throws -> JSONObject {
        let op = context.operation, tool = op["tool"] as? String ?? ""
        switch tool {
        case "ping": return ["ok": true]
        case "capabilities": return ["ok": true, "capabilities": capabilities()]
        case "release_input": try releaseInput(); return ["ok": true]
        case "list_apps": return ["ok": true, "apps": listApps()]
        case "get_app_state": return ["ok": true, "snapshot": try observe(context)]
        case "capture_frame":
            let (frame, bounds) = try capture.desktop(check: context.check)
            return ["ok": true, "frame": frame.json(bounds: bounds)]
        case "open":
            let fields = ["url", "path", "command"].filter { op[$0] as? String != nil }
            guard fields.count == 1, let target = op[fields[0]] as? String else { throw DriverFailure(code: "input-rejected", message: "Open requires exactly one URL, path or command") }
            try context.check()
            let process = Process()
            if fields[0] == "command" {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = [target] + (op["args"] as? [String] ?? [])
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open"); process.arguments = [target]
            }
            process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); return ["ok": true, "pid": process.processIdentifier]
        default:
            var result = try act(context)
            if let state = op["return_state"] as? String, state != "none" {
                var read = op; read["screenshot"] = state == "screenshot"
                do { result["snapshot"] = try observe(RequestContext(read)) }
                catch { result["text"] = "Input was dispatched; a new observation is needed before the next action." }
            }
            return result
        }
    }
}
