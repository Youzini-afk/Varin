import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

struct CapturedFrame {
    let png: Data
    let width: Int
    let height: Int
    let at: String
    let sessionID: String
    func json(bounds: CGRect) -> JSONObject { ["mime": "image/png", "base64": png.base64EncodedString(), "bounds": rectJSON(bounds), "capturedAt": at] }
}

final class CaptureStream: NSObject, SCStreamOutput, SCStreamDelegate {
    private let condition = NSCondition()
    private let outputQueue = DispatchQueue(label: "com.varin.computer.capture.frames")
    private let context = CIContext()
    private var current: CapturedFrame?
    private var failure: DriverFailure?
    private var stream: SCStream?
    let identity = UUID().uuidString
    let bounds: CGRect
    let scale: CGFloat
    let window: Bool
    var ended: Bool { condition.lock(); defer { condition.unlock() }; return failure != nil }
    var hasFrame: Bool { condition.lock(); defer { condition.unlock() }; return current != nil && failure == nil }

    init(filter: SCContentFilter, bounds: CGRect, scale: CGFloat, window: Bool) throws {
        self.bounds = bounds; self.scale = scale; self.window = window
        super.init()
        let configuration = SCStreamConfiguration()
        configuration.width = Int((bounds.width * scale).rounded())
        configuration.height = Int((bounds.height * scale).rounded())
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.destinationRect = CGRect(x: 0, y: 0, width: configuration.width, height: configuration.height)
        // The supported macOS 13 path uses stream output for both snapshots and
        // viewers. macOS 14 can suppress window shadows directly; macOS 13 uses
        // the frame's actual contentRect below, never a guessed pixel inset.
        if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        self.stream = stream
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
        let ready = DispatchSemaphore(value: 0)
        var error: Error?
        stream.startCapture { result in error = result; ready.signal() }
        ready.wait()
        if error != nil { throw DriverFailure(code: "session-closed", message: "ScreenCaptureKit could not start the authorized capture") }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        condition.lock()
        failure = DriverFailure(code: "session-closed", message: "The macOS screen capture session ended; observe again")
        current = nil
        condition.broadcast()
        condition.unlock()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let attachment = attachments.first, let rawStatus = attachment[.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus) else { return }
        if status == .idle { return } // The last complete frame is still valid.
        guard status == .complete else {
            condition.lock(); current = nil
            if status == .blank || status == .suspended || status == .stopped {
                failure = DriverFailure(code: "session-closed", message: "The original screen source is unavailable; observe again")
                condition.broadcast()
            }
            condition.unlock(); return
        }
        guard let buffer = sampleBuffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: buffer)
        guard let complete = context.createCGImage(image, from: image.extent) else { return }
        var captured = complete
        if window {
            guard let dictionary = attachment[.contentRect] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary), !rect.isEmpty,
                  CGRect(x: 0, y: 0, width: complete.width, height: complete.height).contains(rect),
                  let cropped = complete.cropping(to: rect) else { return }
            captured = cropped
        }
        guard let png = NSBitmapImageRep(cgImage: captured).representation(using: .png, properties: [:]) else { return }
        let frame = CapturedFrame(png: png, width: captured.width, height: captured.height,
                                  at: ISO8601DateFormatter().string(from: Date()), sessionID: identity)
        condition.lock()
        if failure == nil { current = frame; condition.broadcast() }
        condition.unlock()
    }

    func frame(check: () throws -> Void) throws -> CapturedFrame {
        condition.lock(); defer { condition.unlock() }
        while current == nil && failure == nil {
            _ = condition.wait(until: Date(timeIntervalSinceNow: 0.025))
            try check()
        }
        try check()
        if let failure { throw failure }
        return current!
    }

    func close() {
        condition.lock()
        failure = DriverFailure(code: "session-closed", message: "The screen capture session was closed")
        current = nil; condition.broadcast(); condition.unlock()
        if let stream {
            let stopped = DispatchSemaphore(value: 0)
            stream.stopCapture { _ in stopped.signal() }
            stopped.wait()
            self.stream = nil
        }
    }
}

final class CaptureOwner {
    private let lock = NSLock()
    private var sessions: [String: CaptureStream] = [:]
    private var prompted = false

    private func acquire(_ check: () throws -> Void) throws {
        while !lock.lock(before: Date(timeIntervalSinceNow: 0.025)) { try check() }
        do { try check() } catch { lock.unlock(); throw error }
    }

