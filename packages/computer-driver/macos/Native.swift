import AppKit
import ApplicationServices
import Carbon
import Foundation

typealias JSONObject = [String: Any]

struct DriverFailure: Error {
    let code: String
    let message: String
    var uncertain = false
}

final class RequestContext {
    let operation: JSONObject
    let id: String
    var events = 0
    var verified = false
    init(_ operation: JSONObject) { self.operation = operation; id = operation["id"] as? String ?? "" }
    func check() throws {
        if DriverLifecycle.shared.stopping || (ProcessInfo.processInfo.environment["VARIN_DRIVER_CANCEL_DIR"].map {
            FileManager.default.fileExists(atPath: ($0 as NSString).appendingPathComponent(id + ".cancel"))
        } ?? false) { throw DriverFailure(code: "cancelled", message: "The computer operation was cancelled") }
    }
    func failure(_ error: Error) -> JSONObject {
        let failure = error as? DriverFailure ?? DriverFailure(code: "driver-error", message: "The native operation failed; observe before retrying", uncertain: true)
        let effect = failure.uncertain ? "unknown" : events > 0 ? "partial" : "none"
        return ["ok": false, "error": failure.message, "cancelled": failure.code == "cancelled", "rejected": effect == "none",
                "receipt": ["effect": effect, "dispatchedEvents": events,
                            "reason": ["code": failure.code, "message": failure.message],
                            "recovery": failure.code == "session-closed" ? "reconnect" : "observe"]]
    }
    func progress(_ phase: String, point: CGPoint? = nil, to: CGPoint? = nil, target: CGRect? = nil) {
        guard operation["visual_feedback"] as? Bool == true else { return }
        let tool = operation["tool"] as? String ?? ""
        var value: JSONObject = ["type": "gesture", "phase": phase,
            "mechanism": ["type_text", "press_key"].contains(tool) ? "keyboard" : ["set_value", "perform_secondary_action"].contains(tool) || operation["click_method"] as? String == "accessibility" ? "semantic" : "pointer"]
        if let point { value["point"] = ["x": point.x, "y": point.y] }
        if let to { value["to"] = ["x": to.x, "y": to.y] }
        if let target { value["target"] = rectJSON(target) }
        writeResponse(id, value)
    }
}

final class DriverLifecycle {
    static let shared = DriverLifecycle()
    private let lock = NSLock()
    private var stopped = false
    var stopping: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func stop() { lock.lock(); stopped = true; lock.unlock() }
}

