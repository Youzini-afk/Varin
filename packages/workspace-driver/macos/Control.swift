// Minimum OS remains 13. FSKit is weak-linked and entered only on macOS 26+.
import Foundation
import AppKit
import FSKit

@main struct WorkspaceControl {
    static let moduleID="com.varin.workspace.filesystem"
    static func emit(_ value:[String:Any]) {if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) {FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]))}}
    @available(macOS 26.0, *) static func inspect() {
        FSClient.shared.fetchInstalledExtensions { identities,error in
            if let error=error {emit(["ready":false,"reason":"extension_inspection_failed","detail":error.localizedDescription]);exit(0)}
            let own=identities?.first{$0.bundleIdentifier==moduleID}
            let expected=Bundle.main.bundleURL.appendingPathComponent("Contents/PlugIns/VarinWorkspace.appex").resolvingSymlinksInPath()
            let selected=own?.url.resolvingSymlinksInPath()
            let ready=own?.isEnabled==true && selected==expected
            emit(["ready":ready,"reason":ready ? "ready" : own == nil ? "extension_not_registered" : own?.isEnabled != true ? "extension_disabled" : "extension_generation_changed",
                  "detail":ready ? "Built-in FSKit workspace extension is enabled" : "Open VarinWorkspace.app and enable Varin Workspace in System Settings → General → Login Items & Extensions → File System Extensions",
                  "modulePath":selected?.path ?? "","expectedPath":expected.path]);exit(0)
        }
        RunLoop.main.run()
    }
    static func main() {
        if CommandLine.arguments.contains("--inspect") {
            if #available(macOS 26.0, *) {inspect()}
            else {emit(["ready":false,"reason":"os_unsupported","detail":"The built-in path-backed FSKit extension requires macOS 26 or later"])}
            return
        }
        // Only explicit user launch enters Settings. Inspection never registers,
        // enables extensions, elevates privileges or changes security policy.
        NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.ExtensionsPreferences")!)
    }
}
