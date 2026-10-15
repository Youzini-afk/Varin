import AppKit
import Foundation

// A stable bundle owns TCC identity. Warmup starts no capture, focus or input.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let driver = DesktopDriver()
let inputQueue = DispatchQueue(label: "com.varin.computer.input")
let captureQueue = DispatchQueue(label: "com.varin.computer.capture.requests")
let work = DispatchGroup()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let operation = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject,
              let id = operation["id"] as? String, !id.isEmpty else {
            writeResponse(nil, ["ok": false, "error": "Invalid desktop request"]); continue
        }
        let context = RequestContext(operation)
        let isCapture = operation["tool"] as? String == "capture_frame"
        work.enter()
        (isCapture ? captureQueue : inputQueue).async {
            defer { work.leave() }
            var response: JSONObject
            do { response = try driver.perform(context) }
            catch { response = context.failure(error) }
            let tool = operation["tool"] as? String ?? ""
            if !isCapture && (!["ping", "capabilities", "list_apps", "get_app_state", "inject_input"].contains(tool) || response["ok"] as? Bool != true) {
                do { try driver.releaseInput() }
                catch { response = context.failure(DriverFailure(code: "connection-lost", message: "Release of synthetic input was not confirmed", uncertain: true)) }
            }
            writeResponse(id, response)
        }
    }
    DriverLifecycle.shared.stop()
    work.wait()
    try? driver.releaseInput()
    driver.capture.close()
    DispatchQueue.main.async { application.terminate(nil) }
}
application.run()
