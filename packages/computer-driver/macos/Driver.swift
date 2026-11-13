import AppKit
import ApplicationServices
import Foundation

final class DesktopDriver {
    let capture = CaptureOwner()
    private let accessibility = AccessibilityOwner()
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
            "semanticQuery": accessibility, "scopedObservation": accessibility,
            "semanticActions": accessibility ? ["set_checked", "set_expanded", "select", "scroll_into_view"] : [],
            "semanticEvents": "polling",
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
        let target = try accessibility.target(op)
        func unavailableTree(_ reason: String) -> JSONObject {
            ["app": ["name": target.name, "pid": target.pid, "windowTitle": target.title],
                "windowTitle": target.title, "windowHandle": target.id, "windowBounds": rectJSON(target.bounds),
                "dpiScale": target.scale, "elements": [], "treeLines": [reason],
                "complete": false, "truncatedReason": "accessibility_unavailable"]
        }
        var snapshot: JSONObject
        if AXIsProcessTrusted() {
            do { snapshot = try accessibility.read(context, target: target) }
            catch let failure as DriverFailure where op["within"] == nil && op["platform_target"] == nil
                && ["target-unavailable", "target-ambiguous", "unavailable"].contains(failure.code) {
                // Keep the pre-existing screenshot-only path when the app has
                // no usable AX window. A scoped read never substitutes a tree.
                snapshot = unavailableTree(failure.message)
            }
        } else {
            if op["within"] != nil { try requireAccessibility() }
            snapshot = unavailableTree("Accessibility is unavailable.")
        }
        if op["screenshot"] as? Bool == true {
            let frame = try capture.window(target, check: context.check)
            snapshot["screenshotPngBase64"] = frame.png.base64EncodedString(); snapshot["screenshotSource"] = "window"; snapshot["capturedAt"] = frame.at
            snapshot["nativeTarget"] = accessibility.nativeTarget(target, capture: frame.sessionID) ?? frame.sessionID
        }
        try target.validate()
        capture.retainWindows(allWindows())
        return snapshot
    }

    private func query(_ context: RequestContext) throws -> JSONObject {
        try settle(context); try requireAccessibility()
        let op = context.operation
        let target: WindowTarget
        do { target = try accessibility.target(op) }
        catch let error as DriverFailure {
            if op["window_only"] as? Bool == true, op["platform_target"] == nil, error.code == "target-unavailable" {
                return ["ok": false, "code": "window_not_found", "error": error.message]
            }
            throw error
        }
        if op["window_only"] as? Bool == true {
            return ["ok": true, "snapshot": try accessibility.windowSnapshot(target, renew: op["platform_target"] == nil), "complete": true]
        }
        if let record = op["element"] as? JSONObject {
            let node = try accessibility.element(record, target: target)
            let requested = op["properties"] as? [String] ?? semanticPropertyNames
            let properties = try axProperties(node, requested: requested, shortValue: true)
            try context.check()
            let unavailable = requested.filter { properties[$0] == nil }
            return ["ok": true, "properties": properties, "unavailableProperties": unavailable, "complete": unavailable.isEmpty]
        }
        let snapshot = try accessibility.read(context, target: target, query: true)
        var result: JSONObject = ["ok": true, "snapshot": snapshot, "complete": snapshot["complete"] ?? false]
        result["nextOffset"] = snapshot["nextOffset"]
        result["reason"] = snapshot["truncatedReason"]
        return result
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
        let target: WindowTarget? = desktop ? nil : (try accessibility.target(op))
        let tool = op["tool"] as? String ?? ""
        let node = try (op["element"] as? JSONObject).map { record -> AXUIElement in
            guard let target else { throw DriverFailure(code: "unsupported", message: "The desktop image has no accessibility element mapping") }
            return try accessibility.element(record, target: target)
        }
        let method = op["click_method"] as? String ?? "auto"
        let ordinaryClick = tool == "click" && (op["mouse_button"] as? String ?? "left") == "left"
            && (op["click_count"] as? Int ?? 1) == 1 && op["x"] == nil && op["y"] == nil
        let semantic = ["set_value", "perform_secondary_action", "set_checked", "set_expanded", "select", "scroll_into_view"].contains(tool)
            || ordinaryClick && (method == "accessibility" || method == "auto" && op["input"] as? String != "global" && node.map { axActions($0).contains(kAXPressAction) } == true)
        if method == "accessibility", !semantic { throw DriverFailure(code: "unsupported", message: "Accessibility clicking requires a single left-button element primary action") }
        let captureIdentity = accessibility.captureIdentity(op["platform_target"] as? String)
        if !human, !semantic, op["expected_bounds"] != nil, captureIdentity == nil {
            throw DriverFailure(code: "target-changed", message: "Coordinate input requires the original native capture generation")
        }
        let bounds: CGRect
        if let target {
            if !semantic, let expected = rectFromJSON(op["expected_bounds"]), expected != target.bounds {
                throw DriverFailure(code: "target-changed", message: "The window moved or resized; observe again")
            }
            if !semantic, let dpi = op["expected_dpi"] as? Double, CGFloat(dpi) != target.scale {
                throw DriverFailure(code: "target-changed", message: "The window display scale changed; observe again")
            }
            if !semantic, let captureIdentity { try capture.validateWindow(target, identity: captureIdentity, check: context.check) }
            bounds = target.bounds
        } else {
            if !human && desktopObserved == nil { throw DriverFailure(code: "target-changed", message: "Observe the desktop before sending input") }
            bounds = try capture.validateDesktop(human ? nil : desktopObserved, identity: human ? nil : captureIdentity ?? desktopSession, check: context.check)
        }
        if op["input"] as? String == "app_post" || op["click_method"] as? String == "app_post" {
            throw DriverFailure(code: "unsupported", message: "Window message input is not supported on macOS")
        }
        if let target, !semantic { try target.activate() }
        func validate() throws {
            try requireAccessibility()
            if let target {
                if !semantic, let captureIdentity { try capture.validateWindow(target, identity: captureIdentity, check: context.check) }
                if semantic { try accessibility.validateWindow(target) } else { try target.focusMatches() }
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
        let kind = human ? op["kind"] as? String ?? "" : ["click": "click", "type_text": "text", "press_key": "key", "scroll": "scroll", "drag": "drag", "set_value": "set_value", "perform_secondary_action": "secondary", "set_checked": "set_checked", "set_expanded": "set_expanded", "select": "select", "scroll_into_view": "scroll_into_view"][tool] ?? ""
        let buttonName = op[human ? "button" : "mouse_button"] as? String ?? "left"
        guard let button = ["left": CGMouseButton.left, "right": .right, "middle": .center][buttonName] else {
            throw DriverFailure(code: "input-rejected", message: "The requested pointer button is invalid")
        }
        context.mechanism = semantic ? "accessibility" : "global"
        if semantic {
            guard let node else { throw DriverFailure(code: "target_lost", message: "This semantic action requires an observed element") }
            try validate(); context.progress("target", target: axFrame(node))
            try performSemantic(kind, node: node, context: context)
            if context.events > 0 { lastInput = Date() }
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
        if context.events > 0 { context.progress("dispatched") }
        return ["ok": true, "receipt": context.receipt()]
    }

    func perform(_ context: RequestContext) throws -> JSONObject {
        let op = context.operation, tool = op["tool"] as? String ?? ""
        switch tool {
        case "ping": return ["ok": true]
        case "capabilities": return ["ok": true, "capabilities": capabilities()]
        case "release_input": try releaseInput(); return ["ok": true]
        case "list_apps": return ["ok": true, "apps": listApps()]
        case "get_app_state": return ["ok": true, "snapshot": try observe(context)]
        case "query_elements": return try query(context)
        case "release_elements": accessibility.release(op["elements"] as? [JSONObject] ?? []); return ["ok": true]
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
