// Read-only native OS locations and LaunchServices observations. Never registers
// an app, changes a default handler, opens a URL, or reads profile contents.
import AppKit
import CoreServices
import Darwin
import Foundation

func fail() -> Never { exit(2) }
guard getuid() != 0, let account = getpwuid(getuid()), let homePointer = account.pointee.pw_dir,
      let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { fail() }
let home = String(cString: homePointer)
let identifier = "dev.varin.desktop"
var error: Unmanaged<CFError>?
let applications: [URL]
if let result = LSCopyApplicationURLsForBundleIdentifier(identifier as CFString, &error) {
    applications = result.takeRetainedValue() as! [URL]
    if error != nil { fail() }
} else {
    // Absence and a failed/unavailable LaunchServices lookup are not equivalent.
    guard let failure = error?.takeRetainedValue(),
          CFErrorGetDomain(failure) as String == NSOSStatusErrorDomain,
          CFErrorGetCode(failure) == Int(kLSApplicationNotFoundErr) else { fail() }
    applications = []
}
let handler = LSCopyDefaultHandlerForURLScheme("varin" as CFString)?.takeRetainedValue() as String?
let running = NSWorkspace.shared.runningApplications.filter {
    $0.bundleIdentifier == identifier || $0.bundleIdentifier?.hasPrefix(identifier + ".") == true
}.map { $0.bundleURL?.path ?? $0.bundleIdentifier ?? "unknown" }
let result: [String: Any] = [
    "schema": 1, "home": home, "applicationSupport": support.path,
    "registeredApplications": applications.map { $0.path },
    "schemeHandler": handler as Any? ?? NSNull(), "runningApplications": running,
]
guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { fail() }
FileHandle.standardOutput.write(data)
