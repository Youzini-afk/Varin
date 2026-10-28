import Foundation
import FSKit

@main struct WorkspaceExtension: UnaryFileSystemExtension {
    typealias FileSystem = FSUnaryFileSystem & FSUnaryFileSystemOperations
    var fileSystem: FSUnaryFileSystem & FSUnaryFileSystemOperations { WorkspaceFileSystem() }
}
final class WorkspaceFileSystem: FSUnaryFileSystem, FSUnaryFileSystemOperations {
    private var resource: FSPathURLResource?
    private var volume: WorkspaceVolume?
    func loadResource(resource:FSResource,options:FSTaskOptions,replyHandler:@escaping(FSVolume?,Error?)->Void) {
        guard let path = resource as? FSPathURLResource else {replyHandler(nil,POSIXError(.EINVAL));return}
        guard !options.taskOptions.contains(where:{$0 == "-f"}) else {replyHandler(nil,POSIXError(.ENOTSUP));return}
        guard path.url.startAccessingSecurityScopedResource() else {replyHandler(nil,POSIXError(.EACCES));return}
        do {let volume=try WorkspaceVolume(resource:path.url);self.volume=volume;self.resource=path;containerStatus = .ready;replyHandler(volume,nil)}
        catch {path.url.stopAccessingSecurityScopedResource();replyHandler(nil,error)}
    }
    func unloadResource(resource:FSResource,options:FSTaskOptions,replyHandler:@escaping(Error?)->Void) {
        guard let path=resource as? FSPathURLResource,let loaded=self.resource,loaded.url==path.url else {replyHandler(POSIXError(.EINVAL));return}
        volume?.connection.close();volume=nil;loaded.url.stopAccessingSecurityScopedResource();self.resource=nil;replyHandler(nil)
    }
    func probeResource(resource:FSResource,replyHandler:@escaping(FSProbeResult?,Error?)->Void) {
        guard let path=resource as? FSPathURLResource,path.url.startAccessingSecurityScopedResource() else {replyHandler(nil,POSIXError(.EACCES));return}
        defer {path.url.stopAccessingSecurityScopedResource()}
        do {guard let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:path.url.appendingPathComponent("resource.json"))) as? [String:Any],manifest["protocol"] as? Int==1,
                  let generation=manifest["generation"] as? String,let uuid=UUID(uuidString:generation) else {throw WireError.malformed}
            replyHandler(.usable(name:"Varin Workspace",containerID:FSContainerIdentifier(uuid:uuid)),nil)
        }catch{replyHandler(nil,error)}
    }
}