let outputLock = NSLock()
func writeResponse(_ id: String?, _ response: JSONObject) {
    var payload = response
    payload["id"] = (id as Any?) ?? NSNull()
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func rectJSON(_ rect: CGRect) -> JSONObject { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
func rectFromJSON(_ value: Any?) -> CGRect? {
    guard let value = value as? JSONObject, let x = value["x"] as? Double, let y = value["y"] as? Double,
          let width = value["width"] as? Double, let height = value["height"] as? Double,
          [x, y, width, height].allSatisfy({ $0.isFinite }), width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}
func axValue(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, name as CFString, &result) == .success ? result : nil
}
func axString(_ node: AXUIElement, _ name: String) -> String { axValue(node, name) as? String ?? "" }
func axChildren(_ node: AXUIElement, _ name: String = kAXChildrenAttribute) -> [AXUIElement] { axValue(node, name) as? [AXUIElement] ?? [] }
func axFrame(_ node: AXUIElement) -> CGRect? {
    guard let p = axValue(node, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = axValue(node, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func axActions(_ node: AXUIElement) -> [String] {
    var actions: CFArray?
    return AXUIElementCopyActionNames(node, &actions) == .success ? actions as? [String] ?? [] : []
}
func requireAccessibility() throws {
    guard AXIsProcessTrusted() else { throw DriverFailure(code: "input-rejected", message: "Allow Varin Computer in macOS Accessibility settings") }
}

func displayScale(_ bounds: CGRect) -> CGFloat {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &displays, &count)
        let display = displays.first { CGDisplayBounds($0).contains(CGPoint(x: bounds.midX, y: bounds.midY)) } ?? CGMainDisplayID()
        let width = CGDisplayBounds(display).width
        return width > 0 ? CGFloat(CGDisplayPixelsWide(display)) / width : 1
}

struct WindowTarget {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let name: String
    let bounds: CGRect
    let scale: CGFloat
    var descriptor: JSONObject { ["handle": id, "title": title, "bounds": rectJSON(bounds), "visible": true] }
    func axWindow() throws -> AXUIElement {
        try requireAccessibility()
        let app = AXUIElementCreateApplication(pid)
        let matches = axChildren(app, kAXWindowsAttribute).filter { window in
            guard let frame = axFrame(window) else { return false }
            return abs(frame.minX - bounds.minX) < 1 && abs(frame.minY - bounds.minY) < 1 &&
                abs(frame.width - bounds.width) < 1 && abs(frame.height - bounds.height) < 1
        }
        let selected = matches.count == 1 ? matches : matches.filter { !title.isEmpty && axString($0, kAXTitleAttribute) == title }
        guard selected.count == 1 else { throw DriverFailure(code: "target-unavailable", message: "The accessibility window cannot be uniquely matched to the captured window") }
        return selected[0]
    }
    func validate() throws {
        guard let current = allWindows().first(where: { $0.id == id && $0.pid == pid }) else {
            throw DriverFailure(code: "target-unavailable", message: "The selected window is no longer available")
        }
        guard current.bounds == bounds, current.scale == scale else {
            throw DriverFailure(code: "target-changed", message: "The selected window geometry changed; observe again")
        }
    }
    func ownsPoint(_ point: CGPoint) throws {
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [JSONObject] ?? []
        for row in rows {
            guard (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  (row[kCGWindowLayer as String] as? Int ?? -1) >= 0,
                  let dictionary = row[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary), rect.contains(point) else { continue }
            guard row[kCGWindowNumber as String] as? UInt32 == id else {
                throw DriverFailure(code: "target-changed", message: "Another window covers the input point; observe again")
            }
            return
        }
        throw DriverFailure(code: "target-unavailable", message: "The selected window does not own the input point")
    }
    func activate() throws {
        try requireAccessibility()
        let window = try axWindow()
        guard let app = NSRunningApplication(processIdentifier: pid), app.activate(options: [.activateIgnoringOtherApps]) else {
            throw DriverFailure(code: "focus-changed", message: "The selected application did not accept activation")
        }
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
            throw DriverFailure(code: "focus-changed", message: "The selected window could not be raised")
        }
        try focusMatches()
    }
    func focusMatches() throws {
        try validate()
        let app = AXUIElementCreateApplication(pid)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let focused = axValue(app, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
              CFEqual(focused, try axWindow()) else {
            throw DriverFailure(code: "focus-changed", message: "Focus left the selected window; the remaining input was stopped")
        }
    }
}

func allWindows() -> [WindowTarget] {
    guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [JSONObject] else { return [] }
    return rows.compactMap { row in
        guard (row[kCGWindowLayer as String] as? Int) == 0,
              let id = row[kCGWindowNumber as String] as? UInt32,
              let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let dictionary = row[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), bounds.width > 0, bounds.height > 0,
              pid != ProcessInfo.processInfo.processIdentifier else { return nil }
        return WindowTarget(id: id, pid: pid, title: row[kCGWindowName as String] as? String ?? "",
            name: row[kCGWindowOwnerName as String] as? String ?? "", bounds: bounds, scale: displayScale(bounds))
    }
}
func resolveTarget(_ operation: JSONObject) throws -> WindowTarget {
    let selector = (operation["app"] as? String ?? "").lowercased()
    let all = allWindows()
    let exact = all.filter { String($0.pid) == selector || $0.name.lowercased() == selector }
    var candidates = exact.isEmpty ? all.filter { $0.title.lowercased() == selector } : exact
    if selector.isEmpty { candidates = all.filter { $0.pid == NSWorkspace.shared.frontmostApplication?.processIdentifier } }
    if let id = operation["window"] as? UInt32 { candidates = candidates.filter { $0.id == id } }
    else if let title = operation["window"] as? String { candidates = candidates.filter { $0.title == title } }
    if candidates.count > 1, operation["window"] == nil, let focused = axValue(AXUIElementCreateApplication(candidates[0].pid), kAXFocusedWindowAttribute),
       CFGetTypeID(focused) == AXUIElementGetTypeID(), let frame = axFrame(focused as! AXUIElement) {
        candidates = candidates.filter { $0.bounds == frame }
    }
    guard candidates.count == 1 else { throw DriverFailure(code: "target-unavailable", message: candidates.isEmpty ? "The selected application window is unavailable" : "Choose an exact window handle from list_apps") }
    return candidates[0]
}

// System keyboard layout supplies printable shortcut key codes. Named navigation
// and modifier keys use their platform virtual-key constants.
func keyCode(_ name: String) throws -> CGKeyCode {
    let names: [String: CGKeyCode] = ["enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51,
        "escape": 53, "esc": 53, "cmd": 55, "command": 55, "meta": 55, "shift": 56, "alt": 58,
        "option": 58, "ctrl": 59, "control": 59, "delete": 117, "home": 115, "end": 119,
        "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
        "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
    if let code = names[name.lowercased()] { return code }
    guard name.count == 1, let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
        throw DriverFailure(code: "unsupported", message: "This key is unavailable in the current keyboard layout")
    }
    let data = unsafeBitCast(pointer, to: CFData.self)
    guard let bytes = CFDataGetBytePtr(data) else { throw DriverFailure(code: "unsupported", message: "The keyboard layout has no Unicode mapping") }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    for code in UInt16(0)..<UInt16(128) {
        var dead: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 8)
        let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
            OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
        if status == noErr && String(utf16CodeUnits: chars, count: length).lowercased() == name.lowercased() { return code }
    }
    throw DriverFailure(code: "unsupported", message: "This key is unavailable in the current keyboard layout")
}
