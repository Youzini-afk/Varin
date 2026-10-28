import Foundation
import FSKit
import Darwin

final class WorkspaceItem: FSItem {
    let id: UInt64
    var cookies: [UInt64: String] = [:]
    var names: [String: UInt64] = [:]
    var nextCookie: UInt64 = 1
    var verifier: String?
    let enumeration = NSLock()
    init(_ id: UInt64) { self.id = id; super.init() }
}
final class WorkspaceVolume: FSVolume, FSVolume.Operations, FSVolume.ReadWriteOperations,
    FSVolume.OpenCloseOperations, FSVolume.PathConfOperations, FSVolume.XattrOperations {
    let connection: WorkspaceConnection
    private let lock = NSLock()
    private var items: [UInt64: WorkspaceItem] = [:]
    private let root: WorkspaceItem
    init(resource: URL) throws {
        connection = try WorkspaceConnection(resource: resource)
        guard let record = try connection.call("root").0 as? [String: Any], let id = record["id"] as? UInt64 else { throw WireError.malformed }
        root = WorkspaceItem(id)
        items[id] = root
        guard let generation = connection.manifest["generation"] as? String, let uuid = UUID(uuidString:generation) else { throw WireError.malformed }
        super.init(volumeID: FSVolume.Identifier(uuid:uuid),volumeName:FSFileName(string:"Varin Workspace"))
    }
    func item(_ record: [String: Any]) throws -> WorkspaceItem {
        guard let id = record["id"] as? UInt64 else { throw WireError.malformed }
        lock.lock(); defer {lock.unlock()}
        if let item = items[id] { return item }
        let item = WorkspaceItem(id); items[id] = item; return item
    }
    func id(_ item: FSItem) throws -> UInt64 { guard let item = item as? WorkspaceItem else {throw POSIXError(.ESTALE)}; return item.id }
    func name(_ value: FSFileName) throws -> String { guard let name = value.string else {throw POSIXError(.EILSEQ)}; return name }
    func record(_ op: String, _ fields: [String: Any]) throws -> [String: Any] {
        guard let result = try connection.call(op,fields).0 as? [String: Any] else {throw WireError.malformed}; return result
    }
    func type(_ record: [String: Any]) -> FSItem.ItemType { switch record["kind"] as? String {case "directory":return .directory; case "symlink":return .symlink; default:return .file} }
    func attributes(_ record: [String: Any]) throws -> FSItem.Attributes {
        let value = FSItem.Attributes()
        func uint(_ name: String) throws -> UInt64 {guard let n = record[name] as? UInt64 else {throw WireError.malformed}; return n}
        value.fileID = FSItem.Identifier(rawValue:try uint("id")) ?? .invalid
        value.parentID = FSItem.Identifier(rawValue:try uint("parent")) ?? .invalid
        value.type = type(record); value.size = try uint("size"); value.allocSize = value.size
        value.mode = UInt32(try uint("mode")); value.uid = UInt32(try uint("uid")); value.gid = UInt32(try uint("gid"))
        value.flags = UInt32(try uint("flags")); value.linkCount = UInt32(try uint("links"))
        func time(_ key: String) -> timespec {let t = record[key] as? [String: Any] ?? [:]; return timespec(tv_sec:t["seconds"] as? Int ?? 0,tv_nsec:t["nanos"] as? Int ?? 0)}
        value.accessTime = time("accessed"); value.modifyTime = time("modified"); value.changeTime = time("changed")
        value.birthTime = time("created"); value.addedTime = value.birthTime; value.backupTime = time("backup")
        return value
    }
    func changes(_ value: FSItem.SetAttributesRequest) -> [String: Any] {
        var result: [String: Any] = [:]
        if value.isValid(.size) {result["size"] = value.size}
        if value.isValid(.mode) {result["mode"] = value.mode}
        if value.isValid(.uid) {result["uid"] = value.uid}
        if value.isValid(.gid) {result["gid"] = value.gid}
        if value.isValid(.flags) {result["flags"] = value.flags}
        func time(_ key: String,_ t: timespec) {result[key] = ["seconds":t.tv_sec,"nanos":t.tv_nsec]}
        if value.isValid(.accessTime) {time("accessed",value.accessTime)}
        if value.isValid(.modifyTime) {time("modified",value.modifyTime)}
        if value.isValid(.changeTime) {time("changed",value.changeTime)}
        if value.isValid(.birthTime) {time("created",value.birthTime)}
        if value.isValid(.backupTime) {time("backup",value.backupTime)}
        return result
    }
    func activate(options:FSTaskOptions,replyHandler:@escaping(FSItem?,Error?)->Void) { replyHandler(root,nil) }
    func deactivate(options:FSDeactivateOptions = [],replyHandler:@escaping(Error?)->Void) { connection.close(); replyHandler(nil) }
    func mount(options:FSTaskOptions,replyHandler:@escaping(Error?)->Void) { replyHandler(nil) }
    func unmount(replyHandler:@escaping()->Void) {connection.close(); replyHandler()}
    func synchronize(flags:FSSyncFlags,replyHandler:@escaping(Error?)->Void) {do {_ = try connection.call("sync"); replyHandler(nil)}catch{replyHandler(error)}}
    var volumeStatistics: FSStatFSResult {
        let value = FSStatFSResult(fileSystemTypeName:"varin")
        value.blockSize = 4096; value.ioSize = 65536
        if let stats = try? record("statfs",[:]), let total = stats["total"] as? UInt64, let free = stats["free"] as? UInt64 {
            value.totalBlocks = total/4096; value.freeBlocks = free/4096; value.availableBlocks = free/4096; value.usedBlocks = (total-free)/4096
        }
        return value
    }
    func getAttributes(_ desired:FSItem.GetAttributesRequest,of item:FSItem,replyHandler:@escaping(FSItem.Attributes?,Error?)->Void) {
        do {replyHandler(try attributes(record("getattr",["id":id(item)])),nil)}catch{replyHandler(nil,error)}
    }
    func setAttributes(_ value:FSItem.SetAttributesRequest,on item:FSItem,replyHandler:@escaping(FSItem.Attributes?,Error?)->Void) {
        do {replyHandler(try attributes(record("setattr",["id":id(item),"attributes":changes(value)])),nil)}catch{replyHandler(nil,error)}
    }
    func lookupItem(named name:FSFileName,inDirectory directory:FSItem,replyHandler:@escaping(FSItem?,FSFileName?,Error?)->Void) {
        do {replyHandler(try item(record("lookup",["parent":id(directory),"name":self.name(name)])),name,nil)}catch{replyHandler(nil,nil,error)}
    }
    func reclaimItem(_ item:FSItem,replyHandler:@escaping(Error?)->Void) {
        do {let key = try id(item); _ = try connection.call("reclaim",["id":key]); lock.lock(); items.removeValue(forKey:key); lock.unlock(); replyHandler(nil)}catch{replyHandler(error)}
    }
    func readSymbolicLink(_ item:FSItem,replyHandler:@escaping(FSFileName?,Error?)->Void) {
        do {guard let target = try connection.call("readlink",["id":id(item)]).0 as? String else {throw WireError.malformed}; replyHandler(FSFileName(string:target),nil)}catch{replyHandler(nil,error)}
    }
    private func create(_ name:FSFileName,_ directory:FSItem,_ attributes:FSItem.SetAttributesRequest,_ kind:String,_ target:String?,_ reply:@escaping(FSItem?,FSFileName?,Error?)->Void) {
        do {var fields:[String:Any] = ["parent":try id(directory),"name":try self.name(name),"kind":kind,"attributes":changes(attributes)]; if let target = target {fields["target"]=target}
            reply(try item(record("create",fields)),name,nil)}catch{reply(nil,nil,error)}
    }
    func createItem(named name:FSFileName,type:FSItem.ItemType,inDirectory directory:FSItem,attributes:FSItem.SetAttributesRequest,replyHandler:@escaping(FSItem?,FSFileName?,Error?)->Void) {
        guard type == .file || type == .directory else {replyHandler(nil,nil,POSIXError(.ENOTSUP));return}
        create(name,directory,attributes,type == .directory ? "directory":"file",nil,replyHandler)
    }
    func createSymbolicLink(named name:FSFileName,inDirectory directory:FSItem,attributes:FSItem.SetAttributesRequest,linkContents:FSFileName,replyHandler:@escaping(FSItem?,FSFileName?,Error?)->Void) {
        do {create(name,directory,attributes,"symlink",try self.name(linkContents),replyHandler)}catch{replyHandler(nil,nil,error)}
    }
    func createLink(to item:FSItem,named name:FSFileName,inDirectory directory:FSItem,replyHandler:@escaping(FSFileName?,Error?)->Void) {
        do {_ = try connection.call("link",["id":id(item),"parent":id(directory),"name":self.name(name)]); replyHandler(name,nil)}catch{replyHandler(nil,error)}
    }
    func removeItem(_ item:FSItem,named name:FSFileName,fromDirectory directory:FSItem,replyHandler:@escaping(Error?)->Void) {
        do {_ = try connection.call("remove",["id":id(item),"parent":id(directory),"name":self.name(name)]); replyHandler(nil)}catch{replyHandler(error)}
    }
    func renameItem(_ item:FSItem,inDirectory source:FSItem,named sourceName:FSFileName,to destinationName:FSFileName,inDirectory destination:FSItem,overItem:FSItem?,replyHandler:@escaping(FSFileName?,Error?)->Void) {
        do {_ = try connection.call("rename",["id":id(item),"parent":id(source),"name":name(sourceName),"toParent":id(destination),"toName":name(destinationName),"replace":overItem != nil]);replyHandler(destinationName,nil)}catch{replyHandler(nil,error)}
    }
    func enumerateDirectory(_ directory:FSItem,startingAt cookie:FSDirectoryCookie,verifier:FSDirectoryVerifier,attributes:FSItem.GetAttributesRequest?,packer:FSDirectoryEntryPacker,replyHandler:@escaping(FSDirectoryVerifier,Error?)->Void) {
        guard let directory = directory as? WorkspaceItem else {replyHandler(verifier,POSIXError(.ESTALE));return}
        directory.enumeration.lock(); defer {directory.enumeration.unlock()}
        do {
            var after:String? = cookie.rawValue == 0 ? nil : directory.cookies[cookie.rawValue]
            var observedRevision:String?
            if cookie.rawValue != 0 && after == nil {throw POSIXError(.ESTALE)}
            while true {
                var fields:[String:Any] = ["id":directory.id]; if let after = after {fields["after"]=after}
                let page = try record("directory",fields)
                guard let revision = page["revision"] as? String, let entries = page["entries"] as? [[String:Any]] else {throw WireError.malformed}
                if let observed = observedRevision, observed != revision {throw POSIXError(.ESTALE)}
                observedRevision=revision
                if cookie.rawValue != 0 && directory.verifier != revision {throw POSIXError(.ESTALE)}
                if cookie.rawValue == 0 && directory.verifier != revision {directory.cookies.removeAll();directory.names.removeAll();directory.verifier=revision}
                for entry in entries {
                    guard let name = entry["name"] as? String, let record = entry["attributes"] as? [String:Any] else {throw WireError.malformed}
                    guard let child = record["id"] as? UInt64 else {throw WireError.malformed}
                    let next = directory.names[name] ?? directory.nextCookie
                    guard next < UInt64.max else {throw POSIXError(.EOVERFLOW)}
                    if !packer.packEntry(name:FSFileName(string:name),itemType:type(record),itemID:FSItem.Identifier(rawValue:child) ?? .invalid,nextCookie:FSDirectoryCookie(next),attributes:attributes == nil ? nil : try self.attributes(record)) {
                        replyHandler(FSDirectoryVerifier(1),nil);return
                    }
                    directory.cookies[next]=name
                    if directory.names[name] == nil {directory.names[name]=next;directory.nextCookie+=1}
                    after=name
                }
                if page["next"] is NSNull || entries.isEmpty {break}
            }
            replyHandler(FSDirectoryVerifier(1),nil)
        }catch{replyHandler(verifier,error)}
    }
    func read(from item:FSItem,at offset:off_t,length:Int,into buffer:FSMutableFileDataBuffer,replyHandler:@escaping(Int,Error?)->Void) {
        var count=0
        do {guard offset>=0 && length>=0 else {throw POSIXError(.EINVAL)}
            try buffer.withUnsafeMutableBytes { pointer in
                guard length<=pointer.count else {throw POSIXError(.EINVAL)}
                while count<length {let size=min(length-count,65536);let position=offset.addingReportingOverflow(Int64(count));guard !position.overflow else {throw POSIXError(.EFBIG)}
                    let data=try connection.call("read",["id":id(item),"offset":position.partialValue,"length":size]).1
                    data.withUnsafeBytes {if let p=$0.baseAddress {pointer.baseAddress!.advanced(by:count).copyMemory(from:p,byteCount:data.count)}}
                    count+=data.count;if data.count<size {break}
                }
            };replyHandler(count,nil)
        }catch{replyHandler(count,error)}
    }
    func write(contents:Data,to item:FSItem,at offset:off_t,replyHandler:@escaping(Int,Error?)->Void) {
        var count=0
        do {guard offset>=0 else {throw POSIXError(.EINVAL)}
            while count<contents.count {let end=count+min(contents.count-count,65536);let position=offset.addingReportingOverflow(Int64(count));guard !position.overflow else {throw POSIXError(.EFBIG)}
                let reply=try connection.call("write",["id":id(item),"offset":position.partialValue],body:contents.subdata(in:count..<end)).0
                guard let wrote=reply as? Int,wrote>0,wrote<=end-count else {throw POSIXError(.EIO)};count+=wrote
            };replyHandler(count,nil)
        }catch{replyHandler(count,error)}
    }
    func openItem(_ item:FSItem,modes:FSVolume.OpenModes,replyHandler:@escaping(Error?)->Void) {do {_ = try connection.call("open",["id":id(item)]);replyHandler(nil)}catch{replyHandler(error)}}
    func closeItem(_ item:FSItem,modes:FSVolume.OpenModes,replyHandler:@escaping(Error?)->Void) {do {_ = try connection.call("close",["id":id(item),"keepOpen":!modes.isEmpty]);replyHandler(nil)}catch{replyHandler(error)}}
    func getXattr(named name:FSFileName,of item:FSItem,replyHandler:@escaping(Data?,Error?)->Void) {do {replyHandler(try connection.call("getxattr",["id":id(item),"name":self.name(name)]).1,nil)}catch{replyHandler(nil,error)}}
    func listXattrs(of item:FSItem,replyHandler:@escaping([FSFileName]?,Error?)->Void) {
        do {guard let names=try connection.call("listxattrs",["id":id(item)]).0 as? [String] else {throw WireError.malformed};replyHandler(names.map{FSFileName(string:$0)},nil)}catch{replyHandler(nil,error)}
    }
    func setXattr(named name:FSFileName,to data:Data?,on item:FSItem,policy:FSVolume.SetXattrPolicy,replyHandler:@escaping(Error?)->Void) {
        do {let action:String;switch policy {case .alwaysSet:action="set";case .mustCreate:action="create";case .mustReplace:action="replace";case .delete:action="remove";@unknown default:throw POSIXError(.ENOTSUP)}
            _ = try connection.call("setxattr",["id":id(item),"name":self.name(name),"policy":action],body:data ?? Data());replyHandler(nil)
        }catch{replyHandler(error)}
    }
    var maximumLinkCount:Int {Int(UInt32.max)}
    var maximumNameLength:Int {255}
    var restrictsOwnershipChanges:Bool {true}
    var truncatesLongNames:Bool {false}
    var maximumFileSizeInBits:Int {64}
    var maximumXattrSizeInBits:Int {32}
    var supportedVolumeCapabilities:FSVolume.SupportedCapabilities {
        let value=FSVolume.SupportedCapabilities()
        value.supportsSymbolicLinks=true;value.supportsHardLinks=true;value.supportsHiddenFiles=true
        value.supportsSparseFiles=true;value.supportsZeroRuns=true;value.supportsFastStatFS=true
        value.supports2TBFiles=true;value.supports64BitObjectIDs=true;value.caseFormat = .sensitive
        return value
    }
}
