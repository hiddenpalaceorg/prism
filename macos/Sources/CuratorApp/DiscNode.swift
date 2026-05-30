import Foundation
import CuratorKit

/// UI wrapper over the FFI `FileNode`: identifiable + an optional `children` so it
/// drops straight into SwiftUI's `OutlineGroup`.
struct DiscNode: Identifiable, Hashable {
    let id = UUID()
    let node: FileNode
    let children: [DiscNode]?

    init(_ node: FileNode) {
        self.node = node
        self.children = node.isDir ? node.children.map(DiscNode.init) : nil
    }

    var name: String { node.name }
    var isDir: Bool { node.isDir }

    static func == (lhs: DiscNode, rhs: DiscNode) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    /// Flatten into an id → node map for selection lookup.
    func index(into map: inout [UUID: DiscNode]) {
        map[id] = self
        children?.forEach { $0.index(into: &map) }
    }
}

func humanSize(_ bytes: UInt64?) -> String {
    guard let bytes else { return "—" }
    let units = ["B", "KB", "MB", "GB", "TB"]
    var value = Double(bytes)
    var i = 0
    while value >= 1024 && i < units.count - 1 {
        value /= 1024
        i += 1
    }
    return i == 0 ? "\(bytes) B" : String(format: "%.1f %@", value, units[i])
}