    private func content() throws -> SCShareableContent {
        if !CGPreflightScreenCaptureAccess() {
            if !prompted { prompted = true; _ = CGRequestScreenCaptureAccess() }
            guard CGPreflightScreenCaptureAccess() else {
                throw DriverFailure(code: "input-rejected", message: "Allow Varin Computer in macOS Screen Recording settings")
            }
        }
        let done = DispatchSemaphore(value: 0)
        var result: SCShareableContent?
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, _ in result = content; done.signal() }
        done.wait()
        guard let result else { throw DriverFailure(code: "session-closed", message: "ScreenCaptureKit could not enumerate the authorized screen sources") }
        return result
    }

    func window(_ target: WindowTarget, check: () throws -> Void) throws -> CapturedFrame {
        try target.validate(); try check()
        let key = "window:\(target.pid):\(target.id)"
        try acquire(check)
        let session: CaptureStream
        do {
            if let existing = sessions[key], existing.bounds == target.bounds, existing.scale == target.scale, !existing.ended {
                session = existing
            } else {
                sessions.removeValue(forKey: key)?.close()
                let available = try content()
                guard let window = available.windows.first(where: { $0.windowID == target.id && $0.owningApplication?.processID == target.pid }) else {
                    throw DriverFailure(code: "target-unavailable", message: "ScreenCaptureKit cannot find the selected window")
                }
                session = try CaptureStream(filter: SCContentFilter(desktopIndependentWindow: window), bounds: target.bounds, scale: target.scale, window: true)
                sessions[key] = session
            }
            lock.unlock()
        } catch { lock.unlock(); throw error }
        let frame = try session.frame(check: check)
        try target.validate(); try check()
        return frame
    }

    func desktop(renew: Bool = false, check: () throws -> Void) throws -> (CapturedFrame, CGRect) {
        try acquire(check)
        let display = CGMainDisplayID(), bounds = CGDisplayBounds(display)
        let scale = CGFloat(CGDisplayPixelsWide(display)) / bounds.width
        let key = "display:\(display)"
        let session: CaptureStream
        do {
            if renew, let existing = sessions[key], existing.ended || existing.bounds != bounds || existing.scale != scale {
                sessions.removeValue(forKey: key)?.close()
            }
            if let existing = sessions[key] {
                // Viewer polls do not restart a revoked session. An explicit
                // observation may renew it, without silently replacing targets.
                guard existing.bounds == bounds && existing.scale == scale else {
                    throw DriverFailure(code: "target-changed", message: "Display geometry changed; observe the desktop again")
                }
                session = existing
            } else {
                let available = try content()
                guard let display = available.displays.first(where: { $0.displayID == display }) else {
                    throw DriverFailure(code: "target-unavailable", message: "The selected display is unavailable")
                }
                session = try CaptureStream(filter: SCContentFilter(display: display, excludingWindows: []), bounds: bounds, scale: scale, window: false)
                sessions[key] = session
            }
            lock.unlock()
        } catch { lock.unlock(); throw error }
        return (try session.frame(check: check), bounds)
    }

    func validateWindow(_ target: WindowTarget, identity: String, check: () throws -> Void) throws {
        try acquire(check); defer { lock.unlock() }
        guard CGPreflightScreenCaptureAccess(), let session = sessions["window:\(target.pid):\(target.id)"], !session.ended, session.hasFrame else {
            throw DriverFailure(code: "session-closed", message: "The original screen capture authorization ended; observe again")
        }
        guard session.identity == identity, session.bounds == target.bounds, session.scale == target.scale else {
            throw DriverFailure(code: "target-changed", message: "The original captured window was replaced; observe again")
        }
    }

    func validateDesktop(_ expected: CGRect? = nil, identity: String? = nil, check: () throws -> Void) throws -> CGRect {
        try acquire(check); defer { lock.unlock() }
        let display = CGMainDisplayID(), bounds = CGDisplayBounds(display)
        guard CGPreflightScreenCaptureAccess(), let session = sessions["display:\(display)"], !session.ended, session.hasFrame else {
            throw DriverFailure(code: "session-closed", message: "Read a current desktop frame before sending input")
        }
        guard (identity == nil || session.identity == identity), session.bounds == bounds, session.scale == CGFloat(CGDisplayPixelsWide(display)) / bounds.width,
              expected == nil || expected == bounds else {
            throw DriverFailure(code: "target-changed", message: "Desktop coordinates changed; observe again")
        }
        return bounds
    }

    func retainWindows(_ windows: [WindowTarget]) {
        let live = Set(windows.map { "window:\($0.pid):\($0.id)" })
        lock.lock()
        let retired = sessions.filter { $0.key.hasPrefix("window:") && !live.contains($0.key) }
        for key in retired.keys { sessions.removeValue(forKey: key) }
        lock.unlock()
        for session in retired.values { session.close() }
    }

    func close() {
        lock.lock(); let old = sessions; sessions.removeAll(); lock.unlock()
        for session in old.values { session.close() }
    }
}
