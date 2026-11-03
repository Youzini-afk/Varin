// hdiutil plists contain Data (image aliases) that plutil cannot turn into JSON.
// Parse natively and emit only the scalar fields required for owned observations.
import Foundation

func fail() -> Never { exit(2) }
guard CommandLine.arguments.count == 2,
      let value = try? PropertyListSerialization.propertyList(from: FileHandle.standardInput.readDataToEndOfFile(), format: nil),
      let plist = value as? [String: Any] else { fail() }
let result: [String: Any]
switch CommandLine.arguments[1] {
case "images":
    guard let images = plist["images"] as? [[String: Any]] else { fail() }
    result = ["images": images.map { image -> [String: Any] in
        guard let path = image["image-path"] as? String,
              let entities = image["system-entities"] as? [[String: Any]] else { fail() }
        return ["image-path": path, "system-entities": entities.map { entity -> [String: String] in
            var fields: [String: String] = [:]
            for key in ["dev-entry", "mount-point"] {
                if let raw = entity[key] {
                    guard let text = raw as? String else { fail() }
                    fields[key] = text
                }
            }
            return fields
        }]
    }]
case "disk":
    guard let device = plist["DeviceNode"] as? String,
          let mount = plist["MountPoint"] as? String,
          let volumeReadOnly = plist["ReadOnlyVolume"] as? Bool,
          let mediaReadOnly = plist["ReadOnlyMedia"] as? Bool else { fail() }
    result = ["DeviceNode": device, "MountPoint": mount, "ReadOnlyVolume": volumeReadOnly, "ReadOnlyMedia": mediaReadOnly]
case "app":
    guard let identifier = plist["CFBundleIdentifier"] as? String,
          let executable = plist["CFBundleExecutable"] as? String,
          let version = plist["CFBundleShortVersionString"] as? String else { fail() }
    result = ["CFBundleIdentifier": identifier, "CFBundleExecutable": executable, "CFBundleShortVersionString": version]
default: fail()
}
guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { fail() }
FileHandle.standardOutput.write(data)
