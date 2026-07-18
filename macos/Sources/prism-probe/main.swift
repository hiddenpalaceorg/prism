// Headless runtime check for the UniFFI bridge — no GUI session required.
// Exercises: Engine constructor, a library query, the ProgressListener callback
// (image hashing emits real events), cancellation, and error propagation.
//
//   cargo build -p prism-ffi && (cd macos && swift run prism-probe)
import Foundation
import PrismKit

final class PrintListener: ProgressListener, @unchecked Sendable {
    func onBatch(index: UInt64, total: UInt64, name: String) {
        print("  [batch] \(index + 1)/\(total) \(name)")
    }
    func onCounterOpen(id: UInt64, label: String, unit: String, total: Double?) {
        let t = total.map { String(Int($0)) } ?? "?"
        print("  [open #\(id)] \(label) — \(t) \(unit)")
    }
    func onProgress(id: UInt64, count: Double) { /* high-frequency; elided */ }
    func onCounterClose(id: UInt64) { print("  [close #\(id)]") }
    func onMessage(text: String) { print("  [msg] \(text)") }
}

let fm = FileManager.default
let tmp = fm.temporaryDirectory.appendingPathComponent("prism-probe-\(getpid())")
try? fm.createDirectory(at: tmp, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: tmp) }

let dataDir = ProcessInfo.processInfo.environment["PRISM_DATA_DIR"]
    ?? tmp.appendingPathComponent("data").path
let engine = try Engine(adapterDir: "../ps2exe-adapter", adapterBin: nil, dataDir: dataDir)
print("1. librarySize() ->", try engine.librarySize(), "(fresh data dir)")

// 2. Cancellation: pre-trip the handle; hashing must unwind as .cancelled.
let big = tmp.appendingPathComponent("big.bin")
fm.createFile(atPath: big.path, contents: Data(count: 32 * 1024 * 1024))
let cancel = CancelHandle()
cancel.cancel()
do {
    _ = try engine.analyze(path: big.path, listener: PrintListener(), cancel: cancel)
    print("2. cancellation -> FAILED (analyze returned)")
} catch PrismError.Cancelled {
    print("2. cancellation -> .Cancelled")
} catch {
    print("2. cancellation -> unexpected:", error)
}

// 3. Progress + adapter path: a tiny non-disc file. Hashing fires real progress
//    events; the adapter then rejects it (not a disc) → error propagates as Swift throw.
let junk = tmp.appendingPathComponent("not-a-disc.bin")
fm.createFile(atPath: junk.path, contents: Data((0..<(1024 * 256)).map { UInt8($0 & 0xff) }))
print("3. analyze(non-disc) — expecting progress events then a thrown error:")
do {
    let summary = try engine.analyze(path: junk.path, listener: PrintListener(), cancel: nil)
    print("   returned (unexpected for junk): \(summary.sha256)")
} catch let PrismError.Failed(message) {
    print("   threw .Failed as expected: \(message.prefix(120))")
} catch {
    print("   threw:", error)
}

// 4. New library reads round-trip (empty data dir → [] and nil).
let recent = try engine.recentBuilds(limit: 10)
print("4. recentBuilds(10) -> \(recent.count) entries")
// Well-formed but unknown (a malformed key like "deadbeef" throws instead).
let missing = try engine.loadBuild(sha256: String(repeating: "de", count: 32))
print("   loadBuild(unknown) -> \(missing == nil ? "nil" : "unexpected hit")")
if let first = recent.first, let loaded = try engine.loadBuild(sha256: first.sha256) {
    print("   loadBuild(\(first.sha256.prefix(8))) -> \(loaded.name), \(loaded.tree.count) root node(s), fromCache=\(loaded.fromCache)")
}

// 5. Asset metadata round-trip: find a recent build whose record carries assets
//    and confirm blob paths resolve into the local store.
for entry in recent {
    guard let loaded = try engine.loadBuild(sha256: entry.sha256), let assets = loaded.assets else { continue }
    let local = assets.filter { $0.blobPath != nil }
    print("5. assets(\(entry.sha256.prefix(8))) -> \(assets.count) recorded, \(local.count) blob(s) local")
    if let a = local.first {
        let exists = fm.fileExists(atPath: a.blobPath ?? "")
        print("   first local blob: \(a.kind) \(a.path) (\(a.size) bytes) -> exists=\(exists)")
    }
    break
}

print("probe done.")
