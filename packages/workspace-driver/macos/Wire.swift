// Private executor connection to the original Rust workspace Session.
import Foundation
import Darwin

enum WireError: Error { case malformed }
final class Channel {
    let fd: Int32
    let maxFrame: Int
    init(manifest: [String: Any], role: String) throws {
        guard let path = manifest["socket"] as? String, let maximum = manifest["maxFrameBytes"] as? Int else { throw WireError.malformed }
        maxFrame = maximum
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EMFILE) }
        do {
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.utf8) + [0]
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            var yes: Int32 = 1
            guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) == 0 else { throw POSIXError(.EIO) }
            _ = try call(["op":"attach", "version":1, "role":role, "token":manifest["token"] ?? "", "generation":manifest["generation"] ?? ""])
        } catch { Darwin.close(fd); throw error }
    }
    deinit { Darwin.close(fd) }
    private func send(_ bytes: Data) throws {
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), bytes.count-offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw POSIXError(.ENOTCONN) }
                offset += count
            }
        }
    }
    private func receive(_ size: Int) throws -> Data {
        var bytes = Data(count: size)
        try bytes.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < size {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), size-offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw POSIXError(.ENOTCONN) }
                offset += count
            }
        }
        return bytes
    }
    func call(_ request: [String: Any], body: Data = Data()) throws -> (Any, Data) {
        let json = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
        guard json.count <= maxFrame, body.count <= Int(UInt32.max) else { throw POSIXError(.E2BIG) }
        var header = Data()
        for size in [json.count,body.count] { var v = UInt32(size).littleEndian; withUnsafeBytes(of: &v) {header.append(contentsOf:$0)} }
        try send(header); try send(json); try send(body)
        let lengths = [UInt8](try receive(8))
        func length(_ start: Int) -> Int { (0..<4).reduce(0) { $0 | (Int(lengths[start+$1]) << (8*$1)) } }
        let a = length(0), b = length(4)
        guard a > 0, a <= maxFrame else { throw WireError.malformed }
        guard let reply = try JSONSerialization.jsonObject(with: receive(a)) as? [String: Any] else { throw WireError.malformed }
        let bytes = try receive(b)
        if let code = reply["errno"] as? Int32 { throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
        return (reply["value"] ?? NSNull(),bytes)
    }
}
final class WorkspaceConnection {
    let manifest: [String: Any]
    private var control: Channel?
    private var idle: [Channel] = []
    private let lock = NSLock()
    private var closed = false
    init(resource: URL) throws {
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: resource.appendingPathComponent("resource.json"))) as? [String: Any],
              value["protocol"] as? Int == 1 else { throw WireError.malformed }
        manifest = value
        control = try Channel(manifest: value,role: "control")
    }
    func call(_ op: String, _ fields: [String: Any] = [:], body: Data = Data()) throws -> (Any, Data) {
        lock.lock(); let stopped = closed; let saved = idle.popLast(); lock.unlock()
        guard !stopped else { throw POSIXError(.ENOTCONN) }
        let channel = try saved ?? Channel(manifest: manifest,role: "worker")
        var request = fields; request["op"] = op
        // A lost mutation reply is an error; never replay a native write.
        let reply = try channel.call(request,body: body)
        lock.lock(); if !closed { idle.append(channel) }; lock.unlock()
        return reply
    }
    func close() { lock.lock(); closed = true; idle.removeAll(); control = nil; lock.unlock() }
    deinit { close() }
}
